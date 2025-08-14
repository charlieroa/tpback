// src/controllers/appointmentController.js
const db = require('../config/db');

// REEMPLAZA esta función en: src/controllers/appointmentController.js

// En src/controllers/appointmentController.js

exports.createAppointment = async (req, res) => {
    const { stylist_id, service_id, start_time } = req.body;
    const client_id = req.body.client_id || req.user.id;
    const { tenant_id } = req.user;

    if (!stylist_id || !service_id || !start_time || !client_id) {
        return res.status(400).json({ error: 'Faltan campos obligatorios.' });
    }

    try {
        // --- PASO 1: DEFINIR FECHAS Y DURACIÓN (CORRECCIÓN) ---
        // Movemos esta lógica al principio para que las variables existan.
        const serviceResult = await db.query('SELECT duration_minutes FROM services WHERE id = $1 AND tenant_id = $2', [service_id, tenant_id]);
        if (serviceResult.rows.length === 0) {
            return res.status(404).json({ error: 'El servicio especificado no existe para esta peluquería.' });
        }
        const duration = serviceResult.rows[0].duration_minutes;
        const startTimeDate = new Date(start_time);
        const endTimeDate = new Date(startTimeDate.getTime() + duration * 60000);


        // --- PASO 2: VALIDACIÓN DE SOLAPAMIENTO ---
        const overlappingAppointment = await db.query(
            `SELECT id FROM appointments
             WHERE stylist_id = $1 AND status != 'cancelled'
               AND (start_time, end_time) OVERLAPS ($2, $3)`,
            [stylist_id, startTimeDate, endTimeDate]
        );

        if (overlappingAppointment.rows.length > 0) {
            return res.status(409).json({ error: 'Conflicto de horario. El estilista ya tiene una cita en ese rango de tiempo.' });
        }


        // --- PASO 3: VALIDACIÓN DE HORARIO LABORAL ---
        // (Tu lógica de validación de horario se queda igual aquí)
        // ...


        // --- PASO 4: INSERTAR LA CITA ---
        const insertResult = await db.query(
            'INSERT INTO appointments (tenant_id, client_id, stylist_id, service_id, start_time, end_time, status) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
            [tenant_id, client_id, stylist_id, service_id, startTimeDate, endTimeDate, 'scheduled']
        );

        const newAppointmentId = insertResult.rows[0].id;

        // --- PASO 5: DEVOLVER LA CITA "ENRIQUECIDA" ---
        const finalAppointmentQuery = `
            SELECT 
                a.id, a.start_time, a.end_time, a.status,
                s.name as service_name,
                c.first_name as client_first_name
            FROM appointments a
            JOIN services s ON a.service_id = s.id
            JOIN users c ON a.client_id = c.id
            WHERE a.id = $1
        `;
        const finalResult = await db.query(finalAppointmentQuery, [newAppointmentId]);
        
        res.status(201).json(finalResult.rows[0]);

    } catch (error) {
        console.error('Error al crear la cita:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};


// Las otras funciones del controlador no necesitan cambios, pero las dejamos para que el archivo esté completo.
// Puedes reemplazar la función entera exports.getAppointmentsByTenant con esta versión

exports.getAppointmentsByTenant = async (req, res) => {
    const { tenantId } = req.params;
    const { startDate, endDate } = req.query; 

    if (!startDate || !endDate) {
        return res.status(400).json({ error: 'Debe proporcionar un rango de fechas (startDate, endDate).' });
    }

    try {
        // --- CONSULTA CORREGIDA ---
        const query = `
            SELECT
                a.id, a.start_time, a.end_time, a.status,
                a.service_id,
                a.stylist_id,
                a.client_id,
                s.name as service_name, s.price,
                client.first_name as client_first_name, client.last_name as client_last_name,
                stylist.first_name as stylist_first_name, stylist.last_name as stylist_last_name
            FROM appointments a
            JOIN services s ON a.service_id = s.id
            JOIN users client ON a.client_id = client.id
            JOIN users stylist ON a.stylist_id = stylist.id
            WHERE a.tenant_id = $1 AND a.start_time >= $2 AND a.start_time <= $3
            ORDER BY a.start_time;
        `;
        // --- FIN DE LA CORRECCIÓN ---

        const result = await db.query(query, [tenantId, startDate, endDate]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error al obtener citas:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};


exports.updateAppointmentStatus = async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    if (!status) {
        return res.status(400).json({ error: 'Debe proporcionar un nuevo estado (status).' });
    }

    try {
        const result = await db.query(
            'UPDATE appointments SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
            [status, id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Cita no encontrada para actualizar.' });
        }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error al actualizar la cita:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

exports.deleteAppointment = async (req, res) => {
    const { id } = req.params;
    try {
        const result = await db.query('DELETE FROM appointments WHERE id = $1', [id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Cita no encontrada para eliminar' });
        }
        res.status(204).send();
    } catch (error) {
        console.error('Error al eliminar la cita:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// AÑADIR ESTA NUEVA FUNCIÓN AL FINAL DEL ARCHIVO
exports.getAvailability = async (req, res) => {
    // Obtenemos los datos desde los query parameters de la URL
    const { tenant_id, stylist_id, date } = req.query;

    if (!tenant_id || !stylist_id || !date) {
        return res.status(400).json({ error: 'Faltan parámetros: tenant_id, stylist_id, date.' });
    }

    try {
        // --- Paso 1: Obtener el horario de la peluquería y las citas existentes del estilista para ese día ---
        const tenantPromise = db.query('SELECT working_hours FROM tenants WHERE id = $1', [tenant_id]);
        const appointmentsPromise = db.query(
            "SELECT start_time, end_time FROM appointments WHERE stylist_id = $1 AND start_time::date = $2",
            [stylist_id, date]
        );

        const [tenantResult, appointmentsResult] = await Promise.all([tenantPromise, appointmentsPromise]);

        if (tenantResult.rows.length === 0) {
            return res.status(404).json({ error: 'Tenant no encontrado.' });
        }

        const workingHours = tenantResult.rows[0].working_hours;
        const existingAppointments = appointmentsResult.rows;

        // --- Paso 2: Generar todos los posibles slots de tiempo del día ---
        const dayOfWeek = new Date(date).getDay();
        const serviceDuration = 60; // Asumimos una duración estándar o podríamos pasarla como query param
        const allSlots = [];
        
        let hoursRange;
        if (dayOfWeek >= 1 && dayOfWeek <= 5) hoursRange = workingHours.lunes_a_viernes;
        else if (dayOfWeek === 6) hoursRange = workingHours.sabado;

        if (hoursRange) {
            const [openTime, closeTime] = hoursRange.split('-');
            let currentTime = new Date(`${date}T${openTime}:00`);
            const closeDateTime = new Date(`${date}T${closeTime}:00`);

            while (currentTime < closeDateTime) {
                allSlots.push(new Date(currentTime));
                currentTime.setMinutes(currentTime.getMinutes() + serviceDuration);
            }
        }

        // --- Paso 3: Filtrar los slots que están ocupados ---
        const availableSlots = allSlots.filter(slot => {
            const slotEnd = new Date(slot.getTime() + serviceDuration * 60000);
            // Un slot está disponible si NO se solapa con ninguna cita existente
            return !existingAppointments.some(appt => {
                const apptStart = new Date(appt.start_time);
                const apptEnd = new Date(appt.end_time);
                return (slot < apptEnd && slotEnd > apptStart);
            });
        });

        res.status(200).json({ availableSlots });

    } catch (error) {
        console.error('Error al obtener disponibilidad:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

exports.handleCheckIn = async (req, res) => {
    const { id } = req.params;
    try {
        const result = await db.query(
            "UPDATE appointments SET status = 'checked_in', updated_at = NOW() WHERE id = $1 AND status IN ('scheduled', 'rescheduled') RETURNING *",
            [id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Cita no encontrada o en un estado no válido para hacer check-in.' });
        }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error al hacer check-in:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// Reemplaza la función handleCheckout en: src/controllers/appointmentController.js
exports.handleCheckout = async (req, res) => {
    const { id } = req.params;
    try {
        await db.query('BEGIN');

        // 1. Actualizar el estado de la cita a 'checked_out'
        const appointmentResult = await db.query(
            "UPDATE appointments SET status = 'checked_out', updated_at = NOW() WHERE id = $1 AND status = 'checked_in' RETURNING stylist_id",
            [id]
        );

        if (appointmentResult.rows.length === 0) {
            throw new Error('Cita no encontrada o en un estado no válido para hacer check-out.');
        }

        const { stylist_id } = appointmentResult.rows[0];

        // 2. NUEVO: Actualizar la marca de tiempo del último servicio del estilista
        await db.query(
            "UPDATE users SET last_service_at = NOW() WHERE id = $1",
            [stylist_id]
        );

        await db.query('COMMIT');
        res.status(200).json({ message: 'Checkout realizado con éxito. El turno del estilista ha sido actualizado.' });

    } catch (error) {
        await db.query('ROLLBACK');
        console.error('Error al hacer check-out:', error.message);
        res.status(400).json({ error: error.message });
    }
};