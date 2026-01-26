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
    toLocal12Hour,
    convert24to12,
    getDayRangesFromWorkingHours,
    findNextAvailableDay,
    isWithinRanges,
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
        const { tenantId, service, date, time } = req.body; // 🆕 date y time opcionales

        if (!tenantId || !UUID_RE.test(tenantId)) {
            return res.status(400).json({ error: 'tenantId inválido (UUID requerido)' });
        }

        if (!service) {
            return res.status(400).json({ error: 'service requerido' });
        }

        // 🆕 Limpiar el nombre: remover palabras comunes como "de", "el", "la", "un", "una", "para"
        const stopWords = ['de', 'del', 'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'para', 'con', 'y', 'o'];
        const serviceClean = clean(service).toLowerCase().trim();
        const serviceWords = serviceClean.split(/\s+/).filter(word => !stopWords.includes(word) && word.length > 0);
        const serviceName = serviceWords.join(' ').trim(); // "corte de caballero" → "corte caballero"
        
        // 🆕 Normalizar acentos para búsqueda más flexible
        const normalizeAccents = (str) => {
            if (!str) return '';
            return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
        };
        const serviceNameNormalized = normalizeAccents(serviceName);
        
        console.log(`\n🔍 [SEARCH SERVICE] Buscando: "${service}"`);
        console.log(`   Limpio: "${serviceName}" (palabras: ${serviceWords.join(', ')})`);
        console.log(`   Normalizado (sin acentos): "${serviceNameNormalized}"`);
        
        // 🆕 También buscar la versión original completa (por si el usuario escribe exacto)
        const serviceOriginal = clean(service).toLowerCase().trim();

        // Si solo quedó "servicio" o está vacío, mostrar todos los servicios CON ESTILISTAS ASIGNADOS
        if (!serviceName || serviceName === 'servicio' || serviceWords.length === 0) {
            console.log(`   ℹ️ Búsqueda genérica - mostrando servicios con estilistas asignados`);
            const allServices = await db.query(
                `SELECT DISTINCT s.id, s.name, s.duration_minutes
                 FROM services s
                 INNER JOIN stylist_services ss ON s.id = ss.service_id
                 INNER JOIN users u ON ss.user_id = u.id
                 WHERE s.tenant_id = $1
                   AND u.tenant_id = $1
                   AND u.role_id = 3
                   AND COALESCE(NULLIF(u.status, ''), 'active') = 'active'
                 ORDER BY s.name ASC
                 LIMIT 20`,
                [tenantId]
            );

            if (allServices.rows.length === 0) {
                return res.status(200).json({
                    found: false,
                    message: 'No hay servicios disponibles con estilistas asignados en este momento.'
                });
            }

            return res.status(200).json({
                found: true,
                multiple: true,
                options: allServices.rows.map(s => ({
                    id: s.id,
                    name: s.name,
                    duration_minutes: Number(s.duration_minutes) || 60
                })),
                message: `Tenemos estos servicios disponibles:`
            });
        }

        // Buscar primero con múltiples variantes del nombre - SOLO servicios con estilistas asignados
        let result = await db.query(
            `SELECT DISTINCT 
                s.id, 
                s.name, 
                s.duration_minutes,
                CASE 
                  WHEN LOWER(TRIM(s.name)) = $6 THEN 1
                  WHEN LOWER(TRIM(s.name)) = $7 THEN 2
                  WHEN LOWER(TRIM(s.name)) LIKE $8 || '%' THEN 3
                  WHEN LOWER(TRIM(s.name)) LIKE $9 || '%' THEN 4
                  ELSE 5
                END AS match_priority
             FROM services s
             INNER JOIN stylist_services ss ON s.id = ss.service_id
             INNER JOIN users u ON ss.user_id = u.id
             WHERE s.tenant_id = $1
               AND u.tenant_id = $1
               AND u.role_id = 3
               AND COALESCE(NULLIF(u.status, ''), 'active') = 'active'
               AND (
                 LOWER(TRIM(s.name)) LIKE $2
                 OR LOWER(TRIM(s.name)) LIKE $3
                 OR LOWER(TRIM(s.name)) LIKE $4
                 OR LOWER(TRIM(s.name)) = $5
               )
             ORDER BY match_priority, s.name ASC
             LIMIT 10`,
            [
                tenantId, 
                `%${serviceName}%`,           // Búsqueda con palabras sin stop words
                `%${serviceNameNormalized}%`, // Búsqueda normalizada (sin acentos)
                `%${serviceOriginal}%`,       // Búsqueda con texto original completo
                serviceName,                  // Match exacto limpio
                serviceName,                  // Para ordenamiento
                serviceOriginal,              // Para ordenamiento
                serviceName,                  // Para ordenamiento LIKE
                serviceOriginal               // Para ordenamiento LIKE
            ]
        );
        
        console.log(`   📊 Resultados encontrados: ${result.rows.length}`);
        if (result.rows.length > 0) {
            console.log(`   Servicios encontrados:`, result.rows.map(r => r.name));
        }

        // Si no hay resultados, buscar palabra por palabra (todas deben aparecer)
        if (result.rows.length === 0 && serviceWords.length > 0) {
            console.log(`   🔄 Buscando con palabras individuales (todas deben aparecer)...`);
            
            // Normalizar cada palabra y crear patrones de búsqueda
            const wordConditions = [];
            const params = [tenantId]; // $1 = tenantId
            
            // Cada palabra debe aparecer en el nombre (normalizada)
            for (let i = 0; i < serviceWords.length; i++) {
                const word = serviceWords[i];
                const wordNormalized = normalizeAccents(word);
                const paramIndex1 = params.length + 1; // Empezar desde $2
                const paramIndex2 = params.length + 2;
                
                wordConditions.push(`(
                    LOWER(s.name) LIKE $${paramIndex1}
                    OR LOWER(s.name) LIKE $${paramIndex2}
                )`);
                params.push(`%${word}%`);
                params.push(`%${wordNormalized}%`);
            }
            
            result = await db.query(
                `SELECT DISTINCT s.id, s.name, s.duration_minutes
                 FROM services s
                 INNER JOIN stylist_services ss ON s.id = ss.service_id
                 INNER JOIN users u ON ss.user_id = u.id
                 WHERE s.tenant_id = $1
                   AND u.tenant_id = $1
                   AND u.role_id = 3
                   AND COALESCE(NULLIF(u.status, ''), 'active') = 'active'
                   AND ${wordConditions.join(' AND ')}
                 ORDER BY s.name ASC
                 LIMIT 10`,
                params
            );
        }

        if (result.rows.length === 0) {
            console.log(`   ❌ No se encontró servicio`);
            
            // Buscar servicios similares para sugerir - SOLO con estilistas asignados
            const suggestions = await db.query(
                `SELECT DISTINCT s.name 
                 FROM services s
                 INNER JOIN stylist_services ss ON s.id = ss.service_id
                 INNER JOIN users u ON ss.user_id = u.id
                 WHERE s.tenant_id = $1
                   AND u.tenant_id = $1
                   AND u.role_id = 3
                   AND COALESCE(NULLIF(u.status, ''), 'active') = 'active'
                 ORDER BY s.name LIMIT 10`,
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
            // Buscar match exacto (con o sin acentos normalizados, sin importar mayúsculas)
            const exactMatch = result.rows.find(s => {
                const sName = s.name.toLowerCase().trim();
                const sNameNormalized = normalizeAccents(s.name.toLowerCase().trim());
                const searchNormalized = serviceNameNormalized.trim();
                return sName === serviceName.trim() || sNameNormalized === searchNormalized;
            });

            if (exactMatch) {
                console.log(`   ✅ Match exacto: ${exactMatch.name}`);
                let stylists = await getAvailableStylists(tenantId, exactMatch.id);

                // 🆕 Si hay fecha y hora, filtrar solo estilistas disponibles a esa hora
                if (date && time && stylists.length > 0) {
                    console.log(`   🕐 Filtrando estilistas disponibles el ${date} a las ${time}...`);
                    const normalizedTime = time.slice(0, 5);
                    const availableStylists = [];

                    for (const stylist of stylists) {
                        try {
                            const { slots } = await getAvailableSlotsForStylist(
                                tenantId, stylist.id, exactMatch.id, date, 15
                            );
                            const filteredSlots = filterPastSlots(slots, date);
                            const availableSlots = filteredSlots.map(toLocalHHmm);
                            
                            if (availableSlots.includes(normalizedTime)) {
                                availableStylists.push(stylist);
                            }
                        } catch (err) {
                            console.log(`   ⚠️ Error verificando disponibilidad de ${stylist.name}: ${err.message}`);
                        }
                    }

                    stylists = availableStylists;
                    console.log(`   ✅ ${stylists.length} estilistas disponibles a las ${normalizedTime}`);
                }

                console.log(`   ✅ Estilistas encontrados: ${stylists.length}`);
                if (stylists.length > 0) {
                    console.log(`   📋 Estilistas que ofrecen "${exactMatch.name}":`, stylists.map(s => s.name).join(', '));
                }

                return res.status(200).json({
                    found: true,
                    service: {
                        id: exactMatch.id,
                        name: exactMatch.name,
                        duration_minutes: Number(exactMatch.duration_minutes) || 60
                    },
                    stylists,
                    message: date && time
                        ? `Estos estilistas están disponibles para "${exactMatch.name}" el ${date} a las ${time}:`
                        : `Estos estilistas ofrecen ${exactMatch.name}:`,
                    hint: `IMPORTANTE: Solo muestra estos estilistas (${stylists.length}): ${stylists.map(s => s.name).join(', ')}. NO inventes estilistas que no estén en esta lista.`
                });
            }

            // Si no hay match exacto pero hay resultados similares, mostrarlos
            console.log(`   ⚠️ Múltiples coincidencias (${result.rows.length}):`, result.rows.map(r => r.name));
            
            // Ordenar por relevancia: los que más se parezcan primero
            const sortedResults = result.rows.sort((a, b) => {
                const aNorm = normalizeAccents(a.name.toLowerCase());
                const bNorm = normalizeAccents(b.name.toLowerCase());
                const searchNorm = serviceNameNormalized;
                
                // Priorizar los que empiecen con el texto buscado
                if (aNorm.startsWith(searchNorm) && !bNorm.startsWith(searchNorm)) return -1;
                if (!aNorm.startsWith(searchNorm) && bNorm.startsWith(searchNorm)) return 1;
                
                // Luego por longitud (más cortos primero si tienen el mismo inicio)
                return a.name.length - b.name.length;
            });
            
            return res.status(200).json({
                found: true, // 🆕 Cambiado a true - SÍ encontramos servicios
                multiple: true,
                options: sortedResults.map(s => ({
                    id: s.id,
                    name: s.name,
                    duration_minutes: Number(s.duration_minutes) || 60
                })),
                message: `Encontré estos servicios: ${sortedResults.map(s => s.name).join(', ')}. ¿Cuál prefieres?`
            });
        }

        const serviceData = result.rows[0];
        console.log(`   ✅ Servicio encontrado: ${serviceData.name}`);

        let stylists = await getAvailableStylists(tenantId, serviceData.id);

        // 🆕 Si hay fecha y hora, filtrar solo estilistas disponibles a esa hora
        if (date && time && stylists.length > 0) {
            console.log(`   🕐 Filtrando estilistas disponibles el ${date} a las ${time}...`);
            const normalizedTime = time.slice(0, 5); // Asegurar formato HH:mm
            const availableStylists = [];

            for (const stylist of stylists) {
                try {
                    const { slots } = await getAvailableSlotsForStylist(
                        tenantId, stylist.id, serviceData.id, date, 15
                    );
                    const filteredSlots = filterPastSlots(slots, date);
                    const availableSlots = filteredSlots.map(toLocalHHmm);
                    
                    if (availableSlots.includes(normalizedTime)) {
                        availableStylists.push(stylist);
                    }
                } catch (err) {
                    console.log(`   ⚠️ Error verificando disponibilidad de ${stylist.name}: ${err.message}`);
                }
            }

            stylists = availableStylists;
            console.log(`   ✅ ${stylists.length} estilistas disponibles a las ${normalizedTime}`);
        }

        if (stylists.length === 0) {
            return res.status(200).json({
                found: true,
                service: {
                    id: serviceData.id,
                    name: serviceData.name,
                    duration_minutes: Number(serviceData.duration_minutes) || 60
                },
                stylists: [],
                message: date && time
                    ? `No hay estilistas disponibles para "${serviceData.name}" el ${date} a las ${time}.`
                    : `El servicio "${serviceData.name}" existe, pero no hay estilistas que lo ofrezcan actualmente.`
            });
        }

        console.log(`   ✅ Estilistas encontrados: ${stylists.length}`);
        if (stylists.length > 0) {
            console.log(`   📋 Estilistas que ofrecen "${serviceData.name}":`, stylists.map(s => s.name).join(', '));
        }

        return res.status(200).json({
            found: true,
            service: {
                id: serviceData.id,
                name: serviceData.name,
                duration_minutes: Number(serviceData.duration_minutes) || 60
            },
            stylists,
            message: date && time
                ? `Estos estilistas están disponibles para "${serviceData.name}" el ${date} a las ${time}:`
                : `Estos estilistas ofrecen ${serviceData.name}:`,
            hint: `IMPORTANTE: Solo muestra estos estilistas (${stylists.length}): ${stylists.map(s => s.name).join(', ')}. NO inventes estilistas que no estén en esta lista.`
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
        // 🆕 VERIFICAR HORARIO DEL TENANT (PELUQUERÍA)
        // ═══════════════════════════════════════════════════════════════
        const tenantResult = await db.query('SELECT working_hours FROM tenants WHERE id = $1', [tenantId]);
        if (tenantResult.rows.length === 0) {
            return res.status(404).json({ error: 'Tenant no encontrado' });
        }

        const tenantWorkingHours = tenantResult.rows[0].working_hours || {};
        const tenantDayRanges = getDayRangesFromWorkingHours(tenantWorkingHours, date);

        // Si el salón está cerrado ese día, buscar el siguiente día disponible
        if (!Array.isArray(tenantDayRanges) || tenantDayRanges.length === 0) {
            console.log(`   ⚠️ El salón está cerrado el ${date}`);
            
            const nextAvailableDay = findNextAvailableDay(tenantWorkingHours, date, 14);
            
            if (nextAvailableDay) {
                return res.status(200).json({
                    available: false,
                    salonClosed: true,
                    nextAvailableDay: nextAvailableDay.date,
                    nextAvailableDayReadable: nextAvailableDay.readableDate,
                    message: `No, lo siento. El establecimiento está cerrado ese día. Pero puedo ofrecerte desde el ${nextAvailableDay.readableDate}. ¿Te parece bien?`
                });
            } else {
                return res.status(200).json({
                    available: false,
                    salonClosed: true,
                    message: `No, lo siento. El establecimiento está cerrado ese día. ¿Te gustaría probar con otra fecha?`
                });
            }
        }

        // ═══════════════════════════════════════════════════════════════
        // 🆕 RESOLVER ESTILISTA: Por ID o por Nombre
        // ═══════════════════════════════════════════════════════════════
        let finalStylistId = stylistId;
        let stylistInfo = null;

        if (!finalStylistId && stylistName) {
            console.log(`   🔍 Buscando estilista por nombre: "${stylistName}"`);

            const searchName = clean(stylistName).toLowerCase().trim();
            const searchPattern = `%${searchName}%`;
            
            // Buscar con múltiples variaciones para manejar acentos y nombres completos
            const stylistResult = await db.query(
                `SELECT u.id, u.first_name, u.last_name, u.working_hours
                 FROM users u
                 INNER JOIN stylist_services ss ON u.id = ss.user_id
                 WHERE u.tenant_id = $1
                   AND u.role_id = 3
                   AND ss.service_id = $2
                   AND COALESCE(NULLIF(u.status, ''), 'active') = 'active'
                   AND (
                     LOWER(TRIM(u.first_name || ' ' || COALESCE(u.last_name, ''))) ILIKE $3
                     OR LOWER(u.first_name) ILIKE $3
                     OR LOWER(COALESCE(u.last_name, '')) ILIKE $3
                     OR LOWER(u.first_name) ILIKE $4  -- Buscar solo primer nombre si coincide
                   )
                 ORDER BY 
                   CASE 
                     WHEN LOWER(TRIM(u.first_name || ' ' || COALESCE(u.last_name, ''))) = LOWER($5) THEN 0
                     WHEN LOWER(u.first_name) = LOWER($5) THEN 1
                     WHEN LOWER(TRIM(u.first_name || ' ' || COALESCE(u.last_name, ''))) LIKE $6 THEN 2
                     ELSE 3
                   END
                 LIMIT 1`,
                [tenantId, serviceId, searchPattern, `%${searchName}%`, searchName, `${searchName}%`]
            );

            if (stylistResult.rows.length === 0) {
                console.log(`   ⚠️ No se encontró estilista con nombre "${stylistName}"`);
                
                // Buscar todos los estilistas disponibles para sugerir
                const allStylists = await getAvailableStylists(tenantId, serviceId);
                const stylistNames = allStylists.map(s => s.name);
                
                console.log(`   💡 Estilistas disponibles: ${stylistNames.join(', ')}`);
                
                // Verificar si hay alguna coincidencia parcial (por si acaso es problema de acentos)
                const normalizedSearch = searchName.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
                const partialMatch = allStylists.find(s => {
                    const normalized = s.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
                    return normalized.includes(normalizedSearch) || normalizedSearch.includes(normalized.split(' ')[0]);
                });
                
                if (partialMatch) {
                    console.log(`   ✅ Coincidencia parcial encontrada: ${partialMatch.name}`);
                    // Continuar con el estilista encontrado
                    finalStylistId = partialMatch.id;
                    stylistInfo = {
                        id: partialMatch.id,
                        name: partialMatch.name
                    };
                    console.log(`   ✅ Estilista encontrado (parcial): ${stylistInfo.name} (${finalStylistId})`);
                } else {
                    return res.status(200).json({
                        available: false,
                        error: `No encontré un estilista llamado "${stylistName}" que ofrezca ${serviceName}.`,
                        message: stylistNames.length > 0
                            ? `No encontré "${stylistName}". Disponibles: ${stylistNames.join(', ')}. ¿Cuál prefieres?`
                            : `No encontré un estilista llamado "${stylistName}" que ofrezca ${serviceName}.`,
                        available_stylists: stylistNames
                    });
                }
            } else {
                // Se encontró el estilista en la primera búsqueda
                finalStylistId = stylistResult.rows[0].id;
                stylistInfo = {
                    id: finalStylistId,
                    name: `${stylistResult.rows[0].first_name} ${stylistResult.rows[0].last_name || ''}`.trim()
                };
                console.log(`   ✅ Estilista encontrado: ${stylistInfo.name} (${finalStylistId})`);
            }
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

            if (!stylistInfo) {
                stylistInfo = {
                    id: finalStylistId,
                    name: `${stylist.first_name} ${stylist.last_name || ''}`.trim()
                };
            }
            const stylistNameFull = stylistInfo.name;

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

            const { slots, duration, effectiveRanges } = await getAvailableSlotsForStylist(
                tenantId, finalStylistId, serviceId, date, 15
            );

            console.log(`   📊 Ranges efectivos para ${date}:`, effectiveRanges);
            console.log(`   📊 Total slots generados: ${slots.length}`);
            if (slots.length > 0) {
                console.log(`   📊 Primer slot (UTC):`, slots[0].toISOString());
                console.log(`   📊 Primer slot (Local):`, toLocalHHmm(slots[0]));
                console.log(`   📊 Último slot (UTC):`, slots[slots.length - 1].toISOString());
                console.log(`   📊 Último slot (Local):`, toLocalHHmm(slots[slots.length - 1]));
                
                // Verificar los primeros 5 slots para debugging
                console.log(`   📊 Primeros 5 slots (raw):`, slots.slice(0, 5).map(s => s.toISOString()));
                console.log(`   📊 Primeros 5 slots (local):`, slots.slice(0, 5).map(s => toLocalHHmm(s)));
            }

            const filteredSlots = filterPastSlots(slots, date);
            console.log(`   📊 Slots después de filtrar pasados: ${filteredSlots.length}`);

            if (filteredSlots.length === 0) {
                const isPastDay = slots.length > 0 && filteredSlots.length === 0;
                return res.status(200).json({
                    available: false,
                    stylist: { id: finalStylistId, name: stylistNameFull },
                    message: isPastDay
                        ? `No, todos los horarios de hoy ya pasaron. ¿Qué tal mañana?`
                        : `No, ${stylistNameFull} no tiene disponibilidad el ${date}. ¿Quieres probar otra fecha?`,
                    slots: []
                });
            }

            const availableSlots = filteredSlots.map(toLocalHHmm);
            const availableSlots12h = filteredSlots.map(toLocal12Hour); // 🆕 Formato 12 horas para mensajes

            if (time) {
                const isAvailable = availableSlots.includes(time.slice(0, 5));
                const time12h = convert24to12(time.slice(0, 5)); // 🆕 Convertir hora solicitada a 12h

                console.log(`   ${isAvailable ? '✅' : '❌'} Hora ${time}: ${isAvailable ? 'disponible' : 'NO disponible'}`);

                // 🔧 Verificar si la hora está fuera del horario laboral del salón
                const requestedTime = makeLocalUtc(date, time);
                const requestedEnd = new Date(requestedTime.getTime() + duration * 60000);
                const isWithinWorkingHours = isWithinRanges(date, tenantDayRanges, requestedTime, requestedEnd);
                
                let message;
                if (!isWithinWorkingHours) {
                    // La hora está fuera del horario laboral
                    message = `No, esa hora está fuera de nuestro horario de atención. Horarios disponibles: ${availableSlots12h.slice(0, 6).join(', ')}. ¿Cuál prefieres?`;
                } else if (!isAvailable) {
                    // El estilista está ocupado a esa hora
                    message = `No, ${stylistNameFull} no está disponible el ${date} a las ${time12h}. Horarios disponibles: ${availableSlots12h.slice(0, 6).join(', ')}. ¿Cuál prefieres?`;
                } else {
                    // Disponible
                    message = `${stylistNameFull} está disponible el ${date} a las ${time12h}. ¿Confirmo tu cita?`;
                }
                
                return res.status(200).json({
                    available: isAvailable && isWithinWorkingHours,
                    stylist: { id: finalStylistId, name: stylistNameFull },
                    service: { id: serviceId, name: serviceName, duration_minutes: duration },
                    date,
                    time: time.slice(0, 5),
                    slots: isAvailable ? [time.slice(0, 5)] : availableSlots.slice(0, 10),
                    slots_12h: isAvailable ? [time12h] : availableSlots12h.slice(0, 10), // 🆕 Formato 12h
                    message: message
                });
            }

            console.log(`   ✅ ${availableSlots.length} horarios disponibles`);

            // 🆕 Devolver TODOS los horarios disponibles (hasta 100 para no saturar)
            const maxSlots = Math.min(availableSlots.length, 100);
            
            // 🆕 Crear mapeo explícito de números a horarios para cuando el usuario responda con un número
            const slotsMap = {};
            availableSlots12h.slice(0, maxSlots).forEach((slot12h, index) => {
                slotsMap[index + 1] = {
                    time_12h: slot12h,
                    time_24h: availableSlots[index],
                    option_number: index + 1
                };
            });
            
            return res.status(200).json({
                available: true,
                stylist: { id: finalStylistId, name: stylistNameFull },
                service: { id: serviceId, name: serviceName, duration_minutes: duration },
                date,
                slots: availableSlots.slice(0, maxSlots),
                slots_12h: availableSlots12h.slice(0, maxSlots), // 🆕 Formato 12h - TODOS los disponibles
                slots_map: slotsMap, // 🆕 Mapeo de números a horarios (ej: {1: {time_12h: "12:00 PM", time_24h: "12:00"}})
                total_available: availableSlots.length, // 🆕 Total de horarios disponibles
                message: availableSlots.length > 10
                    ? `${stylistNameFull} tiene disponible el ${date} en múltiples horarios. ¿Qué hora te conviene?`
                    : `${stylistNameFull} tiene disponible el ${date} en estos horarios: ${availableSlots12h.join(', ')}. ¿Cuál prefieres?`,
                hint: `IMPORTANTE: Si el usuario responde con un número (ej: "1", "2", "3"), usa slots_map para mapear ese número a la hora correspondiente. Ejemplo: Si dice "2", usa slots_map[2].time_24h para llamar verificar_disponibilidad o agendar_cita.`
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
                const availableSlots12h = filteredSlots.map(toLocal12Hour); // 🆕 Formato 12h

                if (time) {
                    const isAvailableAtTime = availableSlots.includes(time.slice(0, 5));
                    const time12h = convert24to12(time.slice(0, 5)); // 🆕 Convertir a 12h
                    if (isAvailableAtTime) {
                        stylistsWithSlots.push({
                            id: stylistItem.id,
                            name: stylistItem.name,
                            available_at_requested_time: true,
                            slots: [time.slice(0, 5)],
                            slots_12h: [time12h] // 🆕 Formato 12h
                        });
                    }
                } else {
                    stylistsWithSlots.push({
                        id: stylistItem.id,
                        name: stylistItem.name,
                        slots: availableSlots.slice(0, 10),
                        slots_12h: availableSlots12h.slice(0, 10) // 🆕 Formato 12h
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

        const time12h = toLocal12Hour(startTime); // 🆕 Formato 12 horas para el mensaje
        
        return res.status(201).json({
            booked: true,
            appointment: {
                id: appointment.id,
                service: service.name,
                stylist: stylistNameFull,
                date: formatInTimeZone(startTime, TIME_ZONE, 'yyyy-MM-dd'),
                time: formatInTimeZone(startTime, TIME_ZONE, 'HH:mm'),
                time_12h: time12h, // 🆕 Formato 12h
                duration_minutes: duration
            },
            message: `¡Listo! Tu cita de ${service.name} con ${stylistNameFull} quedó agendada para el ${formatInTimeZone(startTime, TIME_ZONE, "EEEE d 'de' MMMM", { locale: require('date-fns/locale/es') })} a las ${time12h}.`
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