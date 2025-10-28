// src/controllers/appointmentController.js
'use strict';

const db = require('../config/db');
const { zonedTimeToUtc, utcToZonedTime, formatInTimeZone } = require('date-fns-tz');

const TIME_ZONE = 'America/Bogota';

// --- CONSTANTES Y HELPERS BÁSICOS ---
const BLOCKING_STATUSES = Object.freeze([
  'scheduled',
  'rescheduled',
  'checked_in',
  'checked_out',
  'pending_approval',
]);

const DAY_KEYS_SPA = Object.freeze(['domingo','lunes','martes','miercoles','jueves','viernes','sabado']);
const DAY_KEYS_ENG = Object.freeze(['sunday','monday','tuesday','wednesday','thursday','friday','saturday']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const clean = v => (v ?? '').toString().trim();
const cleanHHMM = v => {
  const s = clean(v);
  if (!s) return s;
  // Acepta "14:00", "14:00\n", "1400", "14"
  const m = s.match(/^(\d{1,2})(?::?(\d{2}))?/);
  if (!m) return s.slice(0, 5);
  const h = String(Math.min(23, parseInt(m[1] || '0', 10))).padStart(2, '0');
  const mm = String(Math.min(59, parseInt(m[2] || '0', 10))).padStart(2, '0');
  return `${h}:${mm}`;
};

// Cache simple a nivel de módulo para no consultar information_schema varias veces
let _HAS_DURATION_OVERRIDE_COL = null;
async function hasDurationOverrideColumn() {
  if (_HAS_DURATION_OVERRIDE_COL != null) return _HAS_DURATION_OVERRIDE_COL;
  const q = await db.query(`
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'stylist_services'
      AND column_name  = 'duration_override_minutes'
    LIMIT 1
  `);
  _HAS_DURATION_OVERRIDE_COL = q.rowCount > 0;
  return _HAS_DURATION_OVERRIDE_COL;
}

// --- Tiempo / Fechas ---
function makeLocalUtc(dateStr, timeStr) {
  const t = (timeStr && timeStr.length === 5) ? `${timeStr}:00` : (timeStr || '00:00:00');
  let finalDateStr = dateStr;

  const now = new Date();
  const todayLocal = formatInTimeZone(now, TIME_ZONE, 'yyyy-MM-dd');
  const tomorrowLocal = formatInTimeZone(new Date(now.getTime() + 24 * 60 * 60 * 1000), TIME_ZONE, 'yyyy-MM-dd');

  if (dateStr && dateStr.toLowerCase().includes('mañana')) {
    finalDateStr = tomorrowLocal;
  } else if (dateStr && dateStr.toLowerCase().includes('hoy')) {
    finalDateStr = todayLocal;
  } else {
    finalDateStr = dateStr;
  }

  return zonedTimeToUtc(`${finalDateStr} ${t}`, TIME_ZONE);
}

function getLocalJsDow(dateStr) {
  const utc = zonedTimeToUtc(`${dateStr} 00:00:00`, TIME_ZONE);
  const backToZoned = utcToZonedTime(utc, TIME_ZONE);
  return backToZoned.getDay();
}

// Normalizadores Working Hours
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
  return (h * 60) + (m || 0);
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

function buildSlotsFromRanges(dateStr, ranges, stepMinutesRaw) {
  const stepMinutes = Number.isFinite(stepMinutesRaw) && stepMinutesRaw > 0 ? stepMinutesRaw : 15;
  const slots = [];
  for (const range of ranges) {
    const [openTime, closeTime] = range.split('-').map(s => s.trim());
    if (!openTime || !closeTime) continue;
    let current = makeLocalUtc(dateStr, openTime);
    const closeDateTime = makeLocalUtc(dateStr, closeTime);
    while (current < closeDateTime) {
      const potentialEnd = new Date(current.getTime() + stepMinutes * 60000);
      if (potentialEnd <= closeDateTime) slots.push(new Date(current));
      current = new Date(current.getTime() + stepMinutes * 60000);
    }
  }
  return slots;
}

function getDayRangesFromWorkingHours(workingHours, dateStr) {
  const jsDow = getLocalJsDow(dateStr);
  const spaKey = DAY_KEYS_SPA[jsDow];
  const engKey = DAY_KEYS_ENG[jsDow];
  if (!workingHours || typeof workingHours !== 'object') return [];
  const dayVal = workingHours[spaKey] ?? workingHours[engKey];
  const dayRanges = normalizeDayValueToRanges(dayVal);
  if (dayRanges.length > 0) return dayRanges;

  // Legacy keys
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

function getEffectiveStylistDayRanges(stylistWH, tenantWH, dateStr) {
  if (stylistWH === null) {
    return getDayRangesFromWorkingHours(tenantWH, dateStr);
  }
  return getDayRangesFromWorkingHours(stylistWH || {}, dateStr);
}

function toLocalHHmm(date) {
  return formatInTimeZone(date, TIME_ZONE, 'HH:mm');
}
function toLocalISO(date) {
  return formatInTimeZone(date, TIME_ZONE, "yyyy-MM-dd'T'HH:mm:ssXXX");
}

// -------------------------------
// HELPERS DB / LÓGICA DE NEGOCIO
// -------------------------------
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

function normalizeDateKeyword(dateStr) {
  if (!dateStr) return dateStr;
  const s = String(dateStr).toLowerCase();
  const now = new Date();
  const today = formatInTimeZone(now, TIME_ZONE, 'yyyy-MM-dd');
  const tomorrow = formatInTimeZone(new Date(now.getTime() + 24 * 60 * 60 * 1000), TIME_ZONE, 'yyyy-MM-dd');
  if (s.includes('mañana')) return tomorrow;
  if (s.includes('hoy')) return today;
  return dateStr; // assume YYYY-MM-DD
}

function normalizeHumanTimeToHHMM(t) {
  if (!t) return t;
  let s = String(t).trim().toLowerCase().replace(/\s+/g, '');
  const m = s.match(/^(\d{1,2})(?::?(\d{2}))?(am|pm)?$/);
  if (!m) return cleanHHMM(t); // intenta HH:mm
  let h = parseInt(m[1], 10);
  let mm = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3];
  if (ampm === 'pm' && h < 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

async function resolveServiceFuzzy(tenantId, { service, service_id, selected_service_id }, limit = 10) {
  const svcId = [selected_service_id, service_id].find(v => UUID_RE.test(clean(v)));
  if (svcId) {
    const r = await db.query(
      `SELECT id, name, duration_minutes FROM services WHERE id=$1 AND tenant_id=$2 LIMIT 1`,
      [svcId, tenantId]
    );
    if (r.rowCount > 0) return { chosen: r.rows[0], options: [] };
    return { chosen: null, options: [] };
  }

  const q = clean(service);
  if (!q) return { chosen: null, options: [] };

  const res = await db.query(
    `SELECT id, name, duration_minutes
     FROM services
     WHERE tenant_id=$1 AND name ILIKE '%' || $2 || '%'
     ORDER BY CASE WHEN LOWER(name)=LOWER($2) THEN 0 ELSE 1 END, LENGTH(name)
     LIMIT $3`,
    [tenantId, q, Math.max(3, Math.min(20, limit))]
  );

  if (res.rowCount === 1) return { chosen: res.rows[0], options: [] };
  if (res.rowCount === 0) return { chosen: null, options: [] };
  return { chosen: null, options: res.rows };
}

async function resolveStylistFuzzy(tenantId, { stylist, stylist_id, selected_stylist_id }, limit = 10) {
  const styId = [selected_stylist_id, stylist_id].find(v => UUID_RE.test(clean(v)));
  if (styId) {
    const r = await db.query(
      `SELECT id, first_name, last_name, working_hours, status
       FROM users
       WHERE id=$1 AND tenant_id=$2 AND role_id=3
       LIMIT 1`,
      [styId, tenantId]
    );
    if (r.rowCount > 0 && (r.rows[0].status || 'active') === 'active') {
      const row = r.rows[0];
      return { chosen: { ...row, name: `${row.first_name} ${row.last_name || ''}`.trim() }, options: [] };
    }
    return { chosen: null, options: [] };
  }

  const q = clean(stylist);
  if (!q) return { chosen: null, options: [] };

  const res = await db.query(
    `SELECT id, first_name, last_name, working_hours, status
     FROM users
     WHERE tenant_id=$1 AND role_id=3
       AND (first_name || ' ' || COALESCE(last_name,'')) ILIKE '%' || $2 || '%'
     ORDER BY
       CASE WHEN LOWER(TRIM(first_name || ' ' || COALESCE(last_name,''))) = LOWER(TRIM($2)) THEN 0 ELSE 1 END,
       LENGTH(TRIM(first_name || ' ' || COALESCE(last_name,'')))
     LIMIT $3`,
    [tenantId, q, Math.max(3, Math.min(20, limit))]
  );

  const rows = res.rows.filter(r => (r.status || 'active') === 'active');
  if (rows.length === 1) {
    const row = rows[0];
    return { chosen: { ...row, name: `${row.first_name} ${row.last_name || ''}`.trim() }, options: [] };
  }
  if (rows.length === 0) return { chosen: null, options: [] };
  return {
    chosen: null,
    options: rows.map(r => ({ id: r.id, name: `${r.first_name} ${r.last_name || ''}`.trim(), working_hours: r.working_hours }))
  };
}

function isWithinRanges(dateStr, ranges, startUtc, endUtc) {
  if (!ranges || ranges.length === 0) return false;
  return ranges.some(r => {
    const [o, c] = r.split('-').map(s => s.trim());
    const openDT  = makeLocalUtc(dateStr, o);
    const closeDT = makeLocalUtc(dateStr, c);
    return startUtc >= openDT && endUtc <= closeDT;
  });
}

// -------------------------------
// FUNCIÓN HELPER: Buscar estilistas disponibles (por nombre exacto de servicio)
// -------------------------------
async function findAvailableStylists(tenantId, serviceName, dateStr, timeStr) {
  try {
    const serviceRes = await db.query(
      'SELECT id, duration_minutes FROM services WHERE tenant_id = $1 AND LOWER(name) = LOWER($2)',
      [tenantId, serviceName]
    );
    if (serviceRes.rows.length === 0) return [];
    const serviceId = serviceRes.rows[0].id;
    const serviceDuration = Number(serviceRes.rows[0].duration_minutes) || 60;

    const requestedStartDateTime = makeLocalUtc(dateStr, timeStr);
    const requestedEndDateTime = new Date(requestedStartDateTime.getTime() + serviceDuration * 60000);

    const tenantResult = await db.query('SELECT working_hours FROM tenants WHERE id = $1', [tenantId]);
    if (tenantResult.rows.length === 0) return [];
    const tenantWorkingHours = tenantResult.rows[0].working_hours || {};
    const tenantDayRanges = getDayRangesFromWorkingHours(tenantWorkingHours, dateStr);
    if (!Array.isArray(tenantDayRanges) || tenantDayRanges.length === 0) return [];

    // Salón abierto en ese rango
    if (!isWithinRanges(dateStr, tenantDayRanges, requestedStartDateTime, requestedEndDateTime)) return [];

    const stylistsResult = await db.query(
      `SELECT u.id, u.first_name, u.last_name, u.working_hours
       FROM users u
       JOIN stylist_services ss ON u.id = ss.user_id
       WHERE u.tenant_id = $1
         AND u.role_id = 3
         AND COALESCE(NULLIF(u.status,''),'active')='active'
         AND ss.service_id = $2`,
      [tenantId, serviceId]
    );
    const allPotentialStylists = stylistsResult.rows;

    const availableStylists = [];
    for (const stylist of allPotentialStylists) {
      const stylistDayRanges = getEffectiveStylistDayRanges(stylist.working_hours ?? null, tenantWorkingHours, dateStr);
      if (!Array.isArray(stylistDayRanges) || stylistDayRanges.length === 0) continue;
      const effectiveRanges = intersectRangesArrays(tenantDayRanges, stylistDayRanges);
      if (effectiveRanges.length === 0) continue;

      // Dentro de horario efectivo
      if (!isWithinRanges(dateStr, effectiveRanges, requestedStartDateTime, requestedEndDateTime)) continue;

      const overlap = await db.query(
        `SELECT 1 FROM appointments
         WHERE stylist_id = $1 AND status = ANY($4) AND (start_time, end_time) OVERLAPS ($2, $3)
         LIMIT 1`,
        [stylist.id, requestedStartDateTime, requestedEndDateTime, BLOCKING_STATUSES]
      );
      if (overlap.rowCount === 0) {
        availableStylists.push(stylist);
      }
    }
    return availableStylists;
  } catch (error) {
    console.error('Error al encontrar estilistas disponibles:', error);
    return [];
  }
}

// ===================================================================
// NUEVOS HELPERS DE LENGUAJE NATURAL (para Orchestrator)
// ===================================================================
exports.normalizeDateKeyword = normalizeDateKeyword;
exports.normalizeHumanTimeToHHMM = normalizeHumanTimeToHHMM;
exports.resolveServiceFuzzy = resolveServiceFuzzy;
exports.resolveStylistFuzzy = resolveStylistFuzzy;

// -------------------------------
// CONTROLADORES
// -------------------------------

// --- NUEVO: PUBLIC Smart Availability (servicio + estilista + sugerencias) ---
exports.smartAvailabilityPublic = async (req, res) => {
  try {
    let { tenantId, service, stylist, date, time, step, limit } = req.query;

    tenantId = clean(tenantId);
    service  = clean(service);
    stylist  = clean(stylist);
    date     = clean(date);
    time     = time ? cleanHHMM(time) : null;

    if (!tenantId || !service || !stylist || !date) {
      return res.status(400).json({
        error: 'Faltan parámetros: tenantId, service (id|nombre), stylist (id|nombre), date (YYYY-MM-DD). time opcional (HH:mm).'
      });
    }
    if (!UUID_RE.test(tenantId)) {
      return res.status(400).json({ error: 'tenantId inválido (debe ser UUID).' });
    }

    const stepMinutes = Math.max(5, parseInt(step || '15', 10));
    const suggestLimit = Math.max(1, parseInt(limit || '6', 10));

    // Servicio (id o nombre)
    let serviceRow = null;
    if (UUID_RE.test(service)) {
      const r = await db.query(
        `SELECT id, name, duration_minutes FROM services WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
        [service, tenantId]
      );
      serviceRow = r.rows[0] || null;
    } else {
      const r = await db.query(
        `SELECT id, name, duration_minutes FROM services WHERE tenant_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1`,
        [tenantId, service]
      );
      serviceRow = r.rows[0] || null;
    }
    if (!serviceRow) return res.status(404).json({ error: 'Servicio no encontrado.' });

    const serviceId = serviceRow.id;
    const serviceName = serviceRow.name;
    const baseDuration = Number(serviceRow.duration_minutes) || 60;

    // Estilista (id o nombre completo)
    let stylistRow = null;
    if (UUID_RE.test(stylist)) {
      const r = await db.query(
        `SELECT id, first_name, last_name, working_hours, status
         FROM users WHERE id = $1 AND tenant_id = $2 AND role_id = 3 LIMIT 1`,
        [stylist, tenantId]
      );
      stylistRow = r.rows[0] || null;
    } else {
      const r = await db.query(
        `SELECT id, first_name, last_name, working_hours, status
         FROM users
         WHERE tenant_id = $1 AND role_id = 3
           AND LOWER(TRIM(first_name || ' ' || COALESCE(last_name,''))) = LOWER(TRIM($2))
         LIMIT 1`,
        [tenantId, stylist]
      );
      stylistRow = r.rows[0] || null;
    }
    if (!stylistRow) return res.status(404).json({ error: 'Estilista no encontrado.' });
    if ((stylistRow.status || 'active') !== 'active') {
      return res.status(409).json({ error: 'El estilista no está activo.' });
    }

    const stylistId = stylistRow.id;
    const stylistName = `${stylistRow.first_name} ${stylistRow.last_name || ''}`.trim();

    // ¿El estilista hace el servicio? (y duración efectiva)
    const skillExist = await db.query(
      `SELECT 1
       FROM stylist_services
       WHERE user_id = $1 AND service_id = $2
       LIMIT 1`,
      [stylistId, serviceId]
    );
    if (skillExist.rowCount === 0) {
      return res.status(200).json({
        service: { id: serviceId, name: serviceName },
        stylist: { id: stylistId, name: stylistName },
        offers_service: false,
        is_available: false,
        suggestions: [],
        reason: 'El estilista no ofrece este servicio.'
      });
    }

    // duración por defecto = del servicio, con override opcional si existe
    let duration = baseDuration;
    if (await hasDurationOverrideColumn()) {
      const overRes = await db.query(
        `SELECT duration_override_minutes
         FROM stylist_services
         WHERE user_id = $1 AND service_id = $2
         LIMIT 1`,
        [stylistId, serviceId]
      );
      const override = Number(overRes.rows[0]?.duration_override_minutes);
      if (Number.isFinite(override) && override > 0) duration = override;
    }

    // Horarios Tenant / Estilista y rangos efectivos del día
    const tRes = await db.query(`SELECT working_hours FROM tenants WHERE id = $1`, [tenantId]);
    if (tRes.rowCount === 0) return res.status(404).json({ error: 'Tenant no encontrado.' });

    const tenantWH = tRes.rows[0].working_hours || {};
    const tenantRanges = getDayRangesFromWorkingHours(tenantWH, date);
    if (!tenantRanges.length) {
      return res.status(200).json({
        service: { id: serviceId, name: serviceName },
        stylist: { id: stylistId, name: stylistName },
        offers_service: true,
        is_available: false,
        suggestions: [],
        reason: 'El salón está cerrado ese día.'
      });
    }

    const stylistWH = stylistRow.working_hours ?? null;
    const stylistRanges = getEffectiveStylistDayRanges(stylistWH, tenantWH, date);
    if (!stylistRanges.length) {
      return res.status(200).json({
        service: { id: serviceId, name: serviceName },
        stylist: { id: stylistId, name: stylistName },
        offers_service: true,
        is_available: false,
        suggestions: [],
        reason: 'El estilista no trabaja ese día.'
      });
    }

    const effectiveRanges = intersectRangesArrays(tenantRanges, stylistRanges);
    if (!effectiveRanges.length) {
      return res.status(200).json({
        service: { id: serviceId, name: serviceName },
        stylist: { id: stylistId, name: stylistName },
        offers_service: true,
        is_available: false,
        suggestions: [],
        reason: 'El horario del estilista no coincide con el del salón.'
      });
    }

    // Citas existentes del día (en hora Bogotá para comparar por date)
    const apptRes = await db.query(
      `SELECT start_time, end_time
       FROM appointments
       WHERE stylist_id = $1
         AND (start_time AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date = $2::date
         AND status = ANY($3)`,
      [stylistId, date, BLOCKING_STATUSES]
    );

    // Generar slots del día
    const candidateStarts = buildSlotsFromRanges(date, effectiveRanges, stepMinutes);

    // Filtrar por solapes con citas (cada slot ocupa "duration" minutos)
    const availableSlots = candidateStarts.filter(start => {
      const end = new Date(start.getTime() + duration * 60000);
      return !apptRes.rows.some(a => {
        const s = new Date(a.start_time);
        const e = new Date(a.end_time);
        return start < e && end > s;
      });
    });

    const allLocalTimes = availableSlots.map(toLocalHHmm);

    // ¿Hay hora exacta pedida?
    let isAvailable = false;
    let suggestions = [];
    let reason = undefined;

    if (time) {
      const wanted = String(time).slice(0,5); // HH:mm
      isAvailable = allLocalTimes.includes(wanted);

      if (!isAvailable) {
        const wantedDate = makeLocalUtc(date, wanted);
        const withDist = availableSlots.map(d => ({
          d, dist: Math.abs(d.getTime() - wantedDate.getTime())
        })).sort((a,b)=>a.dist - b.dist);

        suggestions = [...new Set(withDist.slice(0, suggestLimit).map(x => toLocalHHmm(x.d)))];
        if (!suggestions.length) reason = 'No hay turnos disponibles cercanos.';
      }
    } else {
      // Si no viene time, devolver primeras opciones del día
      suggestions = allLocalTimes.slice(0, suggestLimit);
    }

    return res.status(200).json({
      service: { id: serviceId, name: serviceName, duration_minutes: duration },
      stylist: { id: stylistId, name: stylistName },
      offers_service: true,
      requested: { date, time: time || null },
      is_available: !!isAvailable,
      suggestions,
      slots_all: allLocalTimes.slice(0, 48)
    });
  } catch (e) {
    console.error('smartAvailabilityPublic', e);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// --- NUEVO: PUBLIC Smart Availability (POST JSON que reusa el GET) ---
exports.smartAvailabilityPublicJSON = async (req, res) => {
  try {
    const {
      tenantId,
      service,
      stylist,
      date,
      time,
      step,
      limit
    } = req.body || {};

    req.query = {
      tenantId: tenantId ?? '',
      service:  service  ?? '',
      stylist:  stylist  ?? '',
      date:     date     ?? '',
      time:     time     ?? '',
      step:     step     ?? '',
      limit:    limit    ?? ''
    };

    return exports.smartAvailabilityPublic(req, res);
  } catch (e) {
    console.error('smartAvailabilityPublicJSON', e);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// --- NUEVO: VERIFICAR (servicio + estilista + horario) PÚBLICO ---
exports.verifyStylistServiceAndAvailabilityPublic = async (req, res) => {
  try {
    let { tenantId, service, stylist, date, time, limit } = req.query;
    tenantId = clean(tenantId);
    service  = clean(service);
    stylist  = clean(stylist);
    date     = clean(date);
    time     = cleanHHMM(time);
    const suggestLimit = Math.max(1, parseInt(limit || '5', 10));

    if (!tenantId || !service || !stylist || !date || !time) {
      return res.status(400).json({ error: 'Faltan parámetros: tenantId, service, stylist, date, time.' });
    }
    if (!UUID_RE.test(tenantId)) return res.status(400).json({ error: 'tenantId inválido.' });

    // Servicio
    const svcQ = UUID_RE.test(service)
      ? db.query(`SELECT id, name, duration_minutes FROM services WHERE id=$1 AND tenant_id=$2 LIMIT 1`, [service, tenantId])
      : db.query(`SELECT id, name, duration_minutes FROM services WHERE tenant_id=$1 AND LOWER(name)=LOWER($2) LIMIT 1`, [tenantId, service]);
    const svc = (await svcQ).rows[0];
    if (!svc) return res.status(404).json({ error: 'Servicio no encontrado.' });

    // Estilista
    const styQ = UUID_RE.test(stylist)
      ? db.query(`SELECT id, first_name, last_name, working_hours, status FROM users WHERE id=$1 AND tenant_id=$2 AND role_id=3 LIMIT 1`, [stylist, tenantId])
      : db.query(`
          SELECT id, first_name, last_name, working_hours, status
          FROM users
          WHERE tenant_id=$1 AND role_id=3
            AND LOWER(TRIM(first_name || ' ' || COALESCE(last_name,''))) = LOWER(TRIM($2))
          LIMIT 1`, [tenantId, stylist]);
    const sty = (await styQ).rows[0];
    if (!sty) return res.status(404).json({ error: 'Estilista no encontrado.' });
    if ((sty.status || 'active') !== 'active') {
      return res.status(409).json({ error: 'El estilista no está activo.' });
    }

    // ¿El estilista hace el servicio?
    const skill = await db.query(`SELECT 1 FROM stylist_services WHERE user_id=$1 AND service_id=$2 LIMIT 1`, [sty.id, svc.id]);
    if (skill.rowCount === 0) {
      return res.status(200).json({
        service: { id: svc.id, name: svc.name },
        stylist: { id: sty.id, name: `${sty.first_name} ${sty.last_name||''}`.trim() },
        offers_service: false,
        is_available: false,
        reason: 'El estilista no ofrece este servicio.',
        suggestions: []
      });
    }

    // Horarios efectivos
    const tRes = await db.query(`SELECT working_hours FROM tenants WHERE id=$1`, [tenantId]);
    if (tRes.rowCount === 0) return res.status(404).json({ error: 'Tenant no encontrado.' });
    const tenantWH = tRes.rows[0].working_hours || {};
    const tenantRanges = getDayRangesFromWorkingHours(tenantWH, date);
    if (!tenantRanges.length) {
      return res.status(200).json({
        service: { id: svc.id, name: svc.name },
        stylist: { id: sty.id, name: `${sty.first_name} ${sty.last_name||''}`.trim() },
        offers_service: true,
        is_available: false,
        reason: 'El salón está cerrado ese día.',
        suggestions: []
      });
    }
    const stylistRanges = getEffectiveStylistDayRanges(sty.working_hours ?? null, tenantWH, date);
    if (!stylistRanges.length) {
      return res.status(200).json({
        service: { id: svc.id, name: svc.name },
        stylist: { id: sty.id, name: `${sty.first_name} ${sty.last_name||''}`.trim() },
        offers_service: true,
        is_available: false,
        reason: 'El estilista no trabaja ese día.',
        suggestions: []
      });
    }
    const effectiveRanges = intersectRangesArrays(tenantRanges, stylistRanges);
    if (!effectiveRanges.length) {
      return res.status(200).json({
        service: { id: svc.id, name: svc.name },
        stylist: { id: sty.id, name: `${sty.first_name} ${sty.last_name||''}`.trim() },
        offers_service: true,
        is_available: false,
        reason: 'El horario del estilista no coincide con el del salón.',
        suggestions: []
      });
    }

    // Duración (considera override)
    let duration = Number(svc.duration_minutes) || 60;
    if (await hasDurationOverrideColumn()) {
      const over = await db.query(
        `SELECT duration_override_minutes FROM stylist_services WHERE user_id=$1 AND service_id=$2 LIMIT 1`,
        [sty.id, svc.id]
      );
      const d = Number(over.rows[0]?.duration_override_minutes);
      if (Number.isFinite(d) && d > 0) duration = d;
    }

    // Ventana solicitada
    const wantedStart = makeLocalUtc(date, time);
    const wantedEnd   = new Date(wantedStart.getTime() + duration * 60000);

    // Dentro de rango laboral
    const inRange = isWithinRanges(date, effectiveRanges, wantedStart, wantedEnd);
    if (!inRange) {
      const candidates = buildSlotsFromRanges(date, effectiveRanges, 15);
      const withDist = candidates.map(d => ({ d, dist: Math.abs(d.getTime() - wantedStart.getTime()) }))
                                 .sort((a,b)=>a.dist-b.dist);
      return res.status(200).json({
        service: { id: svc.id, name: svc.name, duration_minutes: duration },
        stylist: { id: sty.id, name: `${sty.first_name} ${sty.last_name||''}`.trim() },
        offers_service: true,
        is_available: false,
        reason: 'La hora solicitada está fuera del horario laboral.',
        suggestions: [...new Set(withDist.slice(0, suggestLimit).map(x => toLocalHHmm(x.d)))]
      });
    }

    // Conflictos
    const overlap = await db.query(
      `SELECT id FROM appointments
       WHERE stylist_id=$1 AND status=ANY($4) AND (start_time, end_time) OVERLAPS ($2,$3)`,
      [sty.id, wantedStart, wantedEnd, BLOCKING_STATUSES]
    );
    if (overlap.rowCount > 0) {
      const apptDay = await db.query(
        `SELECT start_time, end_time
         FROM appointments
         WHERE stylist_id=$1
         AND (start_time AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date = $2::date
         AND status = ANY($3)`,
        [sty.id, date, BLOCKING_STATUSES]
      );
      const candidates = buildSlotsFromRanges(date, effectiveRanges, 15).filter(s => {
        const e = new Date(s.getTime() + duration * 60000);
        return !apptDay.rows.some(a => {
          const S = new Date(a.start_time); const E = new Date(a.end_time);
          return s < E && e > S;
        });
      });
      const withDist = candidates.map(d => ({ d, dist: Math.abs(d.getTime() - wantedStart.getTime()) }))
                                 .sort((a,b)=>a.dist-b.dist);

      const alternos = await findAvailableStylists(tenantId, svc.name, date, time);
      const altStylists = alternos
        .filter(u => u.id !== sty.id)
        .map(u => ({ id: u.id, name: `${u.first_name} ${u.last_name||''}`.trim() }));

      return res.status(200).json({
        service: { id: svc.id, name: svc.name, duration_minutes: duration },
        stylist: { id: sty.id, name: `${sty.first_name} ${sty.last_name||''}`.trim() },
        offers_service: true,
        is_available: false,
        reason: 'Conflicto de horario.',
        suggestions: [...new Set(withDist.slice(0, suggestLimit).map(x => toLocalHHmm(x.d)))],
        alternative_stylists: altStylists
      });
    }

    // ✅ Disponible
    return res.status(200).json({
      service: { id: svc.id, name: svc.name, duration_minutes: duration },
      stylist: { id: sty.id, name: `${sty.first_name} ${sty.last_name||''}`.trim() },
      offers_service: true,
      is_available: true,
      requested: { date, time }
    });

  } catch (e) {
    console.error('verifyStylistServiceAndAvailabilityPublic', e);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// --- NUEVO ENDPOINT PARA N8N ---
exports.agendarCitaConversacional = async (req, res) => {
  try {
    const { appointmentDetails, clientId, tenantId } = req.body;

    if (!appointmentDetails || !clientId || !tenantId) {
      return res.status(400).json({ error: 'Faltan datos obligatorios de n8n.' });
    }
    const { servicio, fecha, hora, estilista } = appointmentDetails;

    let stylistId;
    if (estilista) {
      const stylistRes = await db.query(
        "SELECT id FROM users WHERE tenant_id = $1 AND role_id = 3 AND LOWER(first_name || ' ' || last_name) = LOWER($2)",
        [tenantId, estilista]
      );
      if (stylistRes.rows.length === 0) {
        return res.status(404).json({ error: `Estilista "${estilista}" no encontrado.` });
      }
      stylistId = stylistRes.rows[0].id;
    } else {
      const availableStylists = await findAvailableStylists(tenantId, servicio, fecha, hora);
      if (availableStylists.length === 0) {
        return res.status(200).json({ error: 'No hay estilistas disponibles para esa fecha y hora.' });
      }
      stylistId = availableStylists[0].id;
    }

    const serviceRes = await db.query(
      'SELECT id, duration_minutes FROM services WHERE tenant_id = $1 AND LOWER(name) = LOWER($2)',
      [tenantId, servicio]
    );
    if (serviceRes.rows.length === 0) {
      return res.status(404).json({ error: `Servicio "${servicio}" no encontrado.` });
    }
    const serviceId = serviceRes.rows[0].id;
    const duration = Number(serviceRes.rows[0].duration_minutes) || 60;

    // validar que el estilista ofrezca el servicio
    const skillCheck = await db.query(
      'SELECT 1 FROM stylist_services WHERE user_id = $1 AND service_id = $2',
      [stylistId, serviceId]
    );
    if (skillCheck.rowCount === 0) {
      return res.status(400).json({ error: `El estilista "${estilista}" no ofrece el servicio "${servicio}".` });
    }

    const startTimeDate = makeLocalUtc(fecha, hora);
    const endTimeDate = new Date(startTimeDate.getTime() + duration * 60000);

    const overlap = await db.query(
      `SELECT id FROM appointments
       WHERE stylist_id = $1
         AND status = ANY($4)
         AND (start_time, end_time) OVERLAPS ($2, $3)`,
      [stylistId, startTimeDate, endTimeDate, BLOCKING_STATUSES]
    );
    if (overlap.rowCount > 0) {
      return res.status(409).json({ error: 'Conflicto de horario para el estilista seleccionado.' });
    }

    const result = await db.query(
      `INSERT INTO appointments (tenant_id, client_id, stylist_id, service_id, start_time, end_time, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [tenantId, clientId, stylistId, serviceId, startTimeDate, endTimeDate, 'scheduled']
    );

    const newAppointment = result.rows[0];
    return res.status(201).json({
      success: true,
      message: `¡Tu cita ha sido agendada con éxito con ${estilista || 'un estilista disponible'} para ${formatInTimeZone(startTimeDate, TIME_ZONE, "yyyy-MM-dd 'a las' HH:mm")}!`,
      appointment: newAppointment
    });
  } catch (error) {
    console.error('Error en agendamiento conversacional:', error.message);
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }
};

// --- NUEVO: VERIFICAR DISPONIBILIDAD (ENDPOINT PÚBLICO) ---
exports.checkAvailability = async (req, res) => {
  const { tenantId } = req.params;
  const { servicio, fecha, hora } = req.query;

  if (!servicio || !fecha || !hora) {
    return res.status(400).json({
      error: 'Faltan parámetros: servicio, fecha (YYYY-MM-DD), hora (HH:MM)'
    });
  }

  try {
    const availableStylists = await findAvailableStylists(tenantId, servicio, fecha, hora);

    if (availableStylists.length === 0) {
      return res.status(200).json({
        available: false,
        message: 'No hay estilistas disponibles para esa fecha y hora',
        stylists: []
      });
    }

    return res.status(200).json({
      available: true,
      message: `Hay ${availableStylists.length} estilista(s) disponible(s)`,
      stylists: availableStylists.map(s => ({
        id: s.id,
        name: `${s.first_name} ${s.last_name || ''}`.trim()
      }))
    });
  } catch (error) {
    console.error('Error al verificar disponibilidad:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

exports.createAppointment = async (req, res) => {
  const { stylist_id, service_id, start_time, client_id: clientIdFromRequest } = req.body;
  const { tenant_id, id: clientIdFromToken } = req.user;
  const { dryRun } = req.query;

  const final_client_id = clientIdFromRequest || clientIdFromToken;
  if (!stylist_id || !service_id || !start_time || !final_client_id) {
    return res.status(400).json({ error: 'Faltan campos obligatorios.' });
  }
  try {
    const skillCheck = await db.query(
      'SELECT 1 FROM stylist_services WHERE user_id = $1 AND service_id = $2',
      [stylist_id, service_id]
    );
    if (skillCheck.rowCount === 0) {
      return res.status(400).json({ error: 'El estilista no está cualificado para este servicio.' });
    }
    const duration = await getServiceDurationMinutes(service_id, 60);
    const startTimeDate = new Date(start_time);
    if (isNaN(startTimeDate)) {
      return res.status(400).json({ error: 'start_time inválido. Envíe ISO 8601 con zona o UTC.' });
    }
    const endTimeDate = new Date(startTimeDate.getTime() + duration * 60000);

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
        throw new Error('Cada cita debe tener stylist_id, servicio y start_time.');
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
       JOIN services s    ON a.service_id = s.id
       JOIN users client  ON a.client_id  = client.id
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
      JOIN services s    ON a.service_id = s.id
      JOIN users client  ON a.client_id  = client.id
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

    const tenantResult = await db.query('SELECT working_hours FROM tenants WHERE id = $1', [tenant_id]);
    if (tenantResult.rows.length === 0) {
      return res.status(404).json({ error: 'Tenant no encontrado.' });
    }

    const tenantWorkingHours = tenantResult.rows[0].working_hours || {};
    const tenantDayRanges = getDayRangesFromWorkingHours(tenantWorkingHours, date);
    if (!Array.isArray(tenantDayRanges) || tenantDayRanges.length === 0) {
      return res.status(200).json({ availableSlots: [], availableSlots_meta: [], message: 'El salón no está abierto en esta fecha.' });
    }

    const stylistResult = await db.query(
      'SELECT working_hours FROM users WHERE id = $1 AND role_id = 3 AND tenant_id = $2',
      [stylist_id, tenant_id]
    );
    if (stylistResult.rows.length === 0) {
      return res.status(404).json({ error: 'Estilista no encontrado o no pertenece a este tenant.' });
    }

    const stylistWorkingHours = stylistResult.rows[0].working_hours ?? null;
    const stylistDayRanges = getEffectiveStylistDayRanges(stylistWorkingHours, tenantWorkingHours, date);
    if (!Array.isArray(stylistDayRanges) || stylistDayRanges.length === 0) {
      return res.status(200).json({ availableSlots: [], availableSlots_meta: [], message: 'El estilista no trabaja en esta fecha.' });
    }

    const effectiveDayRanges = intersectRangesArrays(tenantDayRanges, stylistDayRanges);
    if (effectiveDayRanges.length === 0) {
      return res.status(200).json({ availableSlots: [], availableSlots_meta: [], message: 'La hora laboral del estilista no coincide con la del salón.' });
    }

    // Ajuste TZ Bogotá para comparar por día
    const appointmentsResult = await db.query(
      `SELECT start_time, end_time
       FROM appointments
       WHERE stylist_id = $1
         AND (start_time AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date = $2::date
         AND status = ANY($3)`,
      [stylist_id, date, BLOCKING_STATUSES]
    );

    const existingAppointments = appointmentsResult.rows;
    // Slots avanzan en "serviceDuration" para mostrar turnos no traslapados
    const allSlots = buildSlotsFromRanges(date, effectiveDayRanges, serviceDuration);

    const availableSlotsDates = allSlots.filter((slot) => {
      const slotEnd = new Date(slot.getTime() + serviceDuration * 60000);
      return !existingAppointments.some((appt) => {
        const apptStart = new Date(appt.start_time);
        const apptEnd = new Date(appt.end_time);
        return slot < apptEnd && slotEnd > apptStart;
      });
    });

    const availableSlots_meta = availableSlotsDates.map(d => ({
      utc: d.toISOString(),
      local: toLocalISO(d),
      local_time: toLocalHHmm(d),
    }));

    const availableSlotsDisplay = availableSlots_meta.map(s => s.local_time);

    return res.status(200).json({
      availableSlots: availableSlotsDisplay,
      availableSlots_meta
    });
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

  const requestedStartDateTime = makeLocalUtc(date, time);

  try {
    const serviceDuration = await getServiceDurationMinutes(service_id, 60);
    const requestedEndDateTime = new Date(requestedStartDateTime.getTime() + serviceDuration * 60000);

    const tenantResult = await db.query('SELECT working_hours FROM tenants WHERE id = $1', [tenantIdFromToken]);
    if (tenantResult.rows.length === 0) {
      return res.status(404).json({ error: 'Tenant no encontrado.' });
    }

    const tenantWorkingHours = tenantResult.rows[0].working_hours || {};
    const tenantDayRanges = getDayRangesFromWorkingHours(tenantWorkingHours, date);

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

    const stylistsResult = await db.query(
      `SELECT u.id, u.first_name, u.last_name, u.working_hours, ss.last_completed_at, COALESCE(NULLIF(u.status,''),'active') AS status
       FROM users u
       JOIN stylist_services ss ON u.id = ss.user_id
       WHERE u.tenant_id = $1 AND u.role_id = 3 AND ss.service_id = $2
       ORDER BY ss.last_completed_at ASC NULLS FIRST`,
      [tenantIdFromToken, service_id]
    );

    const allPotentialStylists = stylistsResult.rows.filter(r => r.status === 'active');
    const availableStylists = [];

    for (const stylist of allPotentialStylists) {
      const stylistDayRanges = getEffectiveStylistDayRanges(stylist.working_hours ?? null, tenantWorkingHours, date);
      if (!Array.isArray(stylistDayRanges) || stylistDayRanges.length === 0) continue;

      const effectiveRanges = intersectRangesArrays(tenantDayRanges, stylistDayRanges);
      if (effectiveRanges.length === 0) continue; // <-- BUG FIX

      let fitsWorkingRange = isWithinRanges(date, effectiveRanges, requestedStartDateTime, requestedEndDateTime);
      if (!fitsWorkingRange) continue;

      const overlap = await db.query(
        `SELECT id FROM appointments
         WHERE stylist_id = $1
           AND status = ANY($4)
           AND (start_time, end_time) OVERLAPS ($2, $3)
         LIMIT 1`,
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
    const start = makeLocalUtc(date, time);
    const end = new Date(start.getTime() + duration * 60000);

    const tenantResult = await db.query('SELECT working_hours FROM tenants WHERE id = $1', [tenant_id]);
    if (tenantResult.rows.length === 0) {
      return res.status(404).json({ error: 'Tenant no encontrado.' });
    }

    const tenantWorkingHours = tenantResult.rows[0].working_hours || {};
    const tenantRanges = getDayRangesFromWorkingHours(tenantWorkingHours, date);

    const tenantOk = isWithinRanges(date, tenantRanges, start, end);
    if (!tenantOk) {
      return res.status(200).json({ valid: false, reason: 'El salón no está abierto a esa hora.' });
    }

    const stylistRes = await db.query(
      'SELECT working_hours FROM users WHERE id = $1 AND role_id = 3 AND tenant_id = $2',
      [stylist_id, tenant_id]
    );
    if (stylistRes.rows.length === 0) {
      return res.status(404).json({ error: 'Estilista no encontrado o no pertenece al tenant.' });
    }

    const sWH = stylistRes.rows[0].working_hours ?? null;
    const stylistRanges = getEffectiveStylistDayRanges(sWH, tenantWorkingHours, date);
    const effective = intersectRangesArrays(tenantRanges, stylistRanges);

    const stylistOk = isWithinRanges(date, effective, start, end);
    if (!stylistOk) {
      return res.status(200).json({ valid: false, reason: 'El estilista no trabaja a esa hora.' });
    }

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
    await db.query('UPDATE stylist_services SET last_completed_at = NOW() WHERE user_id = $1', [stylist_id]);

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
      return res.status(200).json({ slots: [], slots_meta: [], message: 'El salón está cerrado en esta fecha.' });
    }

    let step;
    if (interval && Number(interval) > 0) {
      step = Number(interval);
    } else {
      step = await getServiceDurationMinutes(service_id, 60);
    }

    const slots = buildSlotsFromRanges(date, tenantRanges, step);

    const slots_meta = slots.map(d => ({
      utc: d.toISOString(),
      local: toLocalISO(d),
      local_time: toLocalHHmm(d),
    }));

    const slotsDisplay = slots_meta.map(s => s.local_time);

    return res.status(200).json({
      slots: slotsDisplay,
      slots_meta
    });
  } catch (error) {
    console.error('Error al obtener slots del tenant:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

exports.getTenantSlotsPublic = async (req, res) => {
  const { tenantId } = req.params;
  const { date, service_id, interval } = req.query;

  if (!date) {
    return res.status(400).json({ error: 'Falta date (YYYY-MM-DD).' });
  }

  try {
    const tenantResult = await db.query('SELECT working_hours FROM tenants WHERE id = $1', [tenantId]);
    if (tenantResult.rows.length === 0) {
      return res.status(404).json({ error: 'Tenant no encontrado.' });
    }

    const tenantWorking = tenantResult.rows[0].working_hours || {};
    const tenantRanges = getDayRangesFromWorkingHours(tenantWorking, date);

    if (!Array.isArray(tenantRanges) || tenantRanges.length === 0) {
      return res.status(200).json({
        slots: [],
        slots_meta: [],
        message: 'El salón está cerrado en esta fecha.'
      });
    }

    let step;
    if (interval && Number(interval) > 0) {
      step = Number(interval);
    } else {
      step = await getServiceDurationMinutes(service_id, 60);
    }

    const slots = buildSlotsFromRanges(date, tenantRanges, step);

    const slots_meta = slots.map(d => ({
      utc: d.toISOString(),
      local: toLocalISO(d),
      local_time: toLocalHHmm(d),
    }));

    const slotsDisplay = slots_meta.map(s => s.local_time);

    return res.status(200).json({
      slots: slotsDisplay,
      slots_meta
    });
  } catch (error) {
    console.error('Error en getTenantSlotsPublic:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// --- NUEVO: AGENDAR CON FALLBACK (no rompe el flujo) ---
exports.scheduleWithFallback = async (req, res) => {
  try {
    const { tenantId, clientId, service, date, time, stylist, limit } = req.body || {};
    const suggestLimit = Math.max(1, parseInt(limit || '6', 10));

    if (!tenantId || !clientId || !service || !date || !time) {
      return res.status(400).json({ error: 'Faltan campos: tenantId, clientId, service, date, time.' });
    }

    // Resolver servicio
    const svcQ = UUID_RE.test(service)
      ? db.query(`SELECT id, name, duration_minutes FROM services WHERE id=$1 AND tenant_id=$2 LIMIT 1`, [service, tenantId])
      : db.query(`SELECT id, name, duration_minutes FROM services WHERE tenant_id=$1 AND LOWER(name)=LOWER($2) LIMIT 1`, [tenantId, service]);
    const svc = (await svcQ).rows[0];
    if (!svc) return res.status(404).json({ error: 'Servicio no encontrado.' });

    const durationBase = Number(svc.duration_minutes) || 60;

    // Si viene estilista específico
    if (stylist) {
      // Resolver estilista
      const styQ = UUID_RE.test(stylist)
        ? db.query(`SELECT id, first_name, last_name, working_hours, status FROM users WHERE id=$1 AND tenant_id=$2 AND role_id=3 LIMIT 1`, [stylist, tenantId])
        : db.query(`
            SELECT id, first_name, last_name, working_hours, status
            FROM users
            WHERE tenant_id=$1 AND role_id=3
              AND LOWER(TRIM(first_name || ' ' || COALESCE(last_name,''))) = LOWER(TRIM($2))
            LIMIT 1`, [tenantId, stylist]);
      const sty = (await styQ).rows[0];
      if (!sty) return res.status(404).json({ error: 'Estilista no encontrado.' });
      if ((sty.status || 'active') !== 'active') {
        return res.status(409).json({ error: 'El estilista no está activo.' });
      }

      // Verificar skill
      const skill = await db.query(`SELECT 1 FROM stylist_services WHERE user_id=$1 AND service_id=$2 LIMIT 1`, [sty.id, svc.id]);
      if (skill.rowCount === 0) {
        return res.status(200).json({
          booked: false,
          reason: 'El estilista no ofrece este servicio.',
          suggestions: [],
          alternative_stylists: []
        });
      }

      // Duración efectiva (override si existe)
      let duration = durationBase;
      if (await hasDurationOverrideColumn()) {
        const over = await db.query(
          `SELECT duration_override_minutes FROM stylist_services WHERE user_id=$1 AND service_id=$2 LIMIT 1`,
          [sty.id, svc.id]
        );
        const d = Number(over.rows[0]?.duration_override_minutes);
        if (Number.isFinite(d) && d > 0) duration = d;
      }

      // Horarios y disponibilidad
      const tRes = await db.query(`SELECT working_hours FROM tenants WHERE id=$1`, [tenantId]);
      if (tRes.rowCount === 0) return res.status(404).json({ error: 'Tenant no encontrado.' });
      const tenantWH = tRes.rows[0].working_hours || {};
      const tenantRanges = getDayRangesFromWorkingHours(tenantWH, date);
      const stylistRanges = getEffectiveStylistDayRanges(sty.working_hours ?? null, tenantWH, date);
      const effectiveRanges = intersectRangesArrays(tenantRanges, stylistRanges);

      const wantedStart = makeLocalUtc(date, time);
      const wantedEnd   = new Date(wantedStart.getTime() + duration * 60000);

      const inRange = effectiveRanges.length > 0 && isWithinRanges(date, effectiveRanges, wantedStart, wantedEnd);

      if (!inRange) {
        const candidates = buildSlotsFromRanges(date, effectiveRanges.length ? effectiveRanges : tenantRanges, 15);
        const withDist = candidates.map(d => ({ d, dist: Math.abs(d.getTime() - wantedStart.getTime()) }))
                                     .sort((a,b)=>a.dist-b.dist);
        return res.status(200).json({
          booked: false,
          reason: 'La hora solicitada está fuera del horario laboral.',
          suggestions: [...new Set(withDist.slice(0, suggestLimit).map(x => toLocalHHmm(x.d)))],
          alternative_stylists: []
        });
      }

      // Conflictos
      const overlap = await db.query(
        `SELECT id FROM appointments
         WHERE stylist_id=$1 AND status=ANY($4) AND (start_time, end_time) OVERLAPS ($2,$3)`,
        [sty.id, wantedStart, wantedEnd, BLOCKING_STATUSES]
      );
      if (overlap.rowCount > 0) {
        const dayAppts = await db.query(
          `SELECT start_time, end_time
           FROM appointments
           WHERE stylist_id=$1
           AND (start_time AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date = $2::date
           AND status = ANY($3)`,
          [sty.id, date, BLOCKING_STATUSES]
        );
        const candidates = buildSlotsFromRanges(date, effectiveRanges, 15).filter(s0 => {
          const e0 = new Date(s0.getTime() + duration * 60000);
          return !dayAppts.rows.some(a => {
            const S = new Date(a.start_time); const E = new Date(a.end_time);
            return s0 < E && e0 > S;
          });
        });
        const withDist = candidates.map(d => ({ d, dist: Math.abs(d.getTime() - wantedStart.getTime()) }))
                                     .sort((a,b)=>a.dist-b.dist);

        const alternos = await findAvailableStylists(tenantId, svc.name, date, time);
        const altStylists = alternos
          .filter(u => u.id !== sty.id)
          .map(u => ({ id: u.id, name: `${u.first_name} ${u.last_name||''}`.trim() }));

        return res.status(200).json({
          booked: false,
          reason: 'Conflicto de horario.',
          suggestions: [...new Set(withDist.slice(0, suggestLimit).map(x => toLocalHHmm(x.d)))],
          alternative_stylists: altStylists
        });
      }

      // ✅ Agenda
      const result = await db.query(
        `INSERT INTO appointments (tenant_id, client_id, stylist_id, service_id, start_time, end_time, status)
         VALUES ($1,$2,$3,$4,$5,$6,'scheduled') RETURNING *`,
        [tenantId, clientId, sty.id, svc.id, wantedStart, wantedEnd]
      );
      return res.status(201).json({ booked: true, appointment: result.rows[0] });
    }

    // Sin estilista: intenta con el primero disponible exacto
    const exactAlternatives = await findAvailableStylists(tenantId, svc.name, date, time);
    if (exactAlternatives.length > 0) {
      const duration = durationBase;
      const start = makeLocalUtc(date, time);
      const end   = new Date(start.getTime() + duration * 60000);
      const styId = exactAlternatives[0].id;
      const result = await db.query(
        `INSERT INTO appointments (tenant_id, client_id, stylist_id, service_id, start_time, end_time, status)
         VALUES ($1,$2,$3,$4,$5,$6,'scheduled') RETURNING *`,
        [tenantId, clientId, styId, svc.id, start, end]
      );
      return res.status(201).json({ booked: true, appointment: result.rows[0] });
    }

    // Nadie libre a esa hora → sugerencias de horas cercanas (y estilistas posibles)
    const tRes = await db.query(`SELECT working_hours FROM tenants WHERE id=$1`, [tenantId]);
    const tenantWH = tRes.rows[0]?.working_hours || {};
    const dayRanges = getDayRangesFromWorkingHours(tenantWH, date);
    const candidates = buildSlotsFromRanges(date, dayRanges, 15);
    const wanted = makeLocalUtc(date, time);

    const scored = [];
    for (const c of candidates) {
      const hh = toLocalHHmm(c);
      const alts = await findAvailableStylists(tenantId, svc.name, date, hh);
      if (alts.length > 0) {
        scored.push({ d: c, dist: Math.abs(c.getTime() - wanted.getTime()), stylists: alts.slice(0,3) });
      }
    }
    scored.sort((a,b)=>a.dist - b.dist);

    return res.status(200).json({
      booked: false,
      reason: 'No hay estilistas disponibles a la hora solicitada.',
      suggestions: [...new Set(scored.slice(0, suggestLimit).map(x => toLocalHHmm(x.d)))],
      alternative_stylists: (scored[0]?.stylists || []).map(s => ({
        id: s.id, name: `${s.first_name} ${s.last_name||''}`.trim()
      }))
    });

  } catch (e) {
    console.error('scheduleWithFallback', e);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// =====================================================================
// AI ORCHESTRATOR PÚBLICO (GET/POST)
// =====================================================================
exports.aiOrchestratorPublic = async (req, res) => {
  try {
    const payload = { ...(req.query || {}), ...(req.body || {}) };

    let {
      action,              // 'orchestrate' | 'agendar' (opcional)
      tenantId,
      clientId,
      service, service_id, selected_service_id,
      stylist, stylist_id, selected_stylist_id,
      date, time,
      confirm,
      limit,
      step
    } = payload;

    action = clean(action) || 'orchestrate';
    if (clean(payload.ai_intent) === 'agendar') action = 'agendar';
    if (String(confirm).toLowerCase() === 'true') action = 'agendar';

    tenantId = clean(tenantId);
    clientId = clean(clientId);
    const suggestLimit = Math.max(1, parseInt(limit || '6', 10));
    const stepMinutes  = Math.max(5, parseInt(step || '15', 10));

    if (!tenantId || !UUID_RE.test(tenantId)) {
      return res.status(400).json({ error: 'Falta tenantId válido (UUID).' });
    }

    // Normalizar fecha/hora humanas
    date = normalizeDateKeyword(clean(date));
    time = normalizeHumanTimeToHHMM(cleanHHMM(time));

    // 1) Resolver SERVICIO (difuso o id)
    const svc = await resolveServiceFuzzy(tenantId, { service, service_id, selected_service_id }, 10);
    let chosenService = svc.chosen; // {id,name,duration_minutes}
    const serviceOptions = svc.options || [];

    // 2) Resolver ESTILISTA (difuso o id)
    const sty = await resolveStylistFuzzy(tenantId, { stylist, stylist_id, selected_stylist_id }, 10);
    let chosenStylist = sty.chosen; // {..., name}
    const stylistOptions = sty.options || [];

    // Desambiguación
    const need = {
      service: !chosenService && serviceOptions.length > 0,
      stylist: !chosenStylist && stylistOptions.length > 0
    };
    if (need.service || need.stylist) {
      return res.status(200).json({
        status: 'disambiguation_needed',
        message: 'Encontré múltiples coincidencias. Por favor elige una opción.',
        need,
        options: {
          services: serviceOptions.map(s => ({
            id: s.id, name: s.name, duration_minutes: Number(s.duration_minutes) || null
          })),
          stylists: stylistOptions.map(u => ({
            id: u.id, name: u.name
          }))
        },
        next: 'Envía selected_service_id y/o selected_stylist_id en el siguiente request.'
      });
    }

    if (!chosenService && clean(service)) {
      return res.status(200).json({
        status: 'no_match_service',
        message: `No encontré un servicio que coincida con "${service}".`,
        suggestions: []
      });
    }
    if (!chosenStylist && clean(stylist)) {
      return res.status(200).json({
        status: 'no_match_stylist',
        message: `No encontré un estilista que coincida con "${stylist}".`,
        suggestions: []
      });
    }

    if (!chosenService) {
      return res.status(200).json({
        status: 'need_service',
        message: '¿Qué servicio deseas?',
        options_hint: 'Envía service por nombre o selected_service_id.'
      });
    }

    // --- INICIO DE LÓGICA BIFURCADA ---
    if (chosenStylist) {
      // --- CAMINO A: ESTILISTA ESPECÍFICO ---

      // 3) Validar que el estilista ofrezca el servicio y obtener duración efectiva
      const skill = await db.query(
        `SELECT 1 FROM stylist_services WHERE user_id=$1 AND service_id=$2 LIMIT 1`,
        [chosenStylist.id, chosenService.id]
      );
      if (skill.rowCount === 0) {
        const alternosBase = await db.query(
          `SELECT u.id, u.first_name, u.last_name
           FROM users u
           JOIN stylist_services ss ON u.id = ss.user_id
           WHERE u.tenant_id=$1 AND u.role_id=3 AND COALESCE(NULLIF(u.status,''),'active')='active'
             AND ss.service_id=$2`,
          [tenantId, chosenService.id]
        );
        const alt = alternosBase.rows
          .filter(u => u.id !== chosenStylist.id)
          .map(u => ({ id: u.id, name: `${u.first_name} ${u.last_name || ''}`.trim() }));

        return res.status(200).json({
          status: 'stylist_not_offering_service',
          message: `El/la estilista ${chosenStylist.name} no ofrece "${chosenService.name}".`,
          alternative_stylists: alt.slice(0, suggestLimit),
          next: 'Elige un estilista alterno o cambia el servicio.'
        });
      }

      // duración (override por estilista si existe)
      let duration = Number(chosenService.duration_minutes) || 60;
      if (await hasDurationOverrideColumn()) {
        const over = await db.query(
          `SELECT duration_override_minutes FROM stylist_services WHERE user_id=$1 AND service_id=$2 LIMIT 1`,
          [chosenStylist.id, chosenService.id]
        );
        const d = Number(over.rows[0]?.duration_override_minutes);
        if (Number.isFinite(d) && d > 0) duration = d;
      }

      // 4) Validar horarios del salón y del estilista para la fecha
      if (!date) {
        return res.status(200).json({
          status: 'need_date',
          message: '¿Para qué fecha quieres agendar?',
          hint: 'Puedes enviar "hoy" / "mañana" o YYYY-MM-DD.'
        });
      }

      const tRes = await db.query(`SELECT working_hours FROM tenants WHERE id=$1`, [tenantId]);
      if (tRes.rowCount === 0) return res.status(404).json({ error: 'Tenant no encontrado.' });
      const tenantWH = tRes.rows[0].working_hours || {};
      const tenantRanges = getDayRangesFromWorkingHours(tenantWH, date);
      if (!tenantRanges.length) {
        return res.status(200).json({
          status: 'tenant_closed',
          message: 'El salón está cerrado ese día.',
          suggestions: []
        });
      }

      const stylistRanges = getEffectiveStylistDayRanges(chosenStylist.working_hours ?? null, tenantWH, date);
      if (!stylistRanges.length) {
        return res.status(200).json({
          status: 'stylist_off',
          message: `El/la estilista ${chosenStylist.name} no trabaja ese día.`,
          suggestions: []
        });
      }

      const effectiveRanges = intersectRangesArrays(tenantRanges, stylistRanges);
      if (!effectiveRanges.length) {
        return res.status(200).json({
          status: 'no_overlap_hours',
          message: 'El horario del estilista no coincide con el del salón ese día.',
          suggestions: []
        });
      }

      // 5) Generar disponibilidad del día y filtrar por citas
      const apptRes = await db.query(
        `SELECT start_time, end_time
         FROM appointments
         WHERE stylist_id=$1
           AND (start_time AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date = $2::date
           AND status = ANY($3)`,
        [chosenStylist.id, date, BLOCKING_STATUSES]
      );

      const candidateStarts = buildSlotsFromRanges(date, effectiveRanges, stepMinutes);
      const availableSlots = candidateStarts.filter(start => {
        const end = new Date(start.getTime() + duration * 60000);
        return !apptRes.rows.some(a => {
          const s = new Date(a.start_time);
          const e = new Date(a.end_time);
          return start < e && end > s;
        });
      });

      const allLocalTimes = availableSlots.map(toLocalHHmm);

      // Si no mandó hora => que elija una (primeras sugerencias)
      if (!time) {
        return res.status(200).json({
          status: 'choose_time',
          message: 'Estos son los horarios disponibles para ese día:',
          suggestions: allLocalTimes.slice(0, suggestLimit),
          slots_all: allLocalTimes.slice(0, 48),
          next: 'Envía time con una de las opciones.'
        });
      }

      // 6) Con hora pedida: verificar disponibilidad exacta o sugerir cercanos
      const wanted = String(time).slice(0, 5); // HH:mm
      const isAvailable = allLocalTimes.includes(wanted);

      if (!isAvailable) {
        const wantedDate = makeLocalUtc(date, wanted);
        const withDist = availableSlots.map(d => ({ d, dist: Math.abs(d.getTime() - wantedDate.getTime()) }))
                                       .sort((a,b)=>a.dist - b.dist);

        const alternos = await findAvailableStylists(tenantId, chosenService.name, date, wanted);
        const altStylists = alternos
          .filter(u => u.id !== chosenStylist.id)
          .map(u => ({ id: u.id, name: `${u.first_name} ${u.last_name||''}`.trim() }));

        return res.status(200).json({
          status: 'choose_time',
          message: `A las ${wanted} no tiene disponibilidad ${chosenStylist.name} para ${chosenService.name}.`,
          suggestions: [...new Set(withDist.slice(0, suggestLimit).map(x => toLocalHHmm(x.d)))],
          slots_all: allLocalTimes.slice(0, 48),
          alternative_stylists: altStylists,
          next: 'Elige una de las horas sugeridas o un estilista alterno.'
        });
      }

      // 7) Disponible exacto → confirmar o agendar
      const startTimeDate = makeLocalUtc(date, wanted);
      const endTimeDate = new Date(startTimeDate.getTime() + duration * 60000);

      if (action === 'agendar') {
        if (!clientId) {
          return res.status(400).json({ error: 'Para agendar se requiere clientId.' });
        }

        // última validación de overlap (carrera)
        const overlap = await db.query(
          `SELECT id FROM appointments
           WHERE stylist_id=$1 AND status=ANY($4) AND (start_time, end_time) OVERLAPS ($2,$3)`,
          [chosenStylist.id, startTimeDate, endTimeDate, BLOCKING_STATUSES]
        );
        if (overlap.rowCount > 0) {
          return res.status(409).json({
            status: 'conflict_race',
            message: 'Se ocupó el turno mientras confirmabas. Elige otra hora.',
            suggestions: allLocalTimes.slice(0, suggestLimit)
          });
        }

        const ins = await db.query(
          `INSERT INTO appointments (tenant_id, client_id, stylist_id, service_id, start_time, end_time, status)
           VALUES ($1,$2,$3,$4,$5,$6,'scheduled')
           RETURNING *`,
          [tenantId, clientId, chosenStylist.id, chosenService.id, startTimeDate, endTimeDate]
        );

        return res.status(201).json({
          status: 'booked',
          message: `¡Listo! Tu cita quedó con ${chosenStylist.name} el ${formatInTimeZone(startTimeDate, TIME_ZONE, 'yyyy-MM-dd')} a las ${formatInTimeZone(startTimeDate, TIME_ZONE, 'HH:mm')}.`,
          appointment: ins.rows[0]
        });
      }

      return res.status(200).json({
        status: 'confirm',
        summary: {
          service: { id: chosenService.id, name: chosenService.name, duration_minutes: duration },
          stylist: { id: chosenStylist.id, name: chosenStylist.name },
          date: date,
          time: wanted,
          timezone: TIME_ZONE
        },
        message: '¿Confirmas que agende esta cita?',
        next: 'Reenvía este mismo payload añadiendo "confirm": true o "action": "agendar"'
      });

      // --- FIN CAMINO A ---

    } else {
      // --- CAMINO B: "BUSCAR CUALQUIERA" ---
      if (!date) {
        return res.status(200).json({
          status: 'need_date',
          message: '¿Para qué fecha quieres agendar?',
          hint: 'Puedes enviar "hoy" / "mañana" o YYYY-MM-DD.'
        });
      }
      if (!time) {
        return res.status(200).json({
          status: 'need_time',
          message: '¿Y a qué hora te gustaría?',
          hint: 'Puedes enviar "2 pm", "14:30", etc.'
        });
      }

      const availableStylists = await findAvailableStylists(tenantId, chosenService.name, date, time);

      if (availableStylists.length === 0) {
        return res.status(200).json({
          status: 'no_stylist_available_at_time',
          message: `Lo siento, no encontré estilistas disponibles para "${chosenService.name}" a las ${time} ese día.`,
          suggestions: [],
          alternative_stylists: []
        });
      }

      const firstAvailable = availableStylists[0];
      chosenStylist = {
        ...firstAvailable,
        name: `${firstAvailable.first_name} ${firstAvailable.last_name || ''}`.trim()
      };

      // Duración (con override si aplica)
      let duration = Number(chosenService.duration_minutes) || 60;
      if (await hasDurationOverrideColumn()) {
        const over = await db.query(
          `SELECT duration_override_minutes FROM stylist_services WHERE user_id=$1 AND service_id=$2 LIMIT 1`,
          [chosenStylist.id, chosenService.id]
        );
        const d = Number(over.rows[0]?.duration_override_minutes);
        if (Number.isFinite(d) && d > 0) duration = d;
      }

      const startTimeDate = makeLocalUtc(date, time);
      const endTimeDate = new Date(startTimeDate.getTime() + duration * 60000);
      const wanted = String(time).slice(0, 5);

      if (action === 'agendar') {
        if (!clientId) {
          return res.status(400).json({ error: 'Para agendar se requiere clientId.' });
        }
        const overlap = await db.query(
          `SELECT id FROM appointments
           WHERE stylist_id=$1 AND status=ANY($4) AND (start_time, end_time) OVERLAPS ($2,$3)`,
          [chosenStylist.id, startTimeDate, endTimeDate, BLOCKING_STATUSES]
        );
        if (overlap.rowCount > 0) {
          return res.status(409).json({
            status: 'conflict_race',
            message: '¡Uy! Justo se ocupó ese turno mientras confirmabas. ¿Intentamos de nuevo?',
          });
        }

        const ins = await db.query(
          `INSERT INTO appointments (tenant_id, client_id, stylist_id, service_id, start_time, end_time, status)
           VALUES ($1,$2,$3,$4,$5,$6,'scheduled')
           RETURNING *`,
          [tenantId, clientId, chosenStylist.id, chosenService.id, startTimeDate, endTimeDate]
        );

        return res.status(201).json({
          status: 'booked',
          message: `¡Listo! Tu cita quedó con ${chosenStylist.name} el ${formatInTimeZone(startTimeDate, TIME_ZONE, 'yyyy-MM-dd')} a las ${formatInTimeZone(startTimeDate, TIME_ZONE, 'HH:mm')}.`,
          appointment: ins.rows[0]
        });
      }

      return res.status(200).json({
        status: 'confirm',
        summary: {
          service: { id: chosenService.id, name: chosenService.name, duration_minutes: duration },
          stylist: { id: chosenStylist.id, name: chosenStylist.name },
          date: date,
          time: wanted,
          timezone: TIME_ZONE
        },
        message: `Encontré disponibilidad con ${chosenStylist.name} para esa hora. ¿Confirmas que agende esta cita?`,
        next: 'Reenvía este mismo payload añadiendo "confirm": true o "action": "agendar"'
      });
    }
    // --- FIN CAMINO B ---

  } catch (e) {
    console.error('aiOrchestratorPublic', e);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// =====================================================================
// (Opcional) AI ORCHESTRATOR clásico
// =====================================================================
exports.aiOrchestrator = async (req, res) => {
  try {
    const method = req.method.toUpperCase();
    const src = method === 'GET' ? req.query : req.body;

    let tenantId = clean(src.tenantId || src.tenant_id || '');
    let clientId = src.clientId || src.client_id || null;

    let intent = clean((src.ai_intent || src.intent || '').toLowerCase());
    let ai_service = clean(src.ai_service || src.service || '');
    let ai_stylist = clean(src.ai_stylist || src.stylist || '');
    let ai_date    = clean(src.ai_date || src.date || '');
    let ai_time    = cleanHHMM(src.ai_time || src.time || '');

    const suggestLimit = Math.max(1, parseInt(src.limit || '6', 10));

    if (!tenantId || !UUID_RE.test(tenantId)) {
      return res.status(400).json({ ok: false, error: 'tenantId inválido o faltante.' });
    }

    if (method === 'GET') {
      if (intent === 'listar_servicios') {
        const r = await db.query(
          `SELECT id, name, duration_minutes
           FROM services
           WHERE tenant_id = $1
           ORDER BY name ASC`, [tenantId]
        );
        return res.status(200).json({
          ok: true,
          intent: 'listar_servicios',
          total: r.rowCount,
          services: r.rows
        });
      }

      if (intent === 'listar_estilistas') {
        const r = await db.query(
          `SELECT id, first_name, last_name
           FROM users
           WHERE tenant_id = $1
             AND role_id = 3
             AND COALESCE(NULLIF(status,''),'active')='active'
           ORDER BY first_name ASC, last_name ASC`,
          [tenantId]
        );
        return res.status(200).json({
          ok: true,
          intent: 'listar_estilistas',
          total: r.rowCount,
          stylists: r.rows.map(u => ({ id: u.id, name: `${u.first_name} ${u.last_name||''}`.trim() }))
        });
      }

      if (intent === 'validar' || (ai_service && ai_stylist && ai_date)) {
        const svcQ = UUID_RE.test(ai_service)
          ? db.query(`SELECT id, name, duration_minutes FROM services WHERE id=$1 AND tenant_id=$2 LIMIT 1`, [ai_service, tenantId])
          : db.query(`SELECT id, name, duration_minutes FROM services WHERE tenant_id=$1 AND LOWER(name)=LOWER($2) LIMIT 1`, [tenantId, ai_service]);
        const svc = (await svcQ).rows[0];
        if (!svc) return res.status(404).json({ ok:false, error: 'Servicio no encontrado.' });

        const styQ = UUID_RE.test(ai_stylist)
          ? db.query(`SELECT id, first_name, last_name, working_hours, status FROM users WHERE id=$1 AND tenant_id=$2 AND role_id=3 LIMIT 1`, [ai_stylist, tenantId])
          : db.query(`
              SELECT id, first_name, last_name, working_hours, status
              FROM users
              WHERE tenant_id=$1 AND role_id=3
                AND LOWER(TRIM(first_name || ' ' || COALESCE(last_name,''))) = LOWER(TRIM($2))
              LIMIT 1`, [tenantId, ai_stylist]);
        const sty = (await styQ).rows[0];
        if (!sty) return res.status(404).json({ ok:false, error: 'Estilista no encontrado.' });
        if ((sty.status || 'active') !== 'active') {
          return res.status(409).json({ ok:false, error: 'El estilista no está activo.' });
        }

        const skill = await db.query(`SELECT 1 FROM stylist_services WHERE user_id=$1 AND service_id=$2 LIMIT 1`, [sty.id, svc.id]);
        if (skill.rowCount === 0) {
          let alternatives = [];
          if (ai_date && ai_time) {
            const alts = await findAvailableStylists(tenantId, svc.name, ai_date, ai_time);
            alternatives = alts
              .filter(u => u.id !== sty.id)
              .map(u => ({ id: u.id, name: `${u.first_name} ${u.last_name||''}`.trim() }));
          } else {
            const alts = await db.query(
              `SELECT u.id, u.first_name, u.last_name
               FROM users u
               JOIN stylist_services ss ON u.id = ss.user_id
               WHERE u.tenant_id=$1 AND u.role_id=3
                 AND COALESCE(NULLIF(u.status,''),'active')='active'
                 AND ss.service_id=$2
               ORDER BY u.first_name ASC`,
              [tenantId, svc.id]
            );
            alternatives = alts.rows
              .filter(u => u.id !== sty.id)
              .map(u => ({ id: u.id, name: `${u.first_name} ${u.last_name||''}`.trim() }));
          }

          return res.status(200).json({
            ok: true,
            intent: 'validar',
            service: { id: svc.id, name: svc.name },
            stylist: { id: sty.id, name: `${sty.first_name} ${sty.last_name||''}`.trim() },
            offers_service: false,
            is_available: false,
            reason: 'El estilista no ofrece este servicio.',
            alternative_stylists: alternatives
          });
        }

        const tRes = await db.query(`SELECT working_hours FROM tenants WHERE id=$1`, [tenantId]);
        if (tRes.rowCount === 0) return res.status(404).json({ ok:false, error: 'Tenant no encontrado.' });
        const tenantWH = tRes.rows[0].working_hours || {};
        const tenantRanges = getDayRangesFromWorkingHours(tenantWH, ai_date);
        if (!tenantRanges.length) {
          return res.status(200).json({
            ok: true,
            intent: 'validar',
            service: { id: svc.id, name: svc.name },
            stylist: { id: sty.id, name: `${sty.first_name} ${sty.last_name||''}`.trim() },
            offers_service: true,
            is_available: false,
            reason: 'El salón está cerrado ese día.',
            suggestions: []
          });
        }
        const stylistRanges = getEffectiveStylistDayRanges(sty.working_hours ?? null, tenantWH, ai_date);
        if (!stylistRanges.length) {
          return res.status(200).json({
            ok: true,
            intent: 'validar',
            service: { id: svc.id, name: svc.name },
            stylist: { id: sty.id, name: `${sty.first_name} ${sty.last_name||''}`.trim() },
            offers_service: true,
            is_available: false,
            reason: 'El estilista no trabaja ese día.',
            suggestions: []
          });
        }
        const effectiveRanges = intersectRangesArrays(tenantRanges, stylistRanges);
        if (!effectiveRanges.length) {
          return res.status(200).json({
            ok: true,
            intent: 'validar',
            service: { id: svc.id, name: svc.name },
            stylist: { id: sty.id, name: `${sty.first_name} ${sty.last_name||''}`.trim() },
            offers_service: true,
            is_available: false,
            reason: 'El horario del estilista no coincide con el del salón.',
            suggestions: []
          });
        }

        let duration = Number(svc.duration_minutes) || 60;
        if (await hasDurationOverrideColumn()) {
          const over = await db.query(
            `SELECT duration_override_minutes FROM stylist_services WHERE user_id=$1 AND service_id=$2 LIMIT 1`,
            [sty.id, svc.id]
          );
          const d = Number(over.rows[0]?.duration_override_minutes);
          if (Number.isFinite(d) && d > 0) duration = d;
        }

        const step = 15;
        const candidatesAll = buildSlotsFromRanges(ai_date, effectiveRanges, step);
        const toHH = toLocalHHmm;

        if (!ai_time) {
          const dayFree = await db.query(
            `SELECT start_time, end_time
             FROM appointments
             WHERE stylist_id=$1
               AND (start_time AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date = $2::date
               AND status = ANY($3)`,
            [sty.id, ai_date, BLOCKING_STATUSES]
          );
          const free = candidatesAll.filter(s0 => {
            const e0 = new Date(s0.getTime() + duration * 60000);
            return !dayFree.rows.some(a => {
              const S = new Date(a.start_time); const E = new Date(a.end_time);
              return s0 < E && e0 > S;
            });
          });
          return res.status(200).json({
            ok: true,
            intent: 'validar',
            service: { id: svc.id, name: svc.name, duration_minutes: duration },
            stylist: { id: sty.id, name: `${sty.first_name} ${sty.last_name||''}`.trim() },
            offers_service: true,
            is_available: false,
            reason: 'No se proporcionó hora, mostrando opciones.',
            suggestions: free.slice(0, suggestLimit).map(toHH),
            slots_all: free.map(toHH).slice(0, 48)
          });
        }

        const wantedStart = makeLocalUtc(ai_date, ai_time);
        const wantedEnd   = new Date(wantedStart.getTime() + duration * 60000);

        const inRange = isWithinRanges(ai_date, effectiveRanges, wantedStart, wantedEnd);
        if (!inRange) {
          const withDist = candidatesAll.map(d => ({ d, dist: Math.abs(d.getTime() - wantedStart.getTime()) }))
                                         .sort((a,b)=>a.dist-b.dist);
          return res.status(200).json({
            ok: true,
            intent: 'validar',
            service: { id: svc.id, name: svc.name, duration_minutes: duration },
            stylist: { id: sty.id, name: `${sty.first_name} ${sty.last_name||''}`.trim() },
            offers_service: true,
            is_available: false,
            reason: 'La hora solicitada está fuera del horario laboral.',
            suggestions: [...new Set(withDist.slice(0, suggestLimit).map(x => toLocalHHmm(x.d)))]
          });
        }

        const overlap = await db.query(
          `SELECT id FROM appointments
           WHERE stylist_id=$1 AND status=ANY($4) AND (start_time, end_time) OVERLAPS ($2,$3)`,
          [sty.id, wantedStart, wantedEnd, BLOCKING_STATUSES]
        );
        if (overlap.rowCount > 0) {
          const dayAppts = await db.query(
            `SELECT start_time, end_time
             FROM appointments
             WHERE stylist_id=$1
             AND (start_time AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date = $2::date
             AND status = ANY($3)`,
            [sty.id, ai_date, BLOCKING_STATUSES]
          );
          const free = candidatesAll.filter(s0 => {
            const e0 = new Date(s0.getTime() + duration * 60000);
            return !dayAppts.rows.some(a => {
              const S = new Date(a.start_time); const E = new Date(a.end_time);
              return s0 < E && e0 > S;
            });
          });
          const withDist = free.map(d => ({ d, dist: Math.abs(d.getTime() - wantedStart.getTime()) }))
                                   .sort((a,b)=>a.dist-b.dist);

          const alternos = await findAvailableStylists(tenantId, svc.name, ai_date, ai_time);
          const altStylists = alternos
            .filter(u => u.id !== sty.id)
            .map(u => ({ id: u.id, name: `${u.first_name} ${u.last_name||''}`.trim() }));

          return res.status(200).json({
            ok: true,
            intent: 'validar',
            service: { id: svc.id, name: svc.name, duration_minutes: duration },
            stylist: { id: sty.id, name: `${sty.first_name} ${sty.last_name||''}`.trim() },
            offers_service: true,
            is_available: false,
            reason: 'Conflicto de horario.',
            suggestions: [...new Set(withDist.slice(0, suggestLimit).map(x => toLocalHHmm(x.d)))],
            alternative_stylists: altStylists
          });
        }

        // ✅ Disponible exacto
        return res.status(200).json({
          ok: true,
          intent: 'validar',
          service: { id: svc.id, name: svc.name, duration_minutes: duration },
          stylist: { id: sty.id, name: `${sty.first_name} ${sty.last_name||''}`.trim() },
          offers_service: true,
          is_available: true,
          requested: { date: ai_date, time: ai_time }
        });
      }

      return res.status(400).json({ ok:false, error: 'Intención GET no reconocida.' });
    }

    if (method === 'POST') {
      if (!intent) intent = 'agendar';
      if (intent !== 'agendar') {
        return res.status(400).json({ ok:false, error: 'Para POST, use ai_intent=agendar.' });
      }
      if (!clientId) return res.status(400).json({ ok:false, error: 'Falta clientId para agendar.' });
      if (!ai_service || !ai_date || !ai_time) {
        return res.status(400).json({ ok:false, error: 'Faltan campos: service/date/time.' });
      }

      req.body = {
        tenantId,
        clientId,
        service: ai_service,
        date: ai_date,
        time: ai_time,
        stylist: ai_stylist || undefined,
        limit: suggestLimit
      };
      return exports.scheduleWithFallback(req, res);
    }

    return res.status(405).json({ ok:false, error:'Método no permitido.' });

  } catch (err) {
    console.error('aiOrchestrator', err);
    return res.status(500).json({ ok:false, error:'Error interno del servidor' });
  }
};
