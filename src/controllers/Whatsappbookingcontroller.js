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

console.log('🤖 [WHATSAPP BOOKING] Controlador simplificado cargado v1.0');

/* =================================================================== */
/* ==================  PASO 1: BUSCAR SERVICIO  ====================== */
/* =================================================================== */

/**
 * Busca un servicio y devuelve los estilistas que lo ofrecen
 * POST /api/whatsapp-booking/search-service
 * 
 * Body: {
 *   tenantId: string (UUID),
 *   service: string (nombre del servicio)
 * }
 * 
 * Response:
 * - Si encuentra 1 servicio: { service, stylists: [...] }
 * - Si encuentra múltiples: { options: [...], message }
 * - Si no encuentra: { error, message }
 */
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

        // Buscar servicios que coincidan (case insensitive)
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

        // Si hay múltiples coincidencias, devolver opciones
        if (result.rows.length > 1) {
            const exactMatch = result.rows.find(s => s.name.toLowerCase() === serviceName);

            if (exactMatch) {
                // Hay un match exacto, usar ese
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

            // No hay match exacto, pedir aclaración
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

        // Un solo servicio encontrado
        const serviceData = result.rows[0];
        console.log(`   ✅ Servicio encontrado: ${serviceData.name}`);

        // Obtener estilistas que ofrecen este servicio
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

/**
 * Verifica disponibilidad de horarios
 * POST /api/whatsapp-booking/check-availability
 * 
 * Body: {
 *   tenantId: string (UUID),
 *   serviceId: string (UUID),
 *   stylistId: string (UUID) - opcional,
 *   date: string (YYYY-MM-DD),
 *   time: string (HH:mm) - opcional
 * }
 * 
 * Response:
 * - Si tiene stylistId: { available, slots, stylist }
 * - Si NO tiene stylistId: { stylists_with_slots: [...] }
 */
exports.checkAvailability = async (req, res) => {
    try {
        const { tenantId, serviceId, stylistId, date, time } = req.body;

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

        // CASO A: Con estilista específico
        if (stylistId && UUID_RE.test(stylistId)) {
            console.log(`   👤 Con estilista específico: ${stylistId.substring(0, 8)}...`);

            // Verificar que el estilista exista y esté activo
            const stylistResult = await db.query(
                `SELECT id, first_name, last_name, working_hours, status
         FROM users
         WHERE id = $1 AND tenant_id = $2 AND role_id = 3`,
                [stylistId, tenantId]
            );

            if (stylistResult.rows.length === 0) {
                return res.status(404).json({ error: 'Estilista no encontrado' });
            }

            const stylist = stylistResult.rows[0];
            if ((stylist.status || 'active') !== 'active') {
                return res.status(400).json({ error: 'El estilista no está activo' });
            }

            const stylistName = `${stylist.first_name} ${stylist.last_name || ''}`.trim();

            // Verificar que ofrece el servicio
            const offersService = await db.query(
                'SELECT 1 FROM stylist_services WHERE user_id = $1 AND service_id = $2',
                [stylistId, serviceId]
            );

            if (offersService.rows.length === 0) {
                console.log(`   ❌ Estilista no ofrece este servicio`);
                return res.status(200).json({
                    available: false,
                    message: `${stylistName} no ofrece el servicio "${serviceName}".`
                });
            }

            // Obtener slots disponibles
            const { slots, duration } = await getAvailableSlotsForStylist(
                tenantId, stylistId, serviceId, date, 15
            );

            // Filtrar horarios pasados
            const filteredSlots = filterPastSlots(slots, date);

            if (filteredSlots.length === 0) {
                const isPastDay = slots.length > 0 && filteredSlots.length === 0;
                return res.status(200).json({
                    available: false,
                    stylist: { id: stylistId, name: stylistName },
                    message: isPastDay
                        ? `Todos los horarios de hoy ya pasaron. Intenta con mañana.`
                        : `${stylistName} no tiene disponibilidad el ${date}.`,
                    slots: []
                });
            }

            const availableSlots = filteredSlots.map(toLocalHHmm);

            // Si se especificó una hora, verificar si está disponible
            if (time) {
                const isAvailable = availableSlots.includes(time.slice(0, 5));

                console.log(`   ${isAvailable ? '✅' : '❌'} Hora ${time}: ${isAvailable ? 'disponible' : 'NO disponible'}`);

                return res.status(200).json({
                    available: isAvailable,
                    stylist: { id: stylistId, name: stylistName },
                    service: { id: serviceId, name: serviceName, duration_minutes: duration },
                    date,
                    time: time.slice(0, 5),
                    slots: isAvailable ? [time.slice(0, 5)] : availableSlots.slice(0, 10),
                    message: isAvailable
                        ? `${stylistName} está disponible el ${date} a las ${time}.`
                        : `${stylistName} NO está disponible a las ${time}. Horarios disponibles:`
                });
            }

            // Sin hora específica, devolver todos los slots
            console.log(`   ✅ ${availableSlots.length} horarios disponibles`);

            return res.status(200).json({
                available: true,
                stylist: { id: stylistId, name: stylistName },
                service: { id: serviceId, name: serviceName, duration_minutes: duration },
                date,
                slots: availableSlots.slice(0, 20),
                message: `${stylistName} tiene disponibilidad el ${date}:`
            });
        }

        // CASO B: Sin estilista específico - mostrar TODOS los estilistas con disponibilidad
        console.log(`   👥 Sin estilista específico - buscando todos los disponibles`);

        const allStylists = await getAvailableStylists(tenantId, serviceId);

        if (allStylists.length === 0) {
            return res.status(200).json({
                available: false,
                message: `No hay estilistas que ofrezcan "${serviceName}".`,
                stylists: []
            });
        }

        // Para cada estilista, obtener sus slots
        const stylistsWithSlots = [];

        for (const stylist of allStylists) {
            const { slots, duration } = await getAvailableSlotsForStylist(
                tenantId, stylist.id, serviceId, date, 15
            );

            const filteredSlots = filterPastSlots(slots, date);

            if (filteredSlots.length > 0) {
                const availableSlots = filteredSlots.map(toLocalHHmm);

                // Si se especificó hora, verificar si este estilista está disponible
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

/**
 * Agenda una cita
 * POST /api/whatsapp-booking/book
 * 
 * Body: {
 *   tenantId: string (UUID),
 *   clientId: string (UUID),
 *   serviceId: string (UUID),
 *   stylistId: string (UUID),
 *   date: string (YYYY-MM-DD),
 *   time: string (HH:mm)
 * }
 * 
 * Response:
 * - Success: { booked: true, appointment: {...} }
 * - Error: { booked: false, error, message }
 */
exports.bookAppointment = async (req, res) => {
    try {
        const { tenantId, clientId, serviceId, stylistId, date, time } = req.body;

        // Validaciones
        if (!tenantId || !UUID_RE.test(tenantId)) {
            return res.status(400).json({ error: 'tenantId inválido' });
        }

        if (!clientId || !UUID_RE.test(clientId)) {
            return res.status(400).json({ error: 'clientId inválido' });
        }

        if (!serviceId || !UUID_RE.test(serviceId)) {
            return res.status(400).json({ error: 'serviceId inválido' });
        }

        if (!stylistId || !UUID_RE.test(stylistId)) {
            return res.status(400).json({ error: 'stylistId inválido' });
        }

        if (!date || !time) {
            return res.status(400).json({ error: 'date y time requeridos' });
        }

        console.log(`\n📝 [BOOK APPOINTMENT]`);
        console.log(`   Cliente: ${clientId.substring(0, 8)}...`);
        console.log(`   Servicio: ${serviceId.substring(0, 8)}...`);
        console.log(`   Estilista: ${stylistId.substring(0, 8)}...`);
        console.log(`   Fecha/Hora: ${date} ${time}`);

        // Verificar que el servicio existe
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

        // Verificar que el estilista existe y está activo
        const stylistResult = await db.query(
            `SELECT id, first_name, last_name, status
       FROM users
       WHERE id = $1 AND tenant_id = $2 AND role_id = 3`,
            [stylistId, tenantId]
        );

        if (stylistResult.rows.length === 0) {
            return res.status(404).json({
                booked: false,
                error: 'Estilista no encontrado'
            });
        }

        const stylist = stylistResult.rows[0];
        const stylistName = `${stylist.first_name} ${stylist.last_name || ''}`.trim();

        if ((stylist.status || 'active') !== 'active') {
            return res.status(400).json({
                booked: false,
                error: 'El estilista no está activo'
            });
        }

        // Verificar que el estilista ofrece el servicio
        const offersService = await db.query(
            'SELECT 1 FROM stylist_services WHERE user_id = $1 AND service_id = $2',
            [stylistId, serviceId]
        );

        if (offersService.rows.length === 0) {
            return res.status(400).json({
                booked: false,
                error: `${stylistName} no ofrece el servicio "${service.name}"`
            });
        }

        // Crear el objeto Date para la cita
        const startTime = makeLocalUtc(date, time);

        // Verificar que no sea en el pasado
        const now = new Date();
        if (startTime < now) {
            return res.status(400).json({
                booked: false,
                error: 'No se pueden crear citas en horarios pasados'
            });
        }

        // Obtener duración efectiva
        const duration = await getStylistEffectiveDuration(
            stylistId,
            serviceId,
            Number(service.duration_minutes) || 60
        );

        const endTime = new Date(startTime.getTime() + duration * 60000);

        // Verificar conflictos de horario
        const conflicts = await db.query(
            `SELECT id FROM appointments
       WHERE stylist_id = $1
         AND status = ANY($2)
         AND (start_time, end_time) OVERLAPS ($3, $4)`,
            [stylistId, BLOCKING_STATUSES, startTime, endTime]
        );

        if (conflicts.rows.length > 0) {
            console.log(`   ❌ Conflicto de horario`);
            return res.status(409).json({
                booked: false,
                error: 'Este horario ya no está disponible. Por favor elige otro.'
            });
        }

        // Crear la cita
        const appointment = await createAppointmentRecord(
            tenantId,
            clientId,
            stylistId,
            serviceId,
            startTime,
            duration
        );

        console.log(`   ✅ Cita agendada: ${appointment.id}`);

        // Emitir evento de socket si está disponible
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
                stylist: stylistName,
                date: formatInTimeZone(startTime, TIME_ZONE, 'yyyy-MM-dd'),
                time: formatInTimeZone(startTime, TIME_ZONE, 'HH:mm'),
                duration_minutes: duration
            },
            message: `¡Listo! Tu cita de ${service.name} con ${stylistName} quedó agendada para el ${formatInTimeZone(startTime, TIME_ZONE, "EEEE d 'de' MMMM", { locale: require('date-fns/locale/es') })} a las ${formatInTimeZone(startTime, TIME_ZONE, 'HH:mm')}.`
        });

    } catch (error) {
        console.error('❌ [BOOK APPOINTMENT ERROR]:', error);

        // Si es un error de validación, devolverlo
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

/**
 * Obtiene lista de estilistas que ofrecen un servicio
 */
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

/**
 * Añadir filterPastSlots a appointmentHelpers si no existe
 */
function filterPastSlots(slots, dateStr) {
    const now = new Date();
    const today = formatInTimeZone(now, TIME_ZONE, 'yyyy-MM-dd');

    // Si no es hoy, devolver todos
    if (dateStr !== today) {
        return slots;
    }

    // Si es hoy, filtrar pasados (con 5min de buffer)
    const nowWithBuffer = new Date(now.getTime() + 5 * 60000);
    return slots.filter(slot => slot >= nowWithBuffer);
}