// src/controllers/aiChatController.js
'use strict';

const db = require('../config/db');
const { formatInTimeZone, zonedTimeToUtc } = require('date-fns-tz');

const TIME_ZONE = 'America/Bogota';

/**
 * Controlador de Chat con IA usando OpenAI
 * Conecta el chat flotante con el orquestador de citas
 */

// Funciones disponibles para OpenAI (Function Calling)
const AVAILABLE_FUNCTIONS = [
    {
        type: "function",
        function: {
            name: "listar_servicios",
            description: "Lista todos los servicios disponibles en la peluquería",
            parameters: {
                type: "object",
                properties: {},
                required: []
            }
        }
    },
    {
        type: "function",
        function: {
            name: "listar_estilistas",
            description: "Lista todos los estilistas disponibles en la peluquería",
            parameters: {
                type: "object",
                properties: {},
                required: []
            }
        }
    },
    {
        type: "function",
        function: {
            name: "obtener_servicios_estilista",
            description: "Obtiene los servicios que ofrece un estilista específico. USAR SIEMPRE cuando el cliente mencione un estilista pero NO especifique qué servicio quiere.",
            parameters: {
                type: "object",
                properties: {
                    estilista: {
                        type: "string",
                        description: "Nombre del estilista (ej: Carlos, María, Juan)"
                    }
                },
                required: ["estilista"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "verificar_disponibilidad",
            description: "Verifica si hay disponibilidad para un servicio con un estilista en una fecha y hora específica. REQUIERE que el servicio esté especificado.",
            parameters: {
                type: "object",
                properties: {
                    servicio: {
                        type: "string",
                        description: "Nombre del servicio (ej: corte, tinte, manicure). OBLIGATORIO."
                    },
                    estilista: {
                        type: "string",
                        description: "Nombre del estilista"
                    },
                    fecha: {
                        type: "string",
                        description: "Fecha: 'hoy', 'mañana' o YYYY-MM-DD"
                    },
                    hora: {
                        type: "string",
                        description: "Hora: '2pm', '14:00', '10 de la mañana'"
                    }
                },
                required: ["servicio"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "agendar_cita",
            description: "Agenda una cita. Solo usar cuando tengas servicio, estilista, fecha y hora confirmados.",
            parameters: {
                type: "object",
                properties: {
                    servicio: {
                        type: "string",
                        description: "Nombre del servicio"
                    },
                    estilista: {
                        type: "string",
                        description: "Nombre del estilista"
                    },
                    fecha: {
                        type: "string",
                        description: "Fecha: 'hoy', 'mañana' o YYYY-MM-DD"
                    },
                    hora: {
                        type: "string",
                        description: "Hora en formato HH:MM"
                    }
                },
                required: ["servicio", "fecha", "hora"]
            }
        }
    }
];

// Sistema prompt para el asistente
const SYSTEM_PROMPT = `Eres un asistente virtual amigable de una peluquería. Tu trabajo es ayudar a los clientes a agendar citas.

BIENVENIDA:
- Si el cliente SOLO saluda (ejemplo: "hola", "buenos días") → Responde con bienvenida amigable y pregunta en qué puedes ayudar.
- Si el saludo incluye una solicitud → NO des bienvenida, procesa la solicitud directamente.

FLUJO DE CONVERSACIÓN PARA AGENDAR:
1. Si el cliente menciona estilista + servicio + fecha + hora → verifica disponibilidad.
2. Si menciona ESTILISTA pero NO servicio:
   - Si el servicio se mencionó en un mensaje anterior reciente o está implícito en el contexto, ASUME ese servicio y verifica disponibilidad.
   - Si NO hay contexto de servicio, usa obtener_servicios_estilista.
3. Si menciona SERVICIO pero NO estilista → verifica disponibilidad y sugiere opciones.
4. Para AGENDAR (agendar_cita), necesitas CONFIRMAR: servicio, fecha y hora.
   - El Estilista es opcional (si no elige, el sistema asigna uno).
   - SIEMPRE pide confirmación final explícita ("¿Confirmo tu cita...?").

⚠️ REGLAS CRÍTICAS:
- NUNCA inventes servicios. Solo los que devuelve listar_servicios.
- Si el cliente confirma un estilista (ej: "Sí, con Sofía"), ASUME el servicio del contexto anterior. NO vuelvas a preguntar "¿qué servicio?" si ya se sabe.
- Si verificar_disponibilidad devuelve slots, SUGIERE uno específico: "¿Te queda bien a las 3pm?"

ESTILO:
- Español colombiano amigable.
- Respuestas cortas.
- Usa emojis moderados.`;


// ==================== HELPERS ====================

/**
 * Obtener la API Key de OpenAI del tenant
 */
async function getOpenAIKey(tenantId) {
    const result = await db.query(
        'SELECT openai_api_key FROM tenants WHERE id = $1',
        [tenantId]
    );
    if (result.rows.length === 0 || !result.rows[0].openai_api_key) {
        return null;
    }
    return result.rows[0].openai_api_key;
}

/**
 * Normaliza fecha: 'hoy', 'mañana' -> YYYY-MM-DD
 */
function normalizeDateKeyword(dateStr) {
    if (!dateStr) return formatInTimeZone(new Date(), TIME_ZONE, 'yyyy-MM-dd');
    const s = String(dateStr).toLowerCase();
    const now = new Date();
    const today = formatInTimeZone(now, TIME_ZONE, 'yyyy-MM-dd');
    const tomorrow = formatInTimeZone(new Date(now.getTime() + 24 * 60 * 60 * 1000), TIME_ZONE, 'yyyy-MM-dd');
    if (s.includes('mañana')) return tomorrow;
    if (s.includes('hoy')) return today;
    // Si ya es YYYY-MM-DD, devolverlo
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
    return today; // Default: hoy
}

/**
 * Normaliza hora: '3pm', '15:00', '10 de la mañana' -> HH:MM
 */
function normalizeHumanTimeToHHMM(t) {
    if (!t) return null;

    let s = String(t).toLowerCase().replace(/\s+/g, '').replace(/dela|de|la/g, '');

    // Patrón: número + opcional(:minutos) + opcional(am/pm/mañana/tarde/noche)
    const m = s.match(/^(\d{1,2})(?::?(\d{2}))?(am|pm|mañana|tarde|noche)?$/);
    if (!m) {
        // Formato básico HH:MM
        const basic = s.match(/^(\d{1,2}):?(\d{2})$/);
        if (basic) {
            return `${String(basic[1]).padStart(2, '0')}:${basic[2]}`;
        }
        return null; // Antes era '10:00', ahora es null para obligar a preguntar
    }

    let h = parseInt(m[1], 10);
    let mm = m[2] ? parseInt(m[2], 10) : 0;
    const ampm = m[3];

    // HEURÍSTICA: Si el usuario dice "1" a "6" sin especificar AM/PM, asumir PM.
    // (Contexto: peluquería no agendada citas de 1am a 6am).
    if (!ampm && h >= 1 && h <= 6) {
        h += 12;
    }

    // Convertir 12h a 24h explícito
    if ((ampm === 'pm' || ampm === 'tarde' || ampm === 'noche') && h < 12) {
        h += 12;
    }
    if ((ampm === 'am' || ampm === 'mañana') && h === 12) {
        h = 0;
    }

    return `${String(Math.min(23, h)).padStart(2, '0')}:${String(Math.min(59, mm)).padStart(2, '0')}`;
}

/**
 * Construye fecha UTC desde fecha local
 */
function makeLocalUtc(dateStr, timeStr) {
    const t = (timeStr && timeStr.length === 5) ? `${timeStr}:00` : (timeStr || '00:00:00');
    return zonedTimeToUtc(`${dateStr} ${t}`, TIME_ZONE);
}

// ==================== EJECUTAR FUNCIONES ====================

async function executeFunction(functionName, args, tenantId, clientId) {
    console.log(`🔧 [AI Chat] Ejecutando función: ${functionName}`);
    console.log(`   Args:`, args);

    try {
        switch (functionName) {
            case 'listar_servicios': {
                const result = await db.query(
                    `SELECT id, name, duration_minutes, price 
                     FROM services 
                     WHERE tenant_id = $1 
                     ORDER BY name`,
                    [tenantId]
                );

                const servicios = result.rows.map(s => ({
                    nombre: s.name,
                    duracion: `${s.duration_minutes} min`,
                    precio: s.price ? `$${Number(s.price).toLocaleString('es-CO')}` : null
                }));

                return {
                    success: true,
                    data: servicios,
                    message: `Tenemos ${result.rows.length} servicios disponibles:\n${servicios.map(s => `• ${s.nombre} (${s.duracion})`).join('\n')}`
                };
            }

            case 'listar_estilistas': {
                const result = await db.query(
                    `SELECT id, first_name, last_name 
                     FROM users 
                     WHERE tenant_id = $1 AND role_id = 3 AND COALESCE(NULLIF(status,''),'active') = 'active'
                     ORDER BY first_name`,
                    [tenantId]
                );

                const estilistas = result.rows.map(u => `${u.first_name} ${u.last_name || ''}`.trim());

                return {
                    success: true,
                    data: estilistas,
                    message: `Nuestros estilistas son:\n${estilistas.map(e => `• ${e}`).join('\n')}`
                };
            }

            case 'obtener_servicios_estilista': {
                // Buscar el estilista por nombre
                const stylistResult = await db.query(
                    `SELECT id, first_name, last_name 
                     FROM users 
                     WHERE tenant_id = $1 
                       AND role_id = 3 
                       AND COALESCE(NULLIF(status,''),'active') = 'active'
                       AND (LOWER(first_name) LIKE $2 OR LOWER(last_name) LIKE $2 OR LOWER(CONCAT(first_name, ' ', last_name)) LIKE $2)
                     LIMIT 1`,
                    [tenantId, `%${(args.estilista || '').toLowerCase()}%`]
                );

                if (stylistResult.rows.length === 0) {
                    return {
                        success: false,
                        message: `No encontré un estilista llamado "${args.estilista}". ¿Quieres ver la lista de estilistas disponibles?`
                    };
                }

                const estilista = stylistResult.rows[0];
                const nombreEstilista = `${estilista.first_name} ${estilista.last_name || ''}`.trim();

                // Obtener los servicios que ofrece
                const servicesResult = await db.query(
                    `SELECT s.id, s.name, s.duration_minutes, s.price
                     FROM services s
                     INNER JOIN stylist_services ss ON s.id = ss.service_id
                     WHERE ss.user_id = $1
                     ORDER BY s.name`,
                    [estilista.id]
                );

                if (servicesResult.rows.length === 0) {
                    return {
                        success: true,
                        estilista: nombreEstilista,
                        servicios: [],
                        message: `${nombreEstilista} no tiene servicios configurados aún.`
                    };
                }

                const servicios = servicesResult.rows.map(s => s.name);

                return {
                    success: true,
                    estilista: nombreEstilista,
                    estilista_id: estilista.id,
                    servicios: servicios,
                    message: `${nombreEstilista} ofrece:\n${servicios.map(s => `• ${s}`).join('\n')}\n\n¿Cuál servicio te gustaría?`
                };
            }

            case 'verificar_disponibilidad': {
                // Normalizar fecha y hora
                const fecha = normalizeDateKeyword(args.fecha);
                const hora = args.hora ? normalizeHumanTimeToHHMM(args.hora) : null;

                console.log('🔍 [verificar_disponibilidad] Args recibidos:', {
                    servicio: args.servicio,
                    estilista: args.estilista,
                    fecha: args.fecha,
                    hora: args.hora,
                    fechaNormalizada: fecha,
                    horaNormalizada: hora
                });

                // Buscar servicio
                const svcResult = await db.query(
                    `SELECT id, name, duration_minutes FROM services 
                     WHERE tenant_id = $1 AND LOWER(name) LIKE $2
                     ORDER BY name LIMIT 5`,
                    [tenantId, `%${(args.servicio || '').toLowerCase()}%`]
                );

                console.log('📋 Servicios encontrados:', svcResult.rows.map(s => s.name));

                if (svcResult.rows.length === 0) {
                    return {
                        success: false,
                        message: `No encontré un servicio llamado "${args.servicio}". ¿Quieres ver la lista de servicios disponibles?`
                    };
                }

                const servicio = svcResult.rows[0];
                console.log('✅ Servicio seleccionado:', servicio.name, 'ID:', servicio.id);

                // Buscar estilistas disponibles
                let stylistCondition = '';
                let queryParams = [tenantId, servicio.id];

                if (args.estilista) {
                    stylistCondition = `AND (LOWER(u.first_name) LIKE $3 OR LOWER(u.last_name) LIKE $3 OR LOWER(CONCAT(u.first_name, ' ', u.last_name)) LIKE $3)`;
                    queryParams.push(`%${args.estilista.toLowerCase()}%`);
                    console.log('👤 Buscando estilista:', args.estilista);
                }

                const stylistsResult = await db.query(
                    `SELECT DISTINCT u.id, u.first_name, u.last_name, u.working_hours
                     FROM users u
                     INNER JOIN stylist_services ss ON u.id = ss.user_id
                     WHERE u.tenant_id = $1 
                       AND ss.service_id = $2
                       AND u.role_id = 3 
                       AND COALESCE(NULLIF(u.status,''),'active') = 'active'
                       ${stylistCondition}
                     ORDER BY u.first_name
                     LIMIT 5`,
                    queryParams
                );

                console.log('👥 Estilistas encontrados para este servicio:', stylistsResult.rows.map(s => `${s.first_name} ${s.last_name}`));

                if (stylistsResult.rows.length === 0) {
                    if (args.estilista) {
                        // Verificar si el estilista existe
                        const checkStylist = await db.query(
                            `SELECT first_name, last_name FROM users 
                             WHERE tenant_id = $1 AND role_id = 3 
                             AND (LOWER(first_name) LIKE $2 OR LOWER(last_name) LIKE $2 OR LOWER(CONCAT(first_name, ' ', last_name)) LIKE $2)
                             LIMIT 1`,
                            [tenantId, `%${args.estilista.toLowerCase()}%`]
                        );

                        if (checkStylist.rows.length > 0) {
                            const styName = `${checkStylist.rows[0].first_name} ${checkStylist.rows[0].last_name}`.trim();
                            console.log(`⚠️ ${styName} existe pero NO ofrece ${servicio.name}`);

                            // Listar los servicios que SÍ ofrece este estilista
                            const stylistServicesResult = await db.query(
                                `SELECT s.name FROM services s
                                 INNER JOIN stylist_services ss ON s.id = ss.service_id
                                 INNER JOIN users u ON u.id = ss.user_id
                                 WHERE u.tenant_id = $1 
                                 AND (LOWER(u.first_name) LIKE $2 OR LOWER(u.last_name) LIKE $2 OR LOWER(CONCAT(u.first_name, ' ', u.last_name)) LIKE $2)
                                 ORDER BY s.name`,
                                [tenantId, `%${args.estilista.toLowerCase()}%`]
                            );

                            const serviciosEstilista = stylistServicesResult.rows.map(s => s.name);
                            console.log(`📋 Servicios de ${styName}:`, serviciosEstilista);

                            return {
                                success: false,
                                estilista: styName,
                                servicios_disponibles: serviciosEstilista,
                                message: `${styName} no ofrece "${servicio.name}". ${styName} ofrece:\n${serviciosEstilista.map(s => `• ${s}`).join('\n')}\n\n¿Cuál de estos te gustaría?`
                            };
                        }

                        return {
                            success: false,
                            message: `${args.estilista} no ofrece el servicio "${servicio.name}". ¿Quieres que busque otro estilista que sí lo ofrezca?`
                        };
                    }
                    return {
                        success: false,
                        message: `No hay estilistas que ofrezcan "${servicio.name}".`
                    };
                }

                // Generar slots disponibles (simplificado)
                const estilista = stylistsResult.rows[0];
                const nombreEstilista = `${estilista.first_name} ${estilista.last_name || ''}`.trim();

                // Si tenemos hora específica, verificar disponibilidad
                if (hora) {
                    const startTime = makeLocalUtc(fecha, hora);
                    const endTime = new Date(startTime.getTime() + (servicio.duration_minutes || 60) * 60000);

                    // NUEVO: Verificar que la hora no sea pasada (para citas de hoy)
                    const now = new Date();
                    if (startTime < now) {
                        // Calcular próximo horario disponible
                        const nextHour = new Date(now.getTime() + 30 * 60000); // 30 min desde ahora
                        const nextHourStr = formatInTimeZone(nextHour, TIME_ZONE, 'HH:mm');
                        return {
                            success: false,
                            message: `⏰ Ese horario (${hora}) ya pasó. Ahora son las ${formatInTimeZone(now, TIME_ZONE, 'HH:mm')}. ¿Te gustaría agendar para las ${nextHourStr} o para mañana?`
                        };
                    }

                    // NUEVO: Verificar horario de trabajo del estilista
                    if (estilista.working_hours) {
                        try {
                            const workingHours = typeof estilista.working_hours === 'string'
                                ? JSON.parse(estilista.working_hours)
                                : estilista.working_hours;

                            // CORRECCIÓN ZONA HORARIA: Usar el día en Bogota, no el del sistema (UTC)
                            // 'i' devuelve 1 (Lunes) a 7 (Domingo). Convertimos a 0=Domingo, 1=Lunes...
                            const isoDay = parseInt(formatInTimeZone(startTime, TIME_ZONE, 'i'), 10);
                            const dayOfWeek = isoDay === 7 ? 0 : isoDay;

                            const dayNames = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
                            const dayKey = dayNames[dayOfWeek];
                            const horaNum = parseInt(hora.split(':')[0], 10);

                            if (workingHours[dayKey]) {
                                const { start, end } = workingHours[dayKey];
                                const startWork = parseInt(start, 10);
                                const endWork = parseInt(end, 10);

                                if (horaNum < startWork || horaNum >= endWork) {
                                    return {
                                        success: false,
                                        available: false,
                                        servicio: servicio.name,
                                        estilista: nombreEstilista,
                                        message: `❌ ${nombreEstilista} no trabaja a las ${hora}. Su horario es de ${start}:00 a ${end}:00. ¿Quieres buscar otro estilista o cambiar la hora?`
                                    };
                                }
                            }
                        } catch (e) {
                            console.warn('⚠️ Error parseando working_hours:', e.message);
                        }
                    }

                    // Ver si hay conflicto con otras citas
                    const conflictResult = await db.query(
                        `SELECT id FROM appointments 
                         WHERE tenant_id = $1 AND stylist_id = $2
                           AND status IN ('scheduled', 'rescheduled', 'checked_in')
                           AND (start_time, end_time) OVERLAPS ($3::timestamptz, $4::timestamptz)
                         LIMIT 1`,
                        [tenantId, estilista.id, startTime, endTime]
                    );

                    if (conflictResult.rows.length > 0) {
                        // Buscar horarios cercanos disponibles
                        return {
                            success: true,
                            available: false,
                            servicio: servicio.name,
                            estilista: nombreEstilista,
                            fecha,
                            hora,
                            message: `❌ ${nombreEstilista} ya tiene una cita a las ${hora} el ${fecha}. ¿Quieres que busque horarios alternativos o te sugiero otro estilista?`
                        };
                    }

                    return {
                        success: true,
                        available: true,
                        servicio: servicio.name,
                        estilista: nombreEstilista,
                        fecha,
                        hora,
                        duracion: servicio.duration_minutes,
                        message: `✅ ¡Hay disponibilidad! ${nombreEstilista} puede atenderte el ${fecha} a las ${hora} para ${servicio.name} (${servicio.duration_minutes} min). ¿Quieres que agende la cita?`
                    };
                }

                // Si hay hora pero no estilista específico, filtrar por disponibilidad a esa hora
                if (hora && !args.estilista) {
                    const startTime = makeLocalUtc(fecha, hora);
                    const endTime = new Date(startTime.getTime() + (servicio.duration_minutes || 60) * 60000);

                    // Verificar que la hora no sea pasada (para citas de hoy)
                    const now = new Date();
                    if (startTime < now) {
                        return {
                            success: false,
                            message: `⏰ Ese horario (${hora}) ya pasó. ¿Te gustaría agendar para más tarde hoy o para mañana?`
                        };
                    }

                    // Buscar estilistas SIN conflicto a esa hora Y que trabajen a esa hora
                    const availableStylists = [];
                    // CORRECCIÓN ZONA HORARIA
                    const isoDay = parseInt(formatInTimeZone(startTime, TIME_ZONE, 'i'), 10);
                    const dayOfWeek = isoDay === 7 ? 0 : isoDay;

                    const dayNames = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
                    const dayKey = dayNames[dayOfWeek];
                    const horaNum = parseInt(hora.split(':')[0], 10);

                    for (const stylist of stylistsResult.rows) {
                        // Verificar horario de trabajo
                        if (stylist.working_hours) {
                            try {
                                const workingHours = typeof stylist.working_hours === 'string'
                                    ? JSON.parse(stylist.working_hours)
                                    : stylist.working_hours;

                                if (workingHours[dayKey]) {
                                    const { start, end } = workingHours[dayKey];
                                    const startWork = parseInt(start, 10);
                                    const endWork = parseInt(end, 10);

                                    // Si no trabaja a esa hora, saltar
                                    if (horaNum < startWork || horaNum >= endWork) {
                                        console.log(`   ⏰ ${stylist.first_name} no trabaja a las ${hora} (horario: ${start}-${end})`);
                                        continue;
                                    }
                                }
                            } catch (e) {
                                console.warn('⚠️ Error parseando working_hours:', e.message);
                            }
                        }

                        // Verificar conflicto de citas
                        const conflictResult = await db.query(
                            `SELECT id FROM appointments 
                             WHERE tenant_id = $1 AND stylist_id = $2
                               AND status IN ('scheduled', 'rescheduled', 'checked_in')
                               AND (start_time, end_time) OVERLAPS ($3::timestamptz, $4::timestamptz)
                             LIMIT 1`,
                            [tenantId, stylist.id, startTime, endTime]
                        );

                        if (conflictResult.rows.length === 0) {
                            availableStylists.push({
                                id: stylist.id,
                                name: `${stylist.first_name} ${stylist.last_name || ''}`.trim()
                            });
                        }
                    }

                    if (availableStylists.length === 0) {
                        return {
                            success: true,
                            available: false,
                            servicio: servicio.name,
                            fecha,
                            hora,
                            message: `❌ No hay estilistas disponibles para ${servicio.name} a las ${hora} el ${fecha}. ¿Quieres que busque horarios alternativos?`
                        };
                    }

                    if (availableStylists.length === 1) {
                        return {
                            success: true,
                            available: true,
                            servicio: servicio.name,
                            estilista: availableStylists[0].name,
                            fecha,
                            hora,
                            duracion: servicio.duration_minutes,
                            message: `✅ A las ${hora} está disponible ${availableStylists[0].name} para ${servicio.name}. ¿Quieres que agende la cita?`
                        };
                    }

                    const nombresDisponibles = availableStylists.map(s => s.name).join(', ');
                    return {
                        success: true,
                        available: true,
                        servicio: servicio.name,
                        fecha,
                        hora,
                        estilistas_disponibles: nombresDisponibles,
                        message: `✅ A las ${hora} el ${fecha} para ${servicio.name} están disponibles: ${nombresDisponibles}. ¿Con cuál te gustaría agendar?`
                    };
                }

                // Sin hora específica, mostrar estilistas disponibles
                const nombresEstilistas = stylistsResult.rows
                    .map(u => `${u.first_name} ${u.last_name || ''}`.trim())
                    .join(', ');

                return {
                    success: true,
                    servicio: servicio.name,
                    fecha,
                    estilistas_disponibles: nombresEstilistas,
                    message: `Para "${servicio.name}" el ${fecha} están disponibles: ${nombresEstilistas}. ¿A qué hora te gustaría agendar?`
                };
            }

            case 'agendar_cita': {
                if (!clientId) {
                    return {
                        success: false,
                        message: 'Para agendar necesito que inicies sesión primero. Por ahora puedo mostrarte la disponibilidad.'
                    };
                }

                const fecha = normalizeDateKeyword(args.fecha);
                const hora = normalizeHumanTimeToHHMM(args.hora);

                if (!hora) {
                    return {
                        success: false,
                        message: '¿A qué hora te gustaría agendar la cita?'
                    };
                }

                // Buscar servicio
                const svcResult = await db.query(
                    `SELECT id, name, duration_minutes FROM services 
                     WHERE tenant_id = $1 AND LOWER(name) LIKE $2
                     LIMIT 1`,
                    [tenantId, `%${(args.servicio || '').toLowerCase()}%`]
                );

                if (svcResult.rows.length === 0) {
                    return { success: false, message: `No encontré el servicio "${args.servicio}".` };
                }

                const servicio = svcResult.rows[0];

                // Buscar estilista
                let stylistQuery = `
                    SELECT u.id, u.first_name, u.last_name
                    FROM users u
                    INNER JOIN stylist_services ss ON u.id = ss.user_id
                    WHERE u.tenant_id = $1 
                      AND ss.service_id = $2
                      AND u.role_id = 3 
                      AND COALESCE(NULLIF(u.status,''),'active') = 'active'
                `;
                let queryParams = [tenantId, servicio.id];

                if (args.estilista) {
                    stylistQuery += ` AND (LOWER(u.first_name) LIKE $3 OR LOWER(u.last_name) LIKE $3)`;
                    queryParams.push(`%${args.estilista.toLowerCase()}%`);
                }

                stylistQuery += ` LIMIT 1`;

                const stylistResult = await db.query(stylistQuery, queryParams);

                if (stylistResult.rows.length === 0) {
                    return {
                        success: false,
                        message: args.estilista
                            ? `${args.estilista} no ofrece "${servicio.name}".`
                            : `No hay estilistas disponibles para "${servicio.name}".`
                    };
                }

                const estilista = stylistResult.rows[0];
                const nombreEstilista = `${estilista.first_name} ${estilista.last_name || ''}`.trim();

                // Crear la cita
                const startTime = makeLocalUtc(fecha, hora);
                const duration = servicio.duration_minutes || 60;
                const endTime = new Date(startTime.getTime() + duration * 60000);

                // Verificar conflicto
                const conflictResult = await db.query(
                    `SELECT id FROM appointments 
                     WHERE tenant_id = $1 AND stylist_id = $2
                       AND status IN ('scheduled', 'rescheduled', 'checked_in')
                       AND (start_time, end_time) OVERLAPS ($3::timestamptz, $4::timestamptz)
                     LIMIT 1`,
                    [tenantId, estilista.id, startTime, endTime]
                );

                if (conflictResult.rows.length > 0) {
                    return {
                        success: false,
                        message: `❌ Ese horario ya está ocupado. ¿Quieres que busque otra hora disponible?`
                    };
                }

                // Crear cita
                const result = await db.query(
                    `INSERT INTO appointments (tenant_id, client_id, stylist_id, service_id, start_time, end_time, status)
                     VALUES ($1, $2, $3, $4, $5, $6, 'scheduled')
                     RETURNING *`,
                    [tenantId, clientId, estilista.id, servicio.id, startTime, endTime]
                );

                const appointment = result.rows[0];

                return {
                    success: true,
                    appointment_id: appointment.id,
                    message: `🎉 ¡Listo! Tu cita ha sido agendada:\n\n📅 Fecha: ${fecha}\n⏰ Hora: ${hora}\n💇 Servicio: ${servicio.name}\n👤 Con: ${nombreEstilista}\n⏱️ Duración: ${duration} minutos\n\n¡Te esperamos!`
                };
            }

            default:
                return { success: false, message: 'Función no reconocida' };
        }
    } catch (error) {
        console.error(`❌ [AI Chat] Error ejecutando ${functionName}:`, error);
        return { success: false, message: 'Ocurrió un error. Por favor intenta de nuevo.' };
    }
}

// ==================== ENDPOINT PRINCIPAL ====================

/**
 * POST /api/ai-chat
 */
exports.chat = async (req, res) => {
    try {
        const { message, conversationHistory = [] } = req.body;
        const tenantId = req.user?.tenant_id || req.body.tenantId;
        const clientId = req.user?.id || req.body.clientId || null;

        if (!tenantId) {
            return res.status(400).json({ error: 'Falta tenantId' });
        }

        if (!message) {
            return res.status(400).json({ error: 'Falta el mensaje' });
        }

        // Obtener API Key del tenant
        const apiKey = await getOpenAIKey(tenantId);
        if (!apiKey) {
            return res.status(400).json({
                error: 'No hay API Key de OpenAI configurada. Ve a Configuración → Configura tu bot.'
            });
        }

        console.log(`\n💬 [AI Chat] Mensaje: "${message}"`);

        // 🔄 REINICIO DE CONVERSACIÓN: Limpiar historial solo si es un saludo simple o comando explícito
        const simpleGreetings = /^(hola|buenos días|buenas tardes|buenas noches|hi|hey|hello)[\s!.]*$/i;
        const resetCommands = /(empezar de nuevo|cancelar|se me olvid[oó]|reset|reiniciar)/i;

        const isSimpleGreeting = simpleGreetings.test(message.trim());
        const isResetCommand = resetCommands.test(message.trim());

        if ((isSimpleGreeting || isResetCommand) && conversationHistory.length > 0) {
            console.log(`🔄 [REINICIO] Limpiando historial de conversación`);
            conversationHistory = [];
        }

        // Construir mensajes para OpenAI
        const messages = [
            { role: 'system', content: SYSTEM_PROMPT },
            ...conversationHistory.slice(-10),
            { role: 'user', content: message }
        ];

        // Llamar a OpenAI
        const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages,
                tools: AVAILABLE_FUNCTIONS,
                tool_choice: 'auto',
                temperature: 0.7,
                max_tokens: 500
            })
        });

        if (!openaiResponse.ok) {
            const errorData = await openaiResponse.json();
            console.error('❌ [AI Chat] Error de OpenAI:', errorData);
            return res.status(500).json({
                error: 'Error al comunicarse con OpenAI',
                details: errorData.error?.message
            });
        }

        const openaiData = await openaiResponse.json();
        const choice = openaiData.choices[0];
        const assistantMessage = choice.message;

        // Si OpenAI quiere ejecutar una función
        if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
            const toolCall = assistantMessage.tool_calls[0];
            const functionName = toolCall.function.name;
            const functionArgs = JSON.parse(toolCall.function.arguments || '{}');

            console.log(`🔧 [AI Chat] Ejecutando: ${functionName}`);

            // Ejecutar la función
            const functionResult = await executeFunction(functionName, functionArgs, tenantId, clientId);

            // Enviar el resultado de vuelta a OpenAI
            const followUpMessages = [
                ...messages,
                assistantMessage,
                {
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    content: JSON.stringify(functionResult)
                }
            ];

            const finalResponse = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    model: 'gpt-4o-mini',
                    messages: followUpMessages,
                    temperature: 0.7,
                    max_tokens: 500
                })
            });

            if (!finalResponse.ok) {
                return res.json({
                    response: functionResult.message || 'Operación completada.',
                    functionExecuted: functionName
                });
            }

            const finalData = await finalResponse.json();
            const finalMessage = finalData.choices[0].message.content;

            console.log(`✅ [AI Chat] Respuesta enviada`);

            return res.json({
                response: finalMessage,
                functionExecuted: functionName
            });
        }

        // Si no hay function call, devolver la respuesta directa
        console.log(`✅ [AI Chat] Respuesta directa`);

        return res.json({
            response: assistantMessage.content,
            functionExecuted: null
        });

    } catch (error) {
        console.error('❌ [AI Chat] Error:', error);
        return res.status(500).json({
            error: 'Error interno del servidor',
            details: error.message
        });
    }
};

/**
 * GET /api/ai-chat/health
 */
exports.health = async (req, res) => {
    const tenantId = req.query.tenantId;

    if (!tenantId) {
        return res.json({ status: 'ok', hasApiKey: false });
    }

    try {
        const apiKey = await getOpenAIKey(tenantId);
        return res.json({
            status: 'ok',
            hasApiKey: !!apiKey
        });
    } catch (error) {
        return res.status(500).json({ status: 'error', message: error.message });
    }
};
