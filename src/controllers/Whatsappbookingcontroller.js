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

    getDayRangesFromWorkingHours,
    getEffectiveStylistDayRanges,
    intersectRangesArrays,
    buildSlotsFromRanges,
} = require('../utils/appointmentHelpers');

const {
    getServiceDurationMinutes,
    getStylistEffectiveDuration,
    getAvailableSlotsForStylist,
    createAppointmentRecord,
} = require('../services/appointmentService');

console.log('🤖 [WHATSAPP BOOKING] Controlador simplificado cargado v2.0');

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

        const serviceName = clean(service).toLowerCase();

        console.log(`\n🔍 [SEARCH SERVICE] Buscando: "${service}"`);

        const result = await db.query(
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

        if (result.rows.length === 0) {
            console.log(`   ❌ No se encontró servicio`);
            return res.status(200).json({
                found: false,
                message: `No encontré un servicio llamado "${service}". ¿Puedes intentar con otro nombre?`
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

        if (!tenantId || !UUID_RE.test(tenantId)) {
            return res.status(400).json({ error: 'tenantId inválido' });
        }

        if (!serviceId || !UUID_RE.test(serviceId)) {
            return res.status(400).json({ error: 'serviceId inválido' });
        }

        if (!date) {
            return res.status(400).json({ error: 'date requerido (YYYY-MM-DD)' });
        }

        console.log(`\n📅 [CHECK AVAILABILITY] Servicio: ${serviceId.substring(0, 8)}... | Fecha: ${date} | Hora: ${time || 'cualquiera'}`);

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

        // 🆕 RESOLVER ESTILISTA: Por ID o por Nombre
        let finalStylistId = stylistId;

        if (!finalStylistId && stylistName) {
            console.log(`   🔍 Buscando estilista por nombre: "${stylistName}"`);

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

            if (stylistResult.rows.length === 0) {
                return res.status(404).json({
                    available: false,
                    error: `No encontré un estilista llamado "${stylistName}" que ofrezca este servicio.`
                });
            }

            finalStylistId = stylistResult.rows[0].id;
            console.log(`   ✅ Estilista encontrado: ${finalStylistId} (${stylistResult.rows[0].first_name} ${stylistResult.rows[0].last_name})`);
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

            const stylistName = `${stylist.first_name} ${stylist.last_name || ''}`.trim();

            const offersService = await db.query(
                'SELECT 1 FROM stylist_services WHERE user_id = $1 AND service_id = $2',
                [finalStylistId, serviceId]
            );

            if (offersService.rows.length === 0) {
                console.log(`   ❌ Estilista no ofrece este servicio`);
                return res.status(200).json({
                    available: false,
                    message: `${stylistName} no ofrece el servicio "${serviceName}".`
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
                    stylist: { id: finalStylistId, name: stylistName },
                    message: isPastDay
                        ? `Todos los horarios de hoy ya pasaron. Intenta con mañana.`
                        : `${stylistName} no tiene disponibilidad el ${date}.`,
                    slots: []
                });
            }

            const availableSlots = filteredSlots.map(toLocalHHmm);

            if (time) {
                const isAvailable = availableSlots.includes(time.slice(0, 5));

                console.log(`   ${isAvailable ? '✅' : '❌'} Hora ${time}: ${isAvailable ? 'disponible' : 'NO disponible'}`);

                return res.status(200).json({
                    available: isAvailable,
                    stylist: { id: finalStylistId, name: stylistName },
                    service: { id: serviceId, name: serviceName, duration_minutes: duration },
                    date,
                    time: time.slice(0, 5),
                    slots: isAvailable ? [time.slice(0, 5)] : availableSlots.slice(0, 10),
                    message: isAvailable
                        ? `${stylistName} está disponible el ${date} a las ${time}.`
                        : `${stylistName} NO está disponible a las ${time}. Horarios disponibles:`
                });
            }

            console.log(`   ✅ ${availableSlots.length} horarios disponibles`);

            return res.status(200).json({
                available: true,
                stylist: { id: finalStylistId, name: stylistName },
                service: { id: serviceId, name: serviceName, duration_minutes: duration },
                date,
                slots: availableSlots.slice(0, 20),
                message: `${stylistName} tiene disponibilidad el ${date}:`
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

        for (const stylist of allStylists) {
            const { slots, duration } = await getAvailableSlotsForStylist(
                tenantId, stylist.id, serviceId, date, 15
            );

            const filteredSlots = filterPastSlots(slots, date);

            if (filteredSlots.length > 0) {
                const availableSlots = filteredSlots.map(toLocalHHmm);

                if (time) {
                    const isAvailableAtTime = availableSlots.includes(time.slice(0, 5));
                    if (isAvailableAtTime) {
                        stylistsWithSlots.push({
                            id: stylist.id,
                            name: stylist.name,
                            available_at_requested_time: true,
                            slots: [time.slice(0, 5)]
                        });
                    }
                } else {
                    stylistsWithSlots.push({
                        id: stylist.id,
                        name: stylist.name,
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

        if (!tenantId || !UUID_RE.test(tenantId)) {
            return res.status(400).json({ error: 'tenantId inválido' });
        }

        if (!clientId || !UUID_RE.test(clientId)) {
            return res.status(400).json({ error: 'clientId inválido' });
        }

        if (!serviceId || !UUID_RE.test(serviceId)) {
            return res.status(400).json({ error: 'serviceId inválido' });
        }

        if (!date || !time) {
            return res.status(400).json({ error: 'date y time requeridos' });
        }

        console.log(`\n📝 [BOOK APPOINTMENT]`);
        console.log(`   Cliente: ${clientId.substring(0, 8)}...`);
        console.log(`   Servicio: ${serviceId.substring(0, 8)}...`);

        // 🆕 RESOLVER ESTILISTA: Por ID o por Nombre
        let finalStylistId = stylistId;

        if (!finalStylistId && stylistName) {
            console.log(`   🔍 Buscando estilista por nombre: "${stylistName}"`);

            const stylistResult = await db.query(
                `SELECT u.id FROM users u
                 INNER JOIN stylist_services ss ON u.id = ss.user_id
                 WHERE u.tenant_id = $1 AND ss.service_id = $2
                   AND COALESCE(NULLIF(u.status, ''), 'active') = 'active'
                   AND (LOWER(u.first_name) LIKE $3 
                        OR LOWER(u.last_name) LIKE $3
                        OR LOWER(CONCAT(u.first_name, ' ', u.last_name)) LIKE $3)
                 LIMIT 1`,
                [tenantId, serviceId, `%${clean(stylistName).toLowerCase()}%`]
            );

            if (stylistResult.rows.length === 0) {
                return res.status(404).json({
                    booked: false,
                    error: `No encontré un estilista llamado "${stylistName}" que ofrezca este servicio.`
                });
            }

            finalStylistId = stylistResult.rows[0].id;
            console.log(`   ✅ Estilista encontrado: ${finalStylistId}`);
        }

        if (!finalStylistId || !UUID_RE.test(finalStylistId)) {
            return res.status(400).json({ error: 'stylistId o stylistName requerido' });
        }

        console.log(`   Estilista: ${finalStylistId.substring(0, 8)}...`);
        console.log(`   Fecha/Hora: ${date} ${time}`);

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

        const offersService = await db.query(
            'SELECT 1 FROM stylist_services WHERE user_id = $1 AND service_id = $2',
            [finalStylistId, serviceId]
        );

        if (offersService.rows.length === 0) {
            return res.status(400).json({
                booked: false,
                error: `${stylistNameFull} no ofrece el servicio "${service.name}"`
            });
        }

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

        const conflicts = await db.query(
            `SELECT id FROM appointments
             WHERE stylist_id = $1
               AND status = ANY($2)
               AND (start_time, end_time) OVERLAPS ($3, $4)`,
            [finalStylistId, BLOCKING_STATUSES, startTime, endTime]
        );

        if (conflicts.rows.length > 0) {
            console.log(`   ❌ Conflicto de horario`);
            return res.status(409).json({
                booked: false,
                error: 'Este horario ya no está disponible. Por favor elige otro.'
            });
        }

        const appointment = await createAppointmentRecord(
            tenantId,
            clientId,
            finalStylistId,
            serviceId,
            startTime,
            duration
        );

        console.log(`   ✅ Cita agendada: ${appointment.id}`);

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
        console.error('❌ [BOOK APPOINTMENT ERROR]:', error);

        if (error.message) {
            return res.status(400).json({
                booked: false,
                error: error.message
            });
        }

        return res.status(500).json({
            booked: false,
            error: 'Error interno del servidor'
        });
    }
};

/* =================================================================== */
/* =================  HELPER: OBTENER ESTILISTAS  ==================== */
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