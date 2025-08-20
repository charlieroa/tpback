// Contenido COMPLETO y FINAL para: src/controllers/appointmentController.js

const db = require('../config/db');

// --- CREACIÓN DE CITAS ---

// Crear UNA SOLA cita
exports.createAppointment = async (req, res) => {
    const { stylist_id, service_id, start_time, client_id: clientIdFromRequest } = req.body;
    const { tenant_id, id: clientIdFromToken } = req.user;
    const final_client_id = clientIdFromRequest || clientIdFromToken;

    if (!stylist_id || !service_id || !start_time || !final_client_id) {
        return res.status(400).json({ error: 'Faltan campos obligatorios.' });
    }

    try {
        const skillCheck = await db.query('SELECT 1 FROM stylist_services WHERE user_id = $1 AND service_id = $2', [stylist_id, service_id]);
        if (skillCheck.rowCount === 0) {
            return res.status(400).json({ error: "El estilista no está cualificado para este servicio." });
        }

        const serviceRes = await db.query('SELECT duration_minutes FROM services WHERE id = $1', [service_id]);
        if (serviceRes.rows.length === 0) return res.status(404).json({ error: 'Servicio no encontrado.'});
        const duration = serviceRes.rows[0].duration_minutes;
        const startTimeDate = new Date(start_time);
        const endTimeDate = new Date(startTimeDate.getTime() + duration * 60000);

        const overlap = await db.query(
            `SELECT id FROM appointments WHERE stylist_id = $1 AND status != 'cancelled' AND (start_time, end_time) OVERLAPS ($2, $3)`,
            [stylist_id, startTimeDate, endTimeDate]
        );
        if (overlap.rowCount > 0) {
            return res.status(409).json({ error: 'Conflicto de horario para el estilista.' });
        }
        
        const result = await db.query(
            'INSERT INTO appointments (tenant_id, client_id, stylist_id, service_id, start_time, end_time, status) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
            [tenant_id, final_client_id, stylist_id, service_id, startTimeDate, endTimeDate, 'scheduled']
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Error al crear la cita:', error.message);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// ✅ NUEVA FUNCIÓN: Crear MÚLTIPLES citas en una sola transacción
exports.createAppointmentsBatch = async (req, res) => {
    const { appointments, client_id: clientIdFromRequest } = req.body;
    const { tenant_id, id: clientIdFromToken } = req.user;
    const final_client_id = clientIdFromRequest || clientIdFromToken;

    if (!Array.isArray(appointments) || appointments.length === 0) {
        return res.status(400).json({ error: "El body debe contener un array 'appointments' con al menos una cita." });
    }
    if (!final_client_id) {
        return res.status(400).json({ error: "No se pudo determinar el cliente." });
    }

    try {
        await db.query('BEGIN');
        const createdAppointments = [];

        for (const appt of appointments) {
            const { stylist_id, service_id, start_time } = appt;
            if (!stylist_id || !service_id || !start_time) throw new Error("Cada cita debe tener stylist_id, service_id y start_time.");

            const skillCheck = await db.query('SELECT 1 FROM stylist_services WHERE user_id = $1 AND service_id = $2', [stylist_id, service_id]);
            if (skillCheck.rowCount === 0) throw new Error(`El estilista no está cualificado para uno de los servicios.`);
            
            const serviceRes = await db.query('SELECT duration_minutes FROM services WHERE id = $1', [service_id]);
            if (serviceRes.rows.length === 0) throw new Error(`Servicio con id ${service_id} no encontrado.`);
            const duration = serviceRes.rows[0].duration_minutes;
            const startTimeDate = new Date(start_time);
            const endTimeDate = new Date(startTimeDate.getTime() + duration * 60000);

            const overlap = await db.query(
                `SELECT id FROM appointments WHERE stylist_id = $1 AND status != 'cancelled' AND (start_time, end_time) OVERLAPS ($2, $3)`,
                [stylist_id, startTimeDate, endTimeDate]
            );
            if (overlap.rowCount > 0) throw new Error(`Conflicto de horario para uno de los servicios.`);
            
            const result = await db.query(
                'INSERT INTO appointments (tenant_id, client_id, stylist_id, service_id, start_time, end_time, status) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
                [tenant_id, final_client_id, stylist_id, service_id, startTimeDate, endTimeDate, 'scheduled']
            );
            createdAppointments.push(result.rows[0]);
        }

        await db.query('COMMIT');
        res.status(201).json(createdAppointments);

    } catch (error) {
        await db.query('ROLLBACK');
        console.error("Error al crear citas en lote:", error.message);
        res.status(400).json({ error: error.message });
    }
};


// --- OBTENCIÓN DE CITAS Y DISPONIBILIDAD ---
exports.getAppointmentsByTenant = async (req, res) => {
    const { tenantId } = req.params;
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) { return res.status(400).json({ error: 'Debe proporcionar un rango de fechas (startDate, endDate).' }); }
    try {
        const query = `
            SELECT a.id, a.start_time, a.end_time, a.status, a.service_id, a.stylist_id, a.client_id,
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
        const result = await db.query(query, [tenantId, startDate, endDate]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error al obtener citas:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

exports.getAvailability = async (req, res) => {
    const { tenant_id, stylist_id, date } = req.query;
    if (!tenant_id || !stylist_id || !date) { return res.status(400).json({ error: 'Faltan parámetros.' }); }
    try {
        const tenantPromise = db.query('SELECT working_hours FROM tenants WHERE id = $1', [tenant_id]);
        const appointmentsPromise = db.query("SELECT start_time, end_time FROM appointments WHERE stylist_id = $1 AND start_time::date = $2 AND status != 'cancelled'", [stylist_id, date]);
        const [tenantResult, appointmentsResult] = await Promise.all([tenantPromise, appointmentsPromise]);
        if (tenantResult.rows.length === 0) { return res.status(404).json({ error: 'Tenant no encontrado.' }); }
        
        const workingHours = tenantResult.rows[0].working_hours || {};
        const existingAppointments = appointmentsResult.rows;
        const dayOfWeek = new Date(date).getUTCDay();
        const serviceDuration = 60;
        const allSlots = [];
        let hoursRange;
        if (dayOfWeek >= 1 && dayOfWeek <= 5) hoursRange = workingHours.lunes_a_viernes;
        else if (dayOfWeek === 6) hoursRange = workingHours.sabado;
        
        if (hoursRange) {
            const [openTime, closeTime] = hoursRange.split('-');
            let currentTime = new Date(`${date}T${openTime}:00.000Z`);
            const closeDateTime = new Date(`${date}T${closeTime}:00.000Z`);
            while (currentTime < closeDateTime) {
                allSlots.push(new Date(currentTime));
                currentTime.setMinutes(currentTime.getMinutes() + serviceDuration);
            }
        }
        
        const availableSlots = allSlots.filter(slot => {
            const slotEnd = new Date(slot.getTime() + serviceDuration * 60000);
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

// --- MANEJO DE ESTADOS DE CITA ---
exports.handleCheckIn = async (req, res) => {
    const { id } = req.params;
    try {
        const result = await db.query("UPDATE appointments SET status = 'checked_in', updated_at = NOW() WHERE id = $1 AND status IN ('scheduled', 'rescheduled') RETURNING *", [id]);
        if (result.rows.length === 0) { return res.status(404).json({ message: 'Cita no encontrada o en un estado no válido para hacer check-in.' }); }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error al hacer check-in:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

exports.handleCheckout = async (req, res) => {
    const { id } = req.params;
    try {
        await db.query('BEGIN');
        const appointmentResult = await db.query("UPDATE appointments SET status = 'checked_out', updated_at = NOW() WHERE id = $1 AND status = 'checked_in' RETURNING stylist_id, *", [id]);
        if (appointmentResult.rows.length === 0) { throw new Error('Cita no encontrada o en un estado no válido para hacer check-out.'); }
        const { stylist_id } = appointmentResult.rows[0];
        await db.query("UPDATE users SET last_service_at = NOW() WHERE id = $1", [stylist_id]);
        await db.query('COMMIT');
        res.status(200).json(appointmentResult.rows[0]);
    } catch (error) {
        await db.query('ROLLBACK');
        console.error('Error al hacer check-out:', error.message);
        res.status(400).json({ error: error.message });
    }
};

exports.updateAppointmentStatus = async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    if (!status) { return res.status(400).json({ error: 'Debe proporcionar un nuevo estado (status).' }); }
    try {
        const result = await db.query('UPDATE appointments SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *', [status, id]);
        if (result.rows.length === 0) { return res.status(404).json({ message: 'Cita no encontrada para actualizar.' }); }
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
        if (result.rowCount === 0) { return res.status(404).json({ message: 'Cita no encontrada para eliminar' }); }
        res.status(204).send();
    } catch (error) {
        console.error('Error al eliminar la cita:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};