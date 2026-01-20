// src/controllers/whatsappBookingController.js
'use strict';

const db = require('../config/db');
const { formatInTimeZone } = require('date-fns-tz');
const {
    TIME_ZONE,
    BLOCKING_STATUSES,
    UUID_RE,
    clean,
    makeLocalUtc,
    toLocalHHmm,
} = require('../utils/appointmentHelpers');

const {
    getStylistEffectiveDuration,
    getAvailableSlotsForStylist,
    createAppointmentRecord,
} = require('../services/appointmentService');

console.log('🤖 [WHATSAPP BOOKING] Controlador v3.0 - MANEJA FECHA FALTANTE');

/* =================================================================== */
/* ==================  PASO 1: BUSCAR SERVICIO  ====================== */
/* =================================================================== */

exports.searchService = async (req, res) => {
    try {
        const { tenantId, service } = req.body;

        if (!tenantId || !UUID_RE.test(tenantId)) {
            return res.status(400).json({ error: 'tenantId inválido (UUID requerido)' });
        }

        if (!service) {
            return res.status(400).json({ error: 'service requerido' });
        }

        // 🆕 Limpiar el nombre: remover palabras comunes como "de", "el", "la", "un", "una", "para"
        const stopWords = ['de', 'del', 'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'para', 'con', 'y', 'o'];
        const serviceClean = clean(service).toLowerCase();
        const serviceWords = serviceClean.split(/\s+/).filter(word => !stopWords.includes(word));
        const serviceName = serviceWords.join(' '); // "corte de caballero" → "corte caballero"
        
        console.log(`\n🔍 [SEARCH SERVICE] Buscando: "${service}"`);
        console.log(`   Limpio: "${serviceName}" (palabras: ${serviceWords.join(', ')})`);

        // Buscar primero con el nombre limpio
        let result = await db.query(
            `SELECT id, name, duration_minutes
             FROM services
             WHERE tenant_id = $1
               AND LOWER(name) LIKE $2
             ORDER BY 
               CASE 
                 WHEN LOWER(name) = $3 THEN 1
                 WHEN LOWER(name) LIKE $3 || '%' THEN 2
                 ELSE 3
               END,
               name ASC
             LIMIT 5`,
            [tenantId, `%${serviceName}%`, serviceName]
        );

        // Si no hay resultados, buscar con cada palabra individualmente
        if (result.rows.length === 0 && serviceWords.length > 0) {
            console.log(`   🔄 Buscando con palabras individuales...`);
            
            // Construir condición OR para cada palabra
            const wordConditions = serviceWords.map((_, i) => `LOWER(name) LIKE $${i + 2}`).join(' AND ');
            const wordPatterns = serviceWords.map(w => `%${w}%`);
            
            result = await db.query(
                `SELECT id, name, duration_minutes
                 FROM services
                 WHERE tenant_id = $1 AND (${wordConditions})
                 ORDER BY name ASC
                 LIMIT 5`,
                [tenantId, ...wordPatterns]
            );
        }

        if (result.rows.length === 0) {
            console.log(`   ❌ No se encontró servicio`);
            
            // Buscar servicios similares para sugerir
            const suggestions = await db.query(
                `SELECT name FROM services WHERE tenant_id = $1 ORDER BY name LIMIT 10`,
                [tenantId]
            );
            const suggestionNames = suggestions.rows.map(s => s.name);
            
            return res.status(200).json({
                found: false,
                message: `No encontré un servicio llamado "${service}". ¿Puedes intentar con otro nombre?`,
                suggestions: suggestionNames
            });
        }

        if (result.rows.length > 1) {
            const exactMatch = result.rows.find(s => s.name.toLowerCase() === serviceName);

            if (exactMatch) {
                console.log(`   ✅ Match exacto: ${exactMatch.name}`);
                const stylists = await getAvailableStylists(tenantId, exactMatch.id);

                return res.status(200).json({
                    found: true,
                    service: {
                        id: exactMatch.id,
                        name: exactMatch.name,
                        duration_minutes: Number(exactMatch.duration_minutes) || 60
                    },
                    stylists,
                    message: `Estos estilistas ofrecen ${exactMatch.name}:`
                });
            }

            console.log(`   ⚠️ Múltiples coincidencias: ${result.rows.length}`);
            return res.status(200).json({
                found: false,
                multiple: true,
                options: result.rows.map(s => ({
                    id: s.id,
                    name: s.name,
                    duration_minutes: Number(s.duration_minutes) || 60
                })),
                message: `Encontré varios servicios. ¿Cuál prefieres?`
            });
        }

        const serviceData = result.rows[0];
        console.log(`   ✅ Servicio encontrado: ${serviceData.name}`);

        const stylists = await getAvailableStylists(tenantId, serviceData.id);

        if (stylists.length === 0) {
            return res.status(200).json({
                found: true,
                service: {
                    id: serviceData.id,
                    name: serviceData.name,
                    duration_minutes: Number(serviceData.duration_minutes) || 60
                },
                stylists: [],
                message: `El servicio "${serviceData.name}" existe, pero no hay estilistas que lo ofrezcan actualmente.`
            });
        }

        console.log(`   ✅ Estilistas encontrados: ${stylists.length}`);

        return res.status(200).json({
            found: true,
            service: {
                id: serviceData.id,
                name: serviceData.name,
                duration_minutes: Number(serviceData.duration_minutes) || 60
            },
            stylists,
            message: `Estos estilistas ofrecen ${serviceData.name}:`
        });

    } catch (error) {
        console.error('❌ [SEARCH SERVICE ERROR]:', error);
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
};

/* =================================================================== */
/* ==============  PASO 2: VER DISPONIBILIDAD  ======================= */
/* =================================================================== */

exports.checkAvailability = async (req, res) => {
    try {
        const { tenantId, serviceId, stylistId, stylistName, date, time } = req.body;

        console.log(`\n📅 [CHECK AVAILABILITY]`);
        console.log(`   Tenant: ${tenantId}`);
        console.log(`   ServiceId: ${serviceId}`);
        console.log(`   StylistId: ${stylistId || 'N/A'}`);
        console.log(`   StylistName: ${stylistName || 'N/A'}`);
        console.log(`   Date: ${date || 'N/A'}`);
        console.log(`   Time: ${time || 'N/A'}`);

        if (!tenantId || !UUID_RE.test(tenantId)) {
            return res.status(400).json({ error: 'tenantId inválido' });
        }

        if (!serviceId || !UUID_RE.test(serviceId)) {
            return res.status(400).json({ error: 'serviceId inválido' });
        }

        // ═══════════════════════════════════════════════════════════════
        // 🆕 MANEJO ESPECIAL: SI NO HAY FECHA, PEDIR FECHA (NO ES ERROR)
        // ═══════════════════════════════════════════════════════════════
        if (!date) {
            console.log(`   ⚠️ Falta fecha - pidiendo al usuario`);

            // Primero, resolver el estilista si viene por nombre
            let stylistInfo = null;
            if (stylistName) {
                const stylistResult = await db.query(
                    `SELECT u.id, u.first_name, u.last_name
                     FROM users u
                     INNER JOIN stylist_services ss ON u.id = ss.user_id
                     WHERE u.tenant_id = $1
                       AND u.role_id = 3
                       AND ss.service_id = $2
                       AND COALESCE(NULLIF(u.status, ''), 'active') = 'active'
                       AND (
                         LOWER(u.first_name) LIKE $3
                         OR LOWER(u.last_name) LIKE $3
                         OR LOWER(CONCAT(u.first_name, ' ', u.last_name)) LIKE $3
                       )
                     LIMIT 1`,
                    [tenantId, serviceId, `%${clean(stylistName).toLowerCase()}%`]
                );

                if (stylistResult.rows.length > 0) {
                    const row = stylistResult.rows[0];
                    stylistInfo = {
                        id: row.id,
                        name: `${row.first_name} ${row.last_name || ''}`.trim()
                    };
                    console.log(`   ✅ Estilista encontrado: ${stylistInfo.name}`);
                }
            }

            return res.status(200).json({
                available: false,
                needsDate: true,
                stylist: stylistInfo,
                message: stylistInfo
                    ? `¡Perfecto! ¿Para qué fecha quieres tu cita con ${stylistInfo.name}?`
                    : '¿Para qué fecha te gustaría agendar tu cita?'
            });
        }

        // Obtener info del servicio
        const serviceResult = await db.query(
            'SELECT id, name, duration_minutes FROM services WHERE id = $1 AND tenant_id = $2',
            [serviceId, tenantId]
        );

        if (serviceResult.rows.length === 0) {
            return res.status(404).json({ error: 'Servicio no encontrado' });
        }

        const service = serviceResult.rows[0];
        const serviceName = service.name;

        // ═══════════════════════════════════════════════════════════════
        // 🆕 RESOLVER ESTILISTA: Por ID o por Nombre
        // ═══════════════════════════════════════════════════════════════
        let finalStylistId = stylistId;
        let stylistInfo = null;

        if (!finalStylistId && stylistName) {
            console.log(`   🔍 Buscando estilista por nombre: "${stylistName}"`);

            const stylistResult = await db.query(
                `SELECT u.id, u.first_name, u.last_name, u.working_hours
                 FROM users u
                 INNER JOIN stylist_services ss ON u.id = ss.user_id
                 WHERE u.tenant_id = $1
                   AND u.role_id = 3
                   AND ss.service_id = $2
                   AND COALESCE(NULLIF(u.status, ''), 'active') = 'active'
                   AND (
                     LOWER(u.first_name) LIKE $3
                     OR LOWER(u.last_name) LIKE $3
                     OR LOWER(CONCAT(u.first_name, ' ', u.last_name)) LIKE $3
                   )
                 LIMIT 1`,
                [tenantId, serviceId, `%${clean(stylistName).toLowerCase()}%`]
            );

            if (stylistResult.rows.length === 0) {
                console.log(`   ⚠️ No se encontró estilista con nombre "${stylistName}"`);
                
                // Buscar todos los estilistas disponibles para sugerir
                const allStylists = await getAvailableStylists(tenantId, serviceId);
                const stylistNames = allStylists.map(s => s.name);
                
                console.log(`   💡 Estilistas disponibles: ${stylistNames.join(', ')}`);
                
                return res.status(200).json({
                    available: false,
                    error: `No encontré un estilista llamado "${stylistName}" que ofrezca ${serviceName}.`,
                    message: stylistNames.length > 0
                        ? `No encontré un estilista llamado "${stylistName}". Los estilistas disponibles son: ${stylistNames.join(', ')}. ¿Cuál prefieres?`
                        : `No encontré un estilista llamado "${stylistName}" que ofrezca ${serviceName}.`,
                    available_stylists: stylistNames
                });
            }

            finalStylistId = stylistResult.rows[0].id;
            stylistInfo = {
                id: finalStylistId,
                name: `${stylistResult.rows[0].first_name} ${stylistResult.rows[0].last_name || ''}`.trim()
            };
            console.log(`   ✅ Estilista encontrado: ${stylistInfo.name} (${finalStylistId})`);
        }

        // CASO A: Con estilista específico
        if (finalStylistId && UUID_RE.test(finalStylistId)) {
            console.log(`   👤 Con estilista específico: ${finalStylistId.substring(0, 8)}...`);

            const stylistResult = await db.query(
                `SELECT id, first_name, last_name, working_hours, status
                 FROM users
                 WHERE id = $1 AND tenant_id = $2 AND role_id = 3`,
                [finalStylistId, tenantId]
            );

            if (stylistResult.rows.length === 0) {
                return res.status(404).json({ error: 'Estilista no encontrado' });
            }

            const stylist = stylistResult.rows[0];
            if ((stylist.status || 'active') !== 'active') {
                return res.status(400).json({ error: 'El estilista no está activo' });
            }

            const stylistNameFull = `${stylist.first_name} ${stylist.last_name || ''}`.trim();

            const offersService = await db.query(
                'SELECT 1 FROM stylist_services WHERE user_id = $1 AND service_id = $2',
                [finalStylistId, serviceId]
            );

            if (offersService.rows.length === 0) {
                console.log(`   ❌ Estilista no ofrece este servicio`);
                return res.status(200).json({
                    available: false,
                    message: `${stylistNameFull} no ofrece el servicio "${serviceName}".`
                });
            }

            const { slots, duration } = await getAvailableSlotsForStylist(
                tenantId, finalStylistId, serviceId, date, 15
            );

            const filteredSlots = filterPastSlots(slots, date);

            if (filteredSlots.length === 0) {
                const isPastDay = slots.length > 0 && filteredSlots.length === 0;
                return res.status(200).json({
                    available: false,
                    stylist: { id: finalStylistId, name: stylistNameFull },
                    message: isPastDay
                        ? `Todos los horarios de hoy ya pasaron. ¿Qué tal mañana?`
                        : `${stylistNameFull} no tiene disponibilidad el ${date}. ¿Quieres probar otra fecha?`,
                    slots: []
                });
            }

            const availableSlots = filteredSlots.map(toLocalHHmm);

            if (time) {
                const isAvailable = availableSlots.includes(time.slice(0, 5));

                console.log(`   ${isAvailable ? '✅' : '❌'} Hora ${time}: ${isAvailable ? 'disponible' : 'NO disponible'}`);

                return res.status(200).json({
                    available: isAvailable,
                    stylist: { id: finalStylistId, name: stylistNameFull },
                    service: { id: serviceId, name: serviceName, duration_minutes: duration },
                    date,
                    time: time.slice(0, 5),
                    slots: isAvailable ? [time.slice(0, 5)] : availableSlots.slice(0, 10),
                    message: isAvailable
                        ? `${stylistNameFull} está disponible el ${date} a las ${time}.`
                        : `${stylistNameFull} NO está disponible a las ${time}. Horarios disponibles:`
                });
            }

            console.log(`   ✅ ${availableSlots.length} horarios disponibles`);

            return res.status(200).json({
                available: true,
                stylist: { id: finalStylistId, name: stylistNameFull },
                service: { id: serviceId, name: serviceName, duration_minutes: duration },
                date,
                slots: availableSlots.slice(0, 20),
                message: `${stylistNameFull} tiene disponibilidad el ${date}:`
            });
        }

        // CASO B: Sin estilista específico
        console.log(`   👥 Sin estilista específico - buscando todos los disponibles`);

        const allStylists = await getAvailableStylists(tenantId, serviceId);

        if (allStylists.length === 0) {
            return res.status(200).json({
                available: false,
                message: `No hay estilistas que ofrezcan "${serviceName}".`,
                stylists: []
            });
        }

        const stylistsWithSlots = [];

        for (const stylistItem of allStylists) {
            const { slots, duration } = await getAvailableSlotsForStylist(
                tenantId, stylistItem.id, serviceId, date, 15
            );

            const filteredSlots = filterPastSlots(slots, date);

            if (filteredSlots.length > 0) {
                const availableSlots = filteredSlots.map(toLocalHHmm);

                if (time) {
                    const isAvailableAtTime = availableSlots.includes(time.slice(0, 5));
                    if (isAvailableAtTime) {
                        stylistsWithSlots.push({
                            id: stylistItem.id,
                            name: stylistItem.name,
                            available_at_requested_time: true,
                            slots: [time.slice(0, 5)]
                        });
                    }
                } else {
                    stylistsWithSlots.push({
                        id: stylistItem.id,
                        name: stylistItem.name,
                        slots: availableSlots.slice(0, 10)
                    });
                }
            }
        }

        if (stylistsWithSlots.length === 0) {
            return res.status(200).json({
                available: false,
                message: time
                    ? `Ningún estilista está disponible el ${date} a las ${time}.`
                    : `Ningún estilista tiene disponibilidad el ${date}.`,
                stylists: []
            });
        }

        console.log(`   ✅ ${stylistsWithSlots.length} estilistas con disponibilidad`);

        return res.status(200).json({
            available: true,
            service: { id: serviceId, name: serviceName },
            date,
            time: time || null,
            stylists: stylistsWithSlots,
            message: time
                ? `Estos estilistas están disponibles el ${date} a las ${time}:`
                : `Estos estilistas tienen disponibilidad el ${date}:`
        });

    } catch (error) {
        console.error('❌ [CHECK AVAILABILITY ERROR]:', error);
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
};

/* =================================================================== */
/* =================  PASO 3: AGENDAR CITA  ========================== */
/* =================================================================== */

exports.bookAppointment = async (req, res) => {
    try {
        const { tenantId, clientId, serviceId, stylistId, stylistName, date, time } = req.body;

        console.log(`\n${'═'.repeat(70)}`);
        console.log(`📝 [BOOK APPOINTMENT] Iniciando proceso de reserva`);
        console.log(`${'═'.repeat(70)}`);
        console.log(`   Datos recibidos:`);
        console.log(`      tenantId: ${tenantId}`);
        console.log(`      clientId: ${clientId}`);
        console.log(`      serviceId: ${serviceId}`);
        console.log(`      stylistId: ${stylistId || '(no proporcionado)'}`);
        console.log(`      stylistName: ${stylistName || '(no proporcionado)'}`);
        console.log(`      date: ${date}`);
        console.log(`      time: ${time}`);

        if (!tenantId || !UUID_RE.test(tenantId)) {
            console.log(`   ❌ Error: tenantId inválido`);
            return res.status(400).json({ booked: false, error: 'tenantId inválido' });
        }

        if (!clientId || !UUID_RE.test(clientId)) {
            console.log(`   ❌ Error: clientId inválido - "${clientId}"`);
            return res.status(400).json({ booked: false, error: 'clientId inválido. No se pudo identificar al cliente.' });
        }

        if (!serviceId || !UUID_RE.test(serviceId)) {
            console.log(`   ❌ Error: serviceId inválido`);
            return res.status(400).json({ booked: false, error: 'serviceId inválido. Debes seleccionar un servicio primero.' });
        }

        if (!date || !time) {
            console.log(`   ❌ Error: date o time faltante`);
            return res.status(400).json({ booked: false, error: 'Debes indicar fecha y hora para la cita.' });
        }

        console.log(`   ✅ Validaciones básicas pasadas`);

        // 🆕 RESOLVER ESTILISTA: Por ID o por Nombre
        let finalStylistId = stylistId;

        console.log(`\n   🔍 [RESOLVER ESTILISTA]`);
        console.log(`      stylistId recibido: ${stylistId || 'ninguno'}`);
        console.log(`      stylistName recibido: ${stylistName || 'ninguno'}`);

        if (finalStylistId && UUID_RE.test(finalStylistId)) {
            console.log(`      ✅ Usando stylistId directo: ${finalStylistId}`);
        } else if (stylistName) {
            console.log(`      🔍 Buscando estilista por nombre: "${stylistName}"`);
            
            const searchPattern = `%${clean(stylistName).toLowerCase()}%`;
            console.log(`      Patrón de búsqueda: ${searchPattern}`);

            const stylistResult = await db.query(
                `SELECT u.id, u.first_name, u.last_name FROM users u
                 INNER JOIN stylist_services ss ON u.id = ss.user_id
                 WHERE u.tenant_id = $1 AND ss.service_id = $2
                   AND COALESCE(NULLIF(u.status, ''), 'active') = 'active'
                   AND (LOWER(u.first_name) LIKE $3 
                        OR LOWER(u.last_name) LIKE $3
                        OR LOWER(CONCAT(u.first_name, ' ', u.last_name)) LIKE $3)
                 LIMIT 1`,
                [tenantId, serviceId, searchPattern]
            );

            console.log(`      Resultados encontrados: ${stylistResult.rows.length}`);

            if (stylistResult.rows.length === 0) {
                // Buscar todos los estilistas que ofrecen el servicio para sugerir
                const allStylists = await db.query(
                    `SELECT u.first_name, u.last_name FROM users u
                     INNER JOIN stylist_services ss ON u.id = ss.user_id
                     WHERE u.tenant_id = $1 AND ss.service_id = $2
                       AND COALESCE(NULLIF(u.status, ''), 'active') = 'active'`,
                    [tenantId, serviceId]
                );
                
                const names = allStylists.rows.map(s => `${s.first_name} ${s.last_name || ''}`.trim());
                console.log(`      ❌ Estilista "${stylistName}" no encontrado`);
                console.log(`      Estilistas disponibles:`, names);

                return res.status(200).json({
                    booked: false,
                    error: `No encontré un estilista llamado "${stylistName}" que ofrezca este servicio.`,
                    available_stylists: names,
                    message: `Los estilistas disponibles son: ${names.join(', ')}. ¿Con cuál prefieres?`
                });
            }

            const found = stylistResult.rows[0];
            finalStylistId = found.id;
            console.log(`      ✅ Estilista encontrado: ${found.first_name} ${found.last_name || ''} (${finalStylistId})`);
        } else {
            console.log(`      ❌ No se proporcionó stylistId ni stylistName`);
            return res.status(400).json({ 
                booked: false, 
                error: 'Debes indicar con qué estilista deseas la cita.',
                message: '¿Con qué estilista te gustaría agendar?'
            });
        }

        if (!finalStylistId || !UUID_RE.test(finalStylistId)) {
            console.log(`      ❌ finalStylistId inválido después de resolución: ${finalStylistId}`);
            return res.status(400).json({ 
                booked: false, 
                error: 'No se pudo identificar al estilista. Por favor selecciónalo nuevamente.'
            });
        }

        console.log(`\n   ✅ Estilista resuelto: ${finalStylistId.substring(0, 8)}...`);
        console.log(`   📅 Fecha/Hora: ${date} ${time}`);

        const serviceResult = await db.query(
            'SELECT id, name, duration_minutes FROM services WHERE id = $1 AND tenant_id = $2',
            [serviceId, tenantId]
        );

        if (serviceResult.rows.length === 0) {
            return res.status(404).json({
                booked: false,
                error: 'Servicio no encontrado'
            });
        }

        const service = serviceResult.rows[0];

        const stylistResult = await db.query(
            `SELECT id, first_name, last_name, status
             FROM users
             WHERE id = $1 AND tenant_id = $2 AND role_id = 3`,
            [finalStylistId, tenantId]
        );

        if (stylistResult.rows.length === 0) {
            return res.status(404).json({
                booked: false,
                error: 'Estilista no encontrado'
            });
        }

        const stylist = stylistResult.rows[0];
        const stylistNameFull = `${stylist.first_name} ${stylist.last_name || ''}`.trim();

        if ((stylist.status || 'active') !== 'active') {
            return res.status(400).json({
                booked: false,
                error: 'El estilista no está activo'
            });
        }

        console.log(`\n   🔍 Verificando que ${stylistNameFull} ofrece el servicio...`);
        
        const offersService = await db.query(
            'SELECT 1 FROM stylist_services WHERE user_id = $1 AND service_id = $2',
            [finalStylistId, serviceId]
        );

        if (offersService.rows.length === 0) {
            console.log(`   ❌ ${stylistNameFull} NO ofrece ${service.name}`);
            
            // Buscar estilistas que sí ofrecen el servicio
            const alternativeStylists = await db.query(
                `SELECT u.first_name, u.last_name FROM users u
                 INNER JOIN stylist_services ss ON u.id = ss.user_id
                 WHERE u.tenant_id = $1 AND ss.service_id = $2
                   AND COALESCE(NULLIF(u.status, ''), 'active') = 'active'`,
                [tenantId, serviceId]
            );
            
            const names = alternativeStylists.rows.map(s => `${s.first_name} ${s.last_name || ''}`.trim());
            
            return res.status(400).json({
                booked: false,
                error: `${stylistNameFull} no ofrece el servicio "${service.name}".`,
                available_stylists: names,
                message: names.length > 0 
                    ? `${stylistNameFull} no ofrece ${service.name}. Los que sí lo ofrecen son: ${names.join(', ')}. ¿Con cuál prefieres?`
                    : `${stylistNameFull} no ofrece ${service.name}.`
            });
        }
        
        console.log(`   ✅ ${stylistNameFull} ofrece ${service.name}`);

        const startTime = makeLocalUtc(date, time);

        const now = new Date();
        if (startTime < now) {
            return res.status(400).json({
                booked: false,
                error: 'No se pueden crear citas en horarios pasados'
            });
        }

        const duration = await getStylistEffectiveDuration(
            finalStylistId,
            serviceId,
            Number(service.duration_minutes) || 60
        );

        const endTime = new Date(startTime.getTime() + duration * 60000);

        console.log(`\n   🔍 Verificando conflictos de horario...`);
        console.log(`      Start: ${startTime.toISOString()}`);
        console.log(`      End: ${endTime.toISOString()}`);

        const conflicts = await db.query(
            `SELECT id FROM appointments
             WHERE stylist_id = $1
               AND status = ANY($2)
               AND (start_time, end_time) OVERLAPS ($3, $4)`,
            [finalStylistId, BLOCKING_STATUSES, startTime, endTime]
        );

        if (conflicts.rows.length > 0) {
            console.log(`   ❌ Conflicto de horario detectado - ${conflicts.rows.length} cita(s) conflictiva(s)`);
            
            // Obtener horarios alternativos disponibles
            const { slots } = await getAvailableSlotsForStylist(tenantId, finalStylistId, serviceId, date, 15);
            const filteredSlots = filterPastSlots(slots, date);
            const availableSlots = filteredSlots.slice(0, 6).map(toLocalHHmm);
            
            return res.status(409).json({
                booked: false,
                error: 'Este horario ya no está disponible.',
                available_slots: availableSlots,
                message: availableSlots.length > 0 
                    ? `Este horario ya no está disponible. Horarios disponibles: ${availableSlots.join(', ')}. ¿Cuál prefieres?`
                    : 'Este horario ya no está disponible. ¿Quieres probar otro día?'
            });
        }

        console.log(`   ✅ No hay conflictos - procediendo a crear cita`);

        const appointment = await createAppointmentRecord(
            tenantId,
            clientId,
            finalStylistId,
            serviceId,
            startTime,
            duration
        );

        console.log(`   ✅ Cita agendada exitosamente: ${appointment.id}`);
        console.log(`${'═'.repeat(70)}`);

        try {
            const { getIO } = require('../socket');
            const io = getIO();
            io.to(`tenant:${tenantId}`).emit('appointment:created', {
                ...appointment,
                createdVia: 'whatsapp'
            });
            console.log(`   📡 Socket evento emitido`);
        } catch (socketError) {
            console.log(`   ⚠️ Socket no disponible:`, socketError.message);
        }

        return res.status(201).json({
            booked: true,
            appointment: {
                id: appointment.id,
                service: service.name,
                stylist: stylistNameFull,
                date: formatInTimeZone(startTime, TIME_ZONE, 'yyyy-MM-dd'),
                time: formatInTimeZone(startTime, TIME_ZONE, 'HH:mm'),
                duration_minutes: duration
            },
            message: `¡Listo! Tu cita de ${service.name} con ${stylistNameFull} quedó agendada para el ${formatInTimeZone(startTime, TIME_ZONE, "EEEE d 'de' MMMM", { locale: require('date-fns/locale/es') })} a las ${formatInTimeZone(startTime, TIME_ZONE, 'HH:mm')}.`
        });

    } catch (error) {
        console.error(`\n❌ [BOOK APPOINTMENT ERROR]`);
        console.error(`   Mensaje: ${error.message}`);
        console.error(`   Stack: ${error.stack}`);
        console.log(`${'═'.repeat(70)}`);

        // Mensajes más amigables según el tipo de error
        let userMessage = 'Hubo un problema al agendar tu cita. ¿Puedes intentar de nuevo?';
        
        if (error.message) {
            if (error.message.includes('Conflicto')) {
                userMessage = 'Ese horario ya fue tomado. ¿Quieres elegir otra hora?';
            } else if (error.message.includes('pasado')) {
                userMessage = 'No se pueden crear citas en fechas pasadas. ¿Qué tal mañana?';
            } else {
                userMessage = error.message;
            }
        }

        return res.status(400).json({
            booked: false,
            error: userMessage,
            message: userMessage
        });
    }
};

/* =================================================================== */
/* =================  HELPERS  ======================================= */
/* =================================================================== */

async function getAvailableStylists(tenantId, serviceId) {
    const result = await db.query(
        `SELECT DISTINCT u.id, u.first_name, u.last_name
         FROM users u
         INNER JOIN stylist_services ss ON u.id = ss.user_id
         WHERE u.tenant_id = $1
           AND u.role_id = 3
           AND COALESCE(NULLIF(u.status, ''), 'active') = 'active'
           AND ss.service_id = $2
         ORDER BY u.first_name ASC, u.last_name ASC`,
        [tenantId, serviceId]
    );

    return result.rows.map(s => ({
        id: s.id,
        name: `${s.first_name} ${s.last_name || ''}`.trim()
    }));
}

function filterPastSlots(slots, dateStr) {
    const now = new Date();
    const today = formatInTimeZone(now, TIME_ZONE, 'yyyy-MM-dd');

    if (dateStr !== today) {
        return slots;
    }

    const nowWithBuffer = new Date(now.getTime() + 5 * 60000);
    return slots.filter(slot => slot >= nowWithBuffer);
}