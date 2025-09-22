// src/controllers/appointmentController.js
const db = require('../config/db');

// --- ZONA HORARIA ---
const { zonedTimeToUtc, utcToZonedTime } = require('date-fns-tz');
const TIME_ZONE = 'America/Bogota';

// --- CONSTANTES Y HELPERS ---
const BLOCKING_STATUSES = ['scheduled','rescheduled','checked_in','checked_out','pending_approval'];
const DAY_KEYS_SPA = ['domingo','lunes','martes','miercoles','jueves','viernes','sabado'];
const DAY_KEYS_ENG = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// --- DURACIÓN DE SERVICIO ---
async function getServiceDurationMinutes(service_id, fallback = 60) {
  try {
    if (!service_id || !UUID_RE.test(service_id)) return fallback;
    const res = await db.query('SELECT duration_minutes FROM services WHERE id = $1', [service_id]);
    if (res.rows.length === 0) return fallback;
    const n = Number(res.rows[0].duration_minutes);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch (e) {
    if (e.code === '22P02') return fallback;
    throw e;
  }
}

// --- FECHAS/HORAS (LOCAL → UTC) ---
// Construye un Date en UTC a partir de una fecha local (Bogotá) y una hora HH:mm o HH:mm:ss
function makeLocalUtc(dateStr, timeStr) {
  const t = (timeStr && timeStr.length === 5) ? `${timeStr}:00` : (timeStr || '00:00:00');
  // Ej: "2025-09-22 14:30:00" interpretado en TZ America/Bogota, convertido a UTC Date
  return zonedTimeToUtc(`${dateStr} ${t}`, TIME_ZONE);
}

// Devuelve el day-of-week (0..6) de la fecha local en Bogotá
function getLocalJsDow(dateStr) {
  const utc = zonedTimeToUtc(`${dateStr} 00:00:00`, TIME_ZONE);
  const backToZoned = utcToZonedTime(utc, TIME_ZONE);
  return backToZoned.getDay();
}

// --- RANGOS DE HORARIO ---
function normalizeDayValueToRanges(val) {
  if (val == null) return [];
  if (typeof val === 'string') {
    const raw = val.trim();
    const s = raw.toLowerCase();
    if (s === 'cerrado' || s === 'closed') return [];
    if (s.includes('-')) return [raw];
    return [];
  }
  if (typeof val === 'object') {
    const active = (val.active !== false);
    if (!active) return [];
    if (Array.isArray(val.ranges) && val.ranges.length > 0) return val.ranges;
    if (val.open && val.close) return [`${val.open}-${val.close}`];
  }
  return [];
}

function timeToMin(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
}

function minToTime(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function intersectRange(r1, r2) {
  const [o1, c1] = r1.split('-').map(s => s.trim());
  const [o2, c2] = r2.split('-').map(s => s.trim());
  const start = Math.max(timeToMin(o1), timeToMin(o2));
  const end   = Math.min(timeToMin(c1), timeToMin(c2));
  if (end > start) return `${minToTime(start)}-${minToTime(end)}`;
  return null;
}

function intersectRangesArrays(rangesA, rangesB) {
  const out = [];
  for (const a of rangesA) {
    for (const b of rangesB) {
      const inter = intersectRange(a, b);
      if (inter) out.push(inter);
    }
  }
  return out;
}

// Genera slots como Date(UTC) a partir de rangos locales y paso en minutos
function buildSlotsFromRanges(dateStr, ranges, stepMinutes) {
  const slots = [];
  for (const range of ranges) {
    const [openTime, closeTime] = range.split('-').map(s => s.trim());
    if (!openTime || !closeTime) continue;

    let current = makeLocalUtc(dateStr, openTime);
    const closeDateTime = makeLocalUtc(dateStr, closeTime);

    while (current < closeDateTime) {
      const potentialEnd = new Date(current.getTime() + stepMinutes * 60000);
      if (potentialEnd <= closeDateTime) {
        slots.push(new Date(current)); // UTC
      }
      current = new Date(current.getTime() + stepMinutes * 60000);
    }
  }
  return slots;
}

function getDayRangesFromWorkingHours(workingHours, dateStr) {
  const jsDow = getLocalJsDow(dateStr); // ← Bogotá
  const spaKey = DAY_KEYS_SPA[jsDow];
  const engKey = DAY_KEYS_ENG[jsDow];

  if (!workingHours || typeof workingHours !== 'object') return [];

  const dayVal = workingHours[spaKey] ?? workingHours[engKey];
  const dayRanges = normalizeDayValueToRanges(dayVal);
  if (dayRanges.length > 0) return dayRanges;

  // Soporte legacy (bloques agrupados)
  let legacyRange = null;
  if (jsDow >= 1 && jsDow <= 5 && (workingHours.lunes_a_viernes || workingHours['lunes-viernes'])) {
    legacyRange = workingHours.lunes_a_viernes || workingHours['lunes-viernes'];
  } else if (jsDow === 6 && workingHours.sabado) {
    legacyRange = workingHours.sabado;
  } else if (jsDow === 0 && workingHours.domingo) {
    legacyRange = workingHours.domingo;
  }
  if (!legacyRange) {
    if (jsDow >= 1 && jsDow <= 5 && (workingHours.monday_to_friday || workingHours['monday-friday'])) {
      legacyRange = workingHours.monday_to_friday || workingHours['monday-friday'];
    } else if (jsDow === 6 && workingHours.saturday) {
      legacyRange = workingHours.saturday;
    } else if (jsDow === 0 && workingHours.sunday) {
      legacyRange = workingHours.sunday;
    }
  }
  const legacyRanges = normalizeDayValueToRanges(legacyRange);
  if (legacyRanges.length > 0) return legacyRanges;

  return [];
}

// ✅ Helper nuevo: obtiene los rangos efectivos del estilista (heredando si corresponde)
function getEffectiveStylistDayRanges(stylistWH, tenantWH, dateStr) {
  if (stylistWH === null) {
    return getDayRangesFromWorkingHours(tenantWH, dateStr);
  }
  return getDayRangesFromWorkingHours(stylistWH || {}, dateStr);
}

// -------------------------------
// CONTROLADORES
// -------------------------------

exports.createAppointment = async (req, res) => {
  const { stylist_id, service_id, start_time, client_id: clientIdFromRequest } = req.body;
  const { tenant_id, id: clientIdFromToken } = req.user;
  const { dryRun } = req.query;
  const final_client_id = clientIdFromRequest || clientIdFromToken;

  if (!stylist_id || !service_id || !start_time || !final_client_id) {
    return res.status(400).json({ error: 'Faltan campos obligatorios.' });
  }

  try {
    // Valida skill
    const skillCheck = await db.query(
      'SELECT 1 FROM stylist_services WHERE user_id = $1 AND service_id = $2',
      [stylist_id, service_id]
    );
    if (skillCheck.rowCount === 0) {
      return res.status(400).json({ error: 'El estilista no está cualificado para este servicio.' });
    }

    const duration = await getServiceDurationMinutes(service_id, 60);

    // start_time debe venir ISO con zona (o UTC). Lo respetamos tal cual:
    const startTimeDate = new Date(start_time);
    if (isNaN(startTimeDate)) {
      return res.status(400).json({ error: 'start_time inválido. Envíe ISO 8601 con zona o UTC.' });
    }
    const endTimeDate = new Date(startTimeDate.getTime() + duration * 60000);

    // Chequeo solapamiento
    const overlap = await db.query(
      `SELECT id FROM appointments
       WHERE stylist_id = $1
         AND status = ANY($4)
         AND (start_time, end_time) OVERLAPS ($2, $3)`,
      [stylist_id, startTimeDate, endTimeDate, BLOCKING_STATUSES]
    );
    if (overlap.rowCount > 0) {
      return res.status(409).json({ error: 'Conflicto de horario para el estilista.' });
    }

    if (String(dryRun).toLowerCase() === 'true') {
      return res.status(200).json({
        dryRun: true,
        wouldCreate: {
          tenant_id, client_id: final_client_id, stylist_id, service_id,
          start_time: startTimeDate, end_time: endTimeDate, status: 'scheduled'
        },
        wouldUpdate: { stylist_last_turn_at: 'NOW()' }
      });
    }

    const result = await db.query(
      `INSERT INTO appointments
        (tenant_id, client_id, stylist_id, service_id, start_time, end_time, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [tenant_id, final_client_id, stylist_id, service_id, startTimeDate, endTimeDate, 'scheduled']
    );

    await db.query('UPDATE users SET last_turn_at = NOW() WHERE id = $1', [stylist_id]);
    return res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error al crear la cita:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

exports.createAppointmentsBatch = async (req, res) => {
  const { appointments, client_id: clientIdFromRequest } = req.body;
  const { tenant_id, id: clientIdFromToken } = req.user;
  const final_client_id = clientIdFromRequest || clientIdFromToken;

  if (!Array.isArray(appointments) || appointments.length === 0) {
    return res.status(400).json({ error: "El body debe contener un array 'appointments' con al menos una cita." });
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
      if (isNaN(startTimeDate)) throw new Error('start_time inválido en una de las citas.');
      const endTimeDate = new Date(startTimeDate.getTime() + duration * 60000);

      const overlap = await db.query(
        `SELECT id FROM appointments
         WHERE stylist_id = $1
           AND status = ANY($4)
           AND (start_time, end_time) OVERLAPS ($2, $3)`,
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

    for (const sid of updatedStylists) {
      await db.query('UPDATE users SET last_turn_at = NOW() WHERE id = $1', [sid]);
    }

    await db.query('COMMIT');
    return res.status(201).json(createdAppointments);
  } catch (error) {
    await db.query('ROLLBACK');
    console.error('Error al crear citas en lote:', error);
    return res.status(400).json({ error: error.message });
  }
};

exports.updateAppointment = async (req, res) => {
  const { id } = req.params;
  const { stylist_id, service_id, start_time } = req.body;
  const { tenant_id } = req.user;

  if (!id) return res.status(400).json({ error: "Falta id de la cita." });
  if (!stylist_id && !service_id && !start_time) return res.status(400).json({ error: "Nada que actualizar." });

  try {
    const currentRes = await db.query(`SELECT * FROM appointments WHERE id = $1`, [id]);
    if (currentRes.rows.length === 0) return res.status(404).json({ error: "Cita no encontrada." });
    const current = currentRes.rows[0];

    if (current.tenant_id !== tenant_id) {
      return res.status(403).json({ error: "No autorizado." });
    }

    const newStylistId = stylist_id ?? current.stylist_id;
    const newServiceId = service_id ?? current.service_id;
    const newStart = start_time ? new Date(start_time) : new Date(current.start_time);
    if (isNaN(newStart)) return res.status(400).json({ error: 'start_time inválido.' });

    if (newStylistId !== current.stylist_id || newServiceId !== current.service_id) {
      const skillCheck = await db.query(
        `SELECT 1 FROM stylist_services WHERE user_id = $1 AND service_id = $2`,
        [newStylistId, newServiceId]
      );
      if (skillCheck.rowCount === 0) {
        return res.status(400).json({ error: "El estilista no está cualificado para este servicio." });
      }
    }

    const duration = await getServiceDurationMinutes(newServiceId, 60);
    const newEnd = new Date(newStart.getTime() + duration * 60000);

    const overlap = await db.query(
      `SELECT id FROM appointments
       WHERE stylist_id = $1
         AND id <> $2
         AND status = ANY($5)
         AND (start_time, end_time) OVERLAPS ($3, $4)`,
      [newStylistId, id, newStart, newEnd, BLOCKING_STATUSES]
    );
    if (overlap.rowCount > 0) {
      return res.status(409).json({ error: "Conflicto de horario para el estilista." });
    }

    await db.query(
      `UPDATE appointments
       SET stylist_id = $1, service_id = $2, start_time = $3, end_time = $4, updated_at = NOW()
       WHERE id = $5 RETURNING *;`,
      [newStylistId, newServiceId, newStart, newEnd, id]
    );

    const fullRes = await db.query(
      `SELECT a.*, s.name AS service_name, s.price,
              client.first_name AS client_first_name, client.last_name AS client_last_name,
              stylist.first_name AS stylist_first_name, stylist.last_name AS stylist_last_name
       FROM appointments a
       JOIN services s   ON a.service_id = s.id
       JOIN users client ON a.client_id  = client.id
       JOIN users stylist ON a.stylist_id = stylist.id
       WHERE a.id = $1`,
      [id]
    );
    return res.status(200).json(fullRes.rows[0]);
  } catch (error) {
    console.error("Error al actualizar la cita:", error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
};

exports.getAppointmentsByTenant = async (req, res) => {
  const { tenantId } = req.params;
  const { startDate, endDate } = req.query;

  if (!startDate || !endDate) {
    return res.status(400).json({ error: 'Debe proporcionar un rango de fechas (startDate, endDate).' });
  }

  try {
    const query = `
      SELECT a.id, a.start_time, a.end_time, a.status, a.service_id, a.stylist_id, a.client_id,
             s.name as service_name, s.price,
             client.first_name as client_first_name, client.last_name as client_last_name,
             stylist.first_name as stylist_first_name, stylist.last_name as stylist_last_name
      FROM appointments a
      JOIN services s   ON a.service_id = s.id
      JOIN users client ON a.client_id  = client.id
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

exports.getAvailability = async (req, res) => {
  const { stylist_id, date, service_id, duration_minutes } = req.query;
  const { tenant_id } = req.user;

  if (!tenant_id || !stylist_id || !date) {
    return res.status(400).json({ error: 'Faltan parámetros (tenant_id del token, stylist_id, date).' });
  }

  try {
    let serviceDuration = Number(duration_minutes);
    if (!Number.isFinite(serviceDuration) || serviceDuration <= 0) {
      serviceDuration = await getServiceDurationMinutes(service_id, 60);
    }

    // Horario del tenant
    const tenantResult = await db.query('SELECT working_hours FROM tenants WHERE id = $1', [tenant_id]);
    if (tenantResult.rows.length === 0) {
      return res.status(404).json({ error: 'Tenant no encontrado.' });
    }
    const tenantWorkingHours = tenantResult.rows[0].working_hours || {};
    const tenantDayRanges = getDayRangesFromWorkingHours(tenantWorkingHours, date);
    if (!Array.isArray(tenantDayRanges) || tenantDayRanges.length === 0) {
      return res.status(200).json({ availableSlots: [], message: 'El salón no está abierto en esta fecha.' });
    }

    // Horario del estilista (null -> hereda tenant)
    const stylistResult = await db.query(
      'SELECT working_hours FROM users WHERE id = $1 AND role_id = 3 AND tenant_id = $2',
      [stylist_id, tenant_id]
    );
    if (stylistResult.rows.length === 0) {
      return res.status(404).json({ error: 'Estilista no encontrado o no pertenece a este tenant.' });
    }
    const stylistWorkingHours = stylistResult.rows[0].working_hours ?? null;

    // Herencia
    const stylistDayRanges = getEffectiveStylistDayRanges(
      stylistWorkingHours,
      tenantWorkingHours,
      date
    );
    if (!Array.isArray(stylistDayRanges) || stylistDayRanges.length === 0) {
      return res.status(200).json({ availableSlots: [], message: 'El estilista no trabaja en esta fecha.' });
    }

    // Intersección efectiva
    const effectiveDayRanges = intersectRangesArrays(tenantDayRanges, stylistDayRanges);
    if (effectiveDayRanges.length === 0) {
      return res.status(200).json({ availableSlots: [], message: 'La hora laboral del estilista no coincide con la del salón.' });
    }

    // Citas existentes bloqueantes (día)
    const appointmentsResult = await db.query(
      `SELECT start_time, end_time
       FROM appointments
       WHERE stylist_id = $1
         AND start_time::date = $2
         AND status = ANY($3)`,
      [stylist_id, date, BLOCKING_STATUSES]
    );
    const existingAppointments = appointmentsResult.rows;

    // Construcción de slots (UTC)
    const allSlots = buildSlotsFromRanges(date, effectiveDayRanges, serviceDuration);
    const availableSlots = allSlots.filter((slot) => {
      const slotEnd = new Date(slot.getTime() + serviceDuration * 60000);
      return !existingAppointments.some((appt) => {
        const apptStart = new Date(appt.start_time);
        const apptEnd = new Date(appt.end_time);
        return slot < apptEnd && slotEnd > apptStart;
      });
    });

    return res.status(200).json({ availableSlots });
  } catch (error) {
    console.error('Error al obtener disponibilidad para estilista:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

exports.getAvailableStylistsByTime = async (req, res) => {
  const { tenant_id: tenantIdFromToken } = req.user;
  const { service_id, date, time } = req.query;

  if (!service_id || !date || !time) {
    return res.status(400).json({ error: 'Faltan parámetros obligatorios: service_id, date, time.' });
  }

  // ✅ Ajuste clave: construir la hora solicitada como LOCAL (Bogotá) -> UTC
  const requestedStartDateTime = makeLocalUtc(date, time);

  try {
    const serviceDuration = await getServiceDurationMinutes(service_id, 60);
    const requestedEndDateTime = new Date(requestedStartDateTime.getTime() + serviceDuration * 60000);

    // Horario del tenant
    const tenantResult = await db.query('SELECT working_hours FROM tenants WHERE id = $1', [tenantIdFromToken]);
    if (tenantResult.rows.length === 0) {
      return res.status(404).json({ error: 'Tenant no encontrado.' });
    }
    const tenantWorkingHours = tenantResult.rows[0].working_hours || {};
    const tenantDayRanges = getDayRangesFromWorkingHours(tenantWorkingHours, date);

    // Verifica que el tenant esté abierto (comparando en UTC, pero construyendo desde local)
    let isTenantOpenAtRequestedTime = false;
    for (const range of tenantDayRanges) {
      const [openTime, closeTime] = range.split('-').map(s => s.trim());
      const tenantOpenDateTime = makeLocalUtc(date, openTime);
      const tenantCloseDateTime = makeLocalUtc(date, closeTime);
      if (requestedStartDateTime >= tenantOpenDateTime && requestedEndDateTime <= tenantCloseDateTime) {
        isTenantOpenAtRequestedTime = true;
        break;
      }
    }
    if (!isTenantOpenAtRequestedTime) {
      return res.status(200).json({ availableStylists: [], message: 'El salón no está abierto para este servicio en la hora solicitada.' });
    }

    // Estilistas que saben hacer el servicio
    const stylistsResult = await db.query(
      `SELECT u.id, u.first_name, u.last_name, u.working_hours, ss.last_completed_at
       FROM users u
       JOIN stylist_services ss ON u.id = ss.user_id
       WHERE u.tenant_id = $1 AND u.role_id = 3 AND ss.service_id = $2
       ORDER BY ss.last_completed_at ASC NULLS FIRST`,
      [tenantIdFromToken, service_id]
    );
    const allPotentialStylists = stylistsResult.rows;

    const availableStylists = [];
    for (const stylist of allPotentialStylists) {
      const stylistWorkingHours = stylist.working_hours ?? null;

      const stylistDayRanges = getEffectiveStylistDayRanges(
        stylistWorkingHours,
        tenantWorkingHours,
        date
      );
      if (!Array.isArray(stylistDayRanges) || stylistDayRanges.length === 0) continue;

      const effectiveRanges = intersectRangesArrays(tenantDayRanges, stylistDayRanges);
      if (effectiveRanges.length === 0) continue;

      // ¿Cabe el servicio completo dentro de algún rango?
      let fitsWorkingRange = false;
      for (const r of effectiveRanges) {
        const [o, c] = r.split('-').map(s => s.trim());
        const openDT = makeLocalUtc(date, o);
        const closeDT = makeLocalUtc(date, c);
        if (requestedStartDateTime >= openDT && requestedEndDateTime <= closeDT) {
          fitsWorkingRange = true;
          break;
        }
      }
      if (!fitsWorkingRange) continue;

      // ¿Sin solapamiento con otras citas?
      const overlap = await db.query(
        `SELECT id FROM appointments
         WHERE stylist_id = $1
           AND status = ANY($4)
           AND (start_time, end_time) OVERLAPS ($2, $3)`,
        [stylist.id, requestedStartDateTime, requestedEndDateTime, BLOCKING_STATUSES]
      );
      if (overlap.rowCount === 0) {
        availableStylists.push({
          id: stylist.id,
          first_name: stylist.first_name,
          last_name: stylist.last_name,
          avatar_url: null
        });
      }
    }

    return res.status(200).json({ availableStylists });
  } catch (error) {
    console.error('Error al obtener estilistas disponibles por fecha y hora:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

exports.validateAppointment = async (req, res) => {
  const { stylist_id, service_id, date, time } = req.body;
  const { tenant_id } = req.user;

  if (!stylist_id || !service_id || !date || !time) {
    return res.status(400).json({ error: 'Faltan campos: stylist_id, service_id, date, time.' });
  }

  try {
    const duration = await getServiceDurationMinutes(service_id, 60);
    // ✅ Local (Bogotá) → UTC
    const start = makeLocalUtc(date, time);
    const end = new Date(start.getTime() + duration * 60000);

    // Tenant WH
    const tenantResult = await db.query('SELECT working_hours FROM tenants WHERE id = $1', [tenant_id]);
    if (tenantResult.rows.length === 0) {
      return res.status(404).json({ error: 'Tenant no encontrado.' });
    }
    const tenantWorkingHours = tenantResult.rows[0].working_hours || {};
    const tenantRanges = getDayRangesFromWorkingHours(tenantWorkingHours, date);

    const tenantOk = tenantRanges.some(r => {
      const [o, c] = r.split('-').map(s => s.trim());
      return start >= makeLocalUtc(date, o) && end <= makeLocalUtc(date, c);
    });
    if (!tenantOk) {
      return res.status(200).json({ valid: false, reason: 'El salón no está abierto a esa hora.' });
    }

    // Stylist WH (null -> hereda tenant)
    const stylistRes = await db.query(
      'SELECT working_hours FROM users WHERE id = $1 AND role_id = 3 AND tenant_id = $2',
      [stylist_id, tenant_id]
    );
    if (stylistRes.rows.length === 0) {
      return res.status(404).json({ error: 'Estilista no encontrado o no pertenece al tenant.' });
    }
    const sWH = stylistRes.rows[0].working_hours ?? null;

    const stylistRanges = getEffectiveStylistDayRanges(
      sWH,
      tenantWorkingHours,
      date
    );

    const effective = intersectRangesArrays(tenantRanges, stylistRanges);
    const stylistOk = effective.some(r => {
      const [o, c] = r.split('-').map(s => s.trim());
      return start >= makeLocalUtc(date, o) && end <= makeLocalUtc(date, c);
    });
    if (!stylistOk) {
      return res.status(200).json({ valid: false, reason: 'El estilista no trabaja a esa hora.' });
    }

    // Sin solapamiento con citas existentes
    const overlap = await db.query(
      `SELECT id FROM appointments
       WHERE stylist_id = $1
         AND status = ANY($4)
         AND (start_time, end_time) OVERLAPS ($2, $3)`,
      [stylist_id, start, end, BLOCKING_STATUSES]
    );
    if (overlap.rowCount > 0) {
      return res.status(200).json({ valid: false, reason: 'Conflicto de horario para el estilista.' });
    }

    return res.status(200).json({ valid: true });
  } catch (error) {
    console.error('Error al validar cita:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

exports.handleCheckIn = async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query(
      `UPDATE appointments
       SET status = 'checked_in', updated_at = NOW()
       WHERE id = $1 AND status IN ('scheduled', 'rescheduled')
       RETURNING *`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({
        message: 'Cita no encontrada o en un estado no válido para hacer check-in.'
      });
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
      `UPDATE appointments
       SET status = 'checked_out', updated_at = NOW()
       WHERE id = $1 AND status = 'checked_in'
       RETURNING stylist_id, service_id, *`,
      [id]
    );

    if (appointmentResult.rows.length === 0) {
      const currentState = await db.query('SELECT status FROM appointments WHERE id = $1', [id]);
      if (currentState.rows.length > 0 && currentState.rows[0].status !== 'checked_in') {
        throw new Error(`No se puede hacer check-out. El estado actual es '${currentState.rows[0].status}', se esperaba 'checked_in'.`);
      }
      throw new Error('Cita no encontrada o en un estado no válido para hacer check-out.');
    }

    const { stylist_id } = appointmentResult.rows[0];
    await db.query('UPDATE users SET last_service_at = NOW() WHERE id = $1', [stylist_id]);
    await db.query(
      'UPDATE stylist_services SET last_completed_at = NOW() WHERE user_id = $1',
      [stylist_id]
    );

    await db.query('COMMIT');
    return res.status(200).json(appointmentResult.rows[0]);
  } catch (error) {
    await db.query('ROLLBACK');
    console.error('Error al hacer check-out:', error);
    const errorMessage = error.message.includes('No se puede hacer check-out')
      ? error.message
      : 'Error interno del servidor';
    return res.status(400).json({ error: errorMessage });
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

exports.getTenantSlots = async (req, res) => {
  const { tenant_id } = req.user;
  const { date, service_id, interval } = req.query;

  if (!date) {
    return res.status(400).json({ error: 'Falta date (YYYY-MM-DD).' });
  }

  try {
    const tenantResult = await db.query('SELECT working_hours FROM tenants WHERE id = $1', [tenant_id]);
    if (tenantResult.rows.length === 0) {
      return res.status(404).json({ error: 'Tenant no encontrado.' });
    }
    const tenantWorking = tenantResult.rows[0].working_hours || {};
    const tenantRanges = getDayRangesFromWorkingHours(tenantWorking, date);
    if (!Array.isArray(tenantRanges) || tenantRanges.length === 0) {
      return res.status(200).json({ slots: [], message: 'El salón está cerrado en esta fecha.' });
    }

    let step;
    if (interval && Number(interval) > 0) {
      step = Number(interval);
    } else {
      step = await getServiceDurationMinutes(service_id, 60);
    }

    const slots = buildSlotsFromRanges(date, tenantRanges, step);
    return res.status(200).json({ slots });
  } catch (error) {
    console.error('Error al obtener slots del tenant:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};
