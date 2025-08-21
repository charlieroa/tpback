// src/controllers/appointmentController.js

const db = require('../config/db');

// -------------------------------
// Utilidades
// -------------------------------

// Estados que BLOQUEAN disponibilidad
// (si no quieres que 'pending_approval' bloquee, elimínalo de la lista)
const BLOCKING_STATUSES = [
  'scheduled',
  'rescheduled',
  'checked_in',
  'checked_out',
  'pending_approval'
];

// Obtiene duración (minutos) del servicio; si no existe, usa fallback
async function getServiceDurationMinutes(service_id, fallback = 60) {
  if (!service_id) return fallback;
  const res = await db.query('SELECT duration_minutes FROM services WHERE id = $1', [service_id]);
  if (res.rows.length === 0) return fallback;
  const n = Number(res.rows[0].duration_minutes);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Construye Date local (sin 'Z') a partir de YYYY-MM-DD + HH:mm (o HH:mm:ss)
function makeLocalDate(dateStr, timeStr) {
  const t = timeStr.length === 5 ? `${timeStr}:00` : timeStr;
  // Esto crea un Date interpretado en la zona horaria local del servidor
  return new Date(`${dateStr}T${t}`);
}

// -------------------------------
// CREACIÓN DE CITAS
// -------------------------------

// Crear UNA SOLA cita
exports.createAppointment = async (req, res) => {
  const { stylist_id, service_id, start_time, client_id: clientIdFromRequest } = req.body;
  const { tenant_id, id: clientIdFromToken } = req.user;
  const final_client_id = clientIdFromRequest || clientIdFromToken;

  if (!stylist_id || !service_id || !start_time || !final_client_id) {
    return res.status(400).json({ error: 'Faltan campos obligatorios.' });
  }

  try {
    // Verificar skill
    const skillCheck = await db.query(
      'SELECT 1 FROM stylist_services WHERE user_id = $1 AND service_id = $2',
      [stylist_id, service_id]
    );
    if (skillCheck.rowCount === 0) {
      return res.status(400).json({ error: 'El estilista no está cualificado para este servicio.' });
    }

    // Duración real del servicio
    const duration = await getServiceDurationMinutes(service_id, 60);

    const startTimeDate = new Date(start_time);
    const endTimeDate = new Date(startTimeDate.getTime() + duration * 60000);

    // Chequeo de solape (usa lista de estados bloqueantes)
    const overlap = await db.query(
      `
        SELECT id
        FROM appointments
        WHERE stylist_id = $1
          AND status = ANY($4)
          AND (start_time, end_time) OVERLAPS ($2, $3)
      `,
      [stylist_id, startTimeDate, endTimeDate, BLOCKING_STATUSES]
    );
    if (overlap.rowCount > 0) {
      return res.status(409).json({ error: 'Conflicto de horario para el estilista.' });
    }

    // Crear cita
    const result = await db.query(
      `INSERT INTO appointments
         (tenant_id, client_id, stylist_id, service_id, start_time, end_time, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [tenant_id, final_client_id, stylist_id, service_id, startTimeDate, endTimeDate, 'scheduled']
    );

    // 🔁 Rotación global: mover al final al estilista asignado
    await db.query('UPDATE users SET last_turn_at = NOW() WHERE id = $1', [stylist_id]);

    return res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error al crear la cita:', error.message);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// Crear MÚLTIPLES citas (batch) en una transacción
exports.createAppointmentsBatch = async (req, res) => {
  const { appointments, client_id: clientIdFromRequest } = req.body;
  const { tenant_id, id: clientIdFromToken } = req.user;
  const final_client_id = clientIdFromRequest || clientIdFromToken;

  if (!Array.isArray(appointments) || appointments.length === 0) {
    return res
      .status(400)
      .json({ error: "El body debe contener un array 'appointments' con al menos una cita." });
  }
  if (!final_client_id) {
    return res.status(400).json({ error: 'No se pudo determinar el cliente.' });
  }

  try {
    await db.query('BEGIN');
    const createdAppointments = [];
    const updatedStylists = new Set();

    for (const appt of appointments) {
      const { stylist_id, service_id, start_time } = appt;
      if (!stylist_id || !service_id || !start_time) {
        throw new Error('Cada cita debe tener stylist_id, service_id y start_time.');
      }

      const skillCheck = await db.query(
        'SELECT 1 FROM stylist_services WHERE user_id = $1 AND service_id = $2',
        [stylist_id, service_id]
      );
      if (skillCheck.rowCount === 0) {
        throw new Error('El estilista no está cualificado para uno de los servicios.');
      }

      const duration = await getServiceDurationMinutes(service_id, 60);
      const startTimeDate = new Date(start_time);
      const endTimeDate = new Date(startTimeDate.getTime() + duration * 60000);

      const overlap = await db.query(
        `
          SELECT id
          FROM appointments
          WHERE stylist_id = $1
            AND status = ANY($4)
            AND (start_time, end_time) OVERLAPS ($2, $3)
        `,
        [stylist_id, startTimeDate, endTimeDate, BLOCKING_STATUSES]
      );
      if (overlap.rowCount > 0) {
        throw new Error('Conflicto de horario para uno de los servicios.');
      }

      const result = await db.query(
        `INSERT INTO appointments
           (tenant_id, client_id, stylist_id, service_id, start_time, end_time, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [tenant_id, final_client_id, stylist_id, service_id, startTimeDate, endTimeDate, 'scheduled']
      );

      createdAppointments.push(result.rows[0]);
      updatedStylists.add(String(stylist_id));
    }

    // 🔁 Rotación global para todos los estilistas asignados en el batch
    for (const sid of updatedStylists) {
      await db.query('UPDATE users SET last_turn_at = NOW() WHERE id = $1', [sid]);
    }

    await db.query('COMMIT');
    return res.status(201).json(createdAppointments);
  } catch (error) {
    await db.query('ROLLBACK');
    console.error('Error al crear citas en lote:', error.message);
    return res.status(400).json({ error: error.message });
  }
};
exports.updateAppointment = async (req, res) => {
  const { id } = req.params;
  const { stylist_id, service_id, start_time } = req.body;
  const { tenant_id } = req.user;

  if (!id) {
    return res.status(400).json({ error: "Falta id de la cita." });
  }
  if (!stylist_id && !service_id && !start_time) {
    return res.status(400).json({ error: "Nada que actualizar." });
  }

  try {
    // 1) Cargar la cita actual (y validar tenant)
    const currentRes = await db.query(
      `SELECT * FROM appointments WHERE id = $1`,
      [id]
    );
    if (currentRes.rows.length === 0) {
      return res.status(404).json({ error: "Cita no encontrada." });
    }
    const current = currentRes.rows[0];
    if (current.tenant_id !== tenant_id) {
      return res.status(403).json({ error: "No autorizado." });
    }

    // 2) Determinar nuevos valores
    const newStylistId = stylist_id ?? current.stylist_id;
    const newServiceId = service_id ?? current.service_id;
    const newStart = start_time ? new Date(start_time) : new Date(current.start_time);

    // 3) Validar skill si cambió stylist o service
    if (newStylistId !== current.stylist_id || newServiceId !== current.service_id) {
      const skillCheck = await db.query(
        `SELECT 1 FROM stylist_services WHERE user_id = $1 AND service_id = $2`,
        [newStylistId, newServiceId]
      );
      if (skillCheck.rowCount === 0) {
        return res.status(400).json({ error: "El estilista no está cualificado para este servicio." });
      }
    }

    // 4) Duración real del servicio
    const duration = await getServiceDurationMinutes(newServiceId, 60);
    const newEnd = new Date(newStart.getTime() + duration * 60000);

    // 5) Chequear solape (excluyendo esta misma cita)
    const overlap = await db.query(
      `
        SELECT id
        FROM appointments
        WHERE stylist_id = $1
          AND id <> $2
          AND status = ANY($5)
          AND (start_time, end_time) OVERLAPS ($3, $4)
      `,
      [newStylistId, id, newStart, newEnd, BLOCKING_STATUSES]
    );
    if (overlap.rowCount > 0) {
      return res.status(409).json({ error: "Conflicto de horario para el estilista." });
    }

    // 6) Actualizar la cita
    const updatedRes = await db.query(
      `
        UPDATE appointments
        SET stylist_id = $1,
            service_id = $2,
            start_time = $3,
            end_time   = $4,
            updated_at = NOW()
        WHERE id = $5
        RETURNING *;
      `,
      [newStylistId, newServiceId, newStart, newEnd, id]
    );

    // 7) Devolver con datos enriquecidos (como espera tu front)
    const fullRes = await db.query(
      `
        SELECT a.*,
               s.name AS service_name, s.price,
               client.first_name  AS client_first_name,
               client.last_name   AS client_last_name,
               stylist.first_name AS stylist_first_name,
               stylist.last_name  AS stylist_last_name
        FROM appointments a
        JOIN services s   ON a.service_id = s.id
        JOIN users client ON a.client_id = client.id
        JOIN users stylist ON a.stylist_id = stylist.id
        WHERE a.id = $1
      `,
      [id]
    );

    return res.status(200).json(fullRes.rows[0]);
  } catch (error) {
    console.error("Error al actualizar la cita:", error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
};
// -------------------------------
// OBTENCIÓN DE CITAS
// -------------------------------
exports.getAppointmentsByTenant = async (req, res) => {
  const { tenantId } = req.params;
  const { startDate, endDate } = req.query;

  if (!startDate || !endDate) {
    return res
      .status(400)
      .json({ error: 'Debe proporcionar un rango de fechas (startDate, endDate).' });
  }

  try {
    const query = `
      SELECT a.id, a.start_time, a.end_time, a.status, a.service_id, a.stylist_id, a.client_id,
             s.name as service_name, s.price,
             client.first_name as client_first_name, client.last_name as client_last_name,
             stylist.first_name as stylist_first_name, stylist.last_name as stylist_last_name
      FROM appointments a
      JOIN services s   ON a.service_id = s.id
      JOIN users client ON a.client_id = client.id
      JOIN users stylist ON a.stylist_id = stylist.id
      WHERE a.tenant_id = $1
        AND a.start_time >= $2
        AND a.start_time <= $3
      ORDER BY a.start_time;
    `;
    const result = await db.query(query, [tenantId, startDate, endDate]);
    return res.status(200).json(result.rows);
  } catch (error) {
    console.error('Error al obtener citas:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// -------------------------------
// DISPONIBILIDAD (usa duración real y horario LOCAL)
// -------------------------------
exports.getAvailability = async (req, res) => {
  const { tenant_id, stylist_id, date, service_id, duration_minutes } = req.query;

  if (!tenant_id || !stylist_id || !date) {
    return res.status(400).json({ error: 'Faltan parámetros (tenant_id, stylist_id, date).' });
  }

  try {
    // 1) Duración: prioriza duration_minutes explícito, luego service_id, luego 60
    let serviceDuration = Number(duration_minutes);
    if (!Number.isFinite(serviceDuration) || serviceDuration <= 0) {
      serviceDuration = await getServiceDurationMinutes(service_id, 60);
    }

    // 2) Horario laboral del tenant
    const tenantResult = await db.query(
      'SELECT working_hours FROM tenants WHERE id = $1',
      [tenant_id]
    );
    if (tenantResult.rows.length === 0) {
      return res.status(404).json({ error: 'Tenant no encontrado.' });
    }
    const workingHours = tenantResult.rows[0].working_hours || {};

    // 3) Citas existentes del estilista ese día (estados que bloquean)
    const appointmentsResult = await db.query(
      `
        SELECT start_time, end_time
        FROM appointments
        WHERE stylist_id = $1
          AND start_time::date = $2
          AND status = ANY($3)
      `,
      [stylist_id, date, BLOCKING_STATUSES]
    );
    const existingAppointments = appointmentsResult.rows;

    // 4) Determinar rango de trabajo para ese día (LOCAL)
    // getDay(): 0 = domingo, 1 = lunes, ..., 6 = sábado
    const jsDow = new Date(`${date}T00:00:00`).getDay();
    let hoursRange = null;
    if (jsDow >= 1 && jsDow <= 5) hoursRange = workingHours.lunes_a_viernes;
    else if (jsDow === 6) hoursRange = workingHours.sabado;
    else if (jsDow === 0) hoursRange = workingHours.domingo; // si lo manejas

    const allSlots = [];
    if (hoursRange) {
      const [openTime, closeTime] = hoursRange.split('-'); // "08:00-20:00"
      let current = makeLocalDate(date, openTime);
      const closeDateTime = makeLocalDate(date, closeTime);

      // Genera slots con step = duración real del servicio
      while (current < closeDateTime) {
        allSlots.push(new Date(current));
        current.setMinutes(current.getMinutes() + serviceDuration);
      }
    }

    // 5) Filtrar por solapes con citas existentes
    const availableSlots = allSlots.filter((slot) => {
      const slotEnd = new Date(slot.getTime() + serviceDuration * 60000);
      return !existingAppointments.some((appt) => {
        const apptStart = new Date(appt.start_time);
        const apptEnd = new Date(appt.end_time);
        return slot < apptEnd && slotEnd > apptStart;
      });
    });

    // Puedes devolver ISO o Date; tu front los normaliza a HH:mm
    return res.status(200).json({ availableSlots });
  } catch (error) {
    console.error('Error al obtener disponibilidad:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// -------------------------------
// MANEJO DE ESTADOS DE CITA
// -------------------------------
exports.handleCheckIn = async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query(
      `
        UPDATE appointments
        SET status = 'checked_in', updated_at = NOW()
        WHERE id = $1 AND status IN ('scheduled', 'rescheduled')
        RETURNING *
      `,
      [id]
    );
    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ message: 'Cita no encontrada o en un estado no válido para hacer check-in.' });
    }
    return res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error('Error al hacer check-in:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

exports.handleCheckout = async (req, res) => {
  const { id } = req.params;
  try {
    await db.query('BEGIN');
    const appointmentResult = await db.query(
      `
        UPDATE appointments
        SET status = 'checked_out', updated_at = NOW()
        WHERE id = $1 AND status = 'checked_in'
        RETURNING stylist_id, *
      `,
      [id]
    );
    if (appointmentResult.rows.length === 0) {
      throw new Error('Cita no encontrada o en un estado no válido para hacer check-out.');
    }
    const { stylist_id } = appointmentResult.rows[0];
    await db.query('UPDATE users SET last_service_at = NOW() WHERE id = $1', [stylist_id]);
    await db.query('COMMIT');
    return res.status(200).json(appointmentResult.rows[0]);
  } catch (error) {
    await db.query('ROLLBACK');
    console.error('Error al hacer check-out:', error.message);
    return res.status(400).json({ error: error.message });
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
    return res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error('Error al actualizar la cita:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

exports.deleteAppointment = async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query('DELETE FROM appointments WHERE id = $1', [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'Cita no encontrada para eliminar' });
    }
    return res.status(204).send();
  } catch (error) {
    console.error('Error al eliminar la cita:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};
