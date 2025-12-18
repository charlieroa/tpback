// src/controllers/appointmentController.js
'use strict';

const db = require('../config/db');
const { formatInTimeZone } = require('date-fns-tz');
const {
  TIME_ZONE,
  BLOCKING_STATUSES,
  UUID_RE,
  clean,
  cleanHHMM,
  makeLocalUtc,
  toLocalHHmm,
  toLocalISO,
  normalizeDateKeyword,
  normalizeHumanTimeToHHMM,
  getDayRangesFromWorkingHours,
  getEffectiveStylistDayRanges,
  intersectRangesArrays,
  isWithinRanges,
  buildSlotsFromRanges,
} = require('../utils/appointmentHelpers');

const {
  getServiceDurationMinutes,
  resolveServiceFuzzy,
  resolveStylistFuzzy,
  findAvailableStylists,
  getStylistEffectiveDuration,
  checkStylistOffersService,
  getAvailableSlotsForStylist,
  createAppointmentRecord,
} = require('../services/appointmentService');

/* =================================================================== */
/* ==============   FILTRO DE HORARIOS PASADOS   ===================== */
/* =================================================================== */

/**
 * Filtra slots que ya pasaron (solo para el día actual)
 * @param {Date[]} slots - Array de slots UTC
 * @param {string} dateStr - Fecha en formato YYYY-MM-DD
 * @returns {Date[]} - Slots filtrados (sin horarios pasados)
 */
const filterPastSlots = (slots, dateStr) => {
  const now = new Date();
  const today = formatInTimeZone(now, TIME_ZONE, 'yyyy-MM-dd');

  // Si la fecha no es hoy, devolver todos los slots
  if (dateStr !== today) {
    return slots;
  }

  // Si es hoy, filtrar solo los slots futuros (con margen de 5 minutos)
  const nowWithBuffer = new Date(now.getTime() + 5 * 60000); // +5 minutos

  const filtered = slots.filter(slot => slot >= nowWithBuffer);

  console.log(`🕐 [filterPastSlots] Filtrando slots para hoy (${dateStr})`);
  console.log(`   Hora actual + buffer: ${nowWithBuffer.toISOString()}`);
  console.log(`   Slots totales: ${slots.length}, Slots futuros: ${filtered.length}`);

  return filtered;
};

/* =================================================================== */
/* ==============   SOPORTE PARA CITAS EN EL PASADO   ================= */
/* =================================================================== */

/** Retorna true si dateTime está en el pasado respecto a ahora */
const isDateInPast = (dateTime) => {
  const now = new Date();
  const target = new Date(dateTime);

  // Validar que la fecha sea válida
  if (isNaN(target.getTime())) {
    console.log('⚠️ [isDateInPast] Fecha inválida:', dateTime);
    return false;
  }

  const isPast = target < now;

  console.log('🕐 [isDateInPast] Comparación de fechas:');
  console.log('   Ahora (now):', now.toISOString());
  console.log('   Target:', target.toISOString());
  console.log('   ¿Es pasado?:', isPast);

  return isPast;
};

/** Lee allow_past_appointments del tenant en DB (fail-safe: false) */
const getAllowPastAppointments = async (tenantId) => {
  try {
    console.log('='.repeat(60));
    console.log('🔍 [DEBUG 1] Consultando allow_past_appointments');
    console.log('   TenantId recibido:', tenantId);
    console.log('   Tipo de tenantId:', typeof tenantId);

    const result = await db.query(
      'SELECT allow_past_appointments FROM tenants WHERE id = $1',
      [tenantId]
    );

    console.log('🔍 [DEBUG 2] Resultado de la consulta:');
    console.log('   Filas encontradas:', result.rows.length);
    console.log('   Datos completos:', JSON.stringify(result.rows, null, 2));

    if (result.rows.length === 0) {
      console.log('⚠️ [DEBUG 3] NO SE ENCONTRÓ EL TENANT EN LA DB');
      console.log('='.repeat(60));
      return false;
    }

    const rawValue = result.rows[0].allow_past_appointments;
    const finalValue = rawValue ?? false;

    console.log('🔍 [DEBUG 3] Procesando valor:');
    console.log('   Valor crudo (raw):', rawValue);
    console.log('   Tipo del valor:', typeof rawValue);
    console.log('   Valor final:', finalValue);
    console.log('   Tipo final:', typeof finalValue);
    console.log('='.repeat(60));

    return finalValue;
  } catch (error) {
    console.error('❌ [DEBUG ERROR] Error al obtener allow_past_appointments:', error);
    console.log('='.repeat(60));
    return false;
  }
};

/** Lanza error si la fecha/hora está en pasado y el tenant no lo permite */
const validatePastAppointment = async (tenantId, startTime) => {
  console.log('\n' + '█'.repeat(60));
  console.log('🔍 [VALIDACIÓN] Iniciando validación de cita en pasado');
  console.log('   TenantId:', tenantId);
  console.log('   StartTime:', startTime);
  console.log('   StartTime ISO:', startTime.toISOString ? startTime.toISOString() : 'No es Date');

  const now = new Date();
  const isPast = isDateInPast(startTime);

  console.log('   Fecha actual:', now.toISOString());
  console.log('   ¿Es fecha pasada?:', isPast);

  const allowPast = await getAllowPastAppointments(tenantId);

  console.log('   Allow past desde DB:', allowPast);
  console.log('   Tipo de allowPast:', typeof allowPast);
  console.log('   !allowPast:', !allowPast);
  console.log('   Condición (!allowPast && isPast):', (!allowPast && isPast));

  if (!allowPast && isPast) {
    console.log('❌ [VALIDACIÓN] RECHAZANDO CITA - Fecha en pasado y flag deshabilitado');
    console.log('█'.repeat(60) + '\n');
    throw new Error(
      'No se pueden crear citas en fechas u horas pasadas. Contacta al administrador si necesitas habilitarlo.'
    );
  }

  console.log('✅ [VALIDACIÓN] CITA APROBADA');
  console.log('█'.repeat(60) + '\n');
};

/* =================================================================== */
/* ==============   NUEVA FUNCIÓN: LISTAR SERVICIOS DE ESTILISTA   === */
/* =================================================================== */

/**
 * Obtiene los servicios que ofrece un estilista específico
 * @param {string} stylistId - ID del estilista
 * @returns {Promise<Array>} - Array de servicios con id, name, duration_minutes
 */
const getStylistServices = async (stylistId) => {
  try {
    const result = await db.query(
      `SELECT s.id, s.name, s.duration_minutes
       FROM services s
       INNER JOIN stylist_services ss ON s.id = ss.service_id
       WHERE ss.user_id = $1
       ORDER BY s.name ASC`,
      [stylistId]
    );

    return result.rows;
  } catch (error) {
    console.error('Error al obtener servicios del estilista:', error);
    return [];
  }
};

/* =================================================================== */
/* ==============   EXPORTS UTILES PARA ORCHESTRATOR    ============== */
/* =================================================================== */

exports.normalizeDateKeyword = normalizeDateKeyword;
exports.normalizeHumanTimeToHHMM = normalizeHumanTimeToHHMM;
exports.resolveServiceFuzzy = resolveServiceFuzzy;
exports.resolveStylistFuzzy = resolveStylistFuzzy;

/* =================================================================== */
/* =====================  ENDPOINTS PÚBLICOS (NUEVOS)  =============== */
/* =================================================================== */
/**
 * 1️⃣ Buscar Estilista (público)
 * GET /api/appointments/stylists/search-public?tenantId={UUID}&query=carlos
 */
exports.searchStylistsPublic = async (req, res) => {
  try {
    let { tenantId, query } = req.query;
    tenantId = clean(tenantId);
    query = clean(query);

    if (!tenantId || !UUID_RE.test(tenantId)) {
      return res.status(400).json({ error: 'tenantId inválido o faltante (UUID).' });
    }
    if (!query) {
      return res.status(400).json({ error: 'Falta query.' });
    }

    const q = `%${query.toLowerCase()}%`;

    const result = await db.query(
      `SELECT id, first_name, last_name, COALESCE(NULLIF(status,''),'active') AS status
       FROM users
       WHERE tenant_id = $1
         AND role_id = 3
         AND COALESCE(NULLIF(status,''),'active') IN ('active') 
         AND (
              LOWER(first_name) ILIKE $2
           OR LOWER(COALESCE(last_name,'')) ILIKE $2
           OR LOWER(TRIM(first_name || ' ' || COALESCE(last_name,''))) ILIKE $2
         )
       ORDER BY first_name ASC, last_name ASC
       LIMIT 25`,
      [tenantId, q]
    );

    const stylists = result.rows.map(u => ({
      id: u.id,
      name: `${u.first_name} ${u.last_name || ''}`.trim(),
      status: u.status
    }));

    return res.status(200).json({
      query,
      total: stylists.length,
      stylists
    });
  } catch (e) {
    console.error('searchStylistsPublic', e);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/**
 * 2️⃣ Servicios del Estilista (público)
 * GET /api/appointments/stylists/:stylistId/services-public?tenantId={UUID}
 */
exports.getStylistServicesPublic = async (req, res) => {
  try {
    const { stylistId } = req.params;
    let { tenantId } = req.query;

    tenantId = clean(tenantId);

    if (!tenantId || !UUID_RE.test(tenantId)) {
      return res.status(400).json({ error: 'tenantId inválido o faltante (UUID).' });
    }
    if (!stylistId || !UUID_RE.test(stylistId)) {
      return res.status(400).json({ error: 'stylistId inválido (UUID).' });
    }

    const sty = await db.query(
      `SELECT id, first_name, last_name, role_id, tenant_id, COALESCE(NULLIF(status,''),'active') AS status
       FROM users
       WHERE id = $1 AND tenant_id = $2 AND role_id = 3
       LIMIT 1`,
      [stylistId, tenantId]
    );

    if (sty.rows.length === 0) {
      return res.status(404).json({ error: 'Estilista no encontrado para ese tenant.' });
    }
    if (sty.rows[0].status !== 'active') {
      return res.status(409).json({ error: 'El estilista no está activo.' });
    }

    const services = await getStylistServices(stylistId);

    return res.status(200).json({
      stylist: {
        id: stylistId,
        name: `${sty.rows[0].first_name} ${sty.rows[0].last_name || ''}`.trim()
      },
      total: services.length,
      services: services.map(s => ({
        id: s.id,
        name: s.name,
        duration_minutes: Number(s.duration_minutes) || null
      }))
    });
  } catch (e) {
    console.error('getStylistServicesPublic', e);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/**
 * 3️⃣ Buscar Servicio (público)
 * GET /api/services/search/:tenantId?query=corte
 */
exports.searchServicesPublic = async (req, res) => {
  try {
    const { tenantId } = req.params;
    let { query } = req.query;

    if (!tenantId || !UUID_RE.test(tenantId)) {
      return res.status(400).json({ error: 'tenantId inválido o faltante (UUID).' });
    }
    query = clean(query);
    if (!query) {
      return res.status(400).json({ error: 'Falta query.' });
    }

    const q = `%${query.toLowerCase()}%`;

    const r = await db.query(
      `SELECT id, name, duration_minutes
       FROM services
       WHERE tenant_id = $1
         AND LOWER(name) ILIKE $2
       ORDER BY name ASC
       LIMIT 50`,
      [tenantId, q]
    );

    return res.status(200).json({
      query,
      total: r.rowCount,
      services: r.rows.map(s => ({
        id: s.id,
        name: s.name,
        duration_minutes: Number(s.duration_minutes) || null
      }))
    });
  } catch (e) {
    console.error('searchServicesPublic', e);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/**
 * 4️⃣ Verificar Disponibilidad (público)
 * GET /api/appointments/verify-public?tenantId={UUID}&service={id|nombre}&stylist={id|nombre}&date=YYYY-MM-DD&time=HH:mm
 * (Wrapper del verificador público ya existente)
 */
exports.verifyAvailabilityPublic = async (req, res) => {
  return exports.verifyStylistServiceAndAvailabilityPublic(req, res);
};

/* =================================================================== */
/* =========================  ENDPOINTS PUBLICOS  ==================== */
/* =================================================================== */

exports.smartAvailabilityPublic = async (req, res) => {
  try {
    let { tenantId, service, stylist, date, time, step, limit } = req.query;

    tenantId = clean(tenantId);
    service = clean(service);
    stylist = clean(stylist);
    date = clean(date);
    time = time ? cleanHHMM(time) : null;

    if (!tenantId || !service || !stylist || !date) {
      return res.status(400).json({
        error: 'Faltan parámetros: tenantId, service, stylist, date. time opcional.'
      });
    }
    if (!UUID_RE.test(tenantId)) {
      return res.status(400).json({ error: 'tenantId inválido (debe ser UUID).' });
    }

    const stepMinutes = Math.max(5, parseInt(step || '15', 10));
    const suggestLimit = Math.max(1, parseInt(limit || '6', 10));

    // Servicio
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

    // Estilista
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
           AND (
             LOWER(TRIM(first_name || ' ' || COALESCE(last_name,''))) = LOWER(TRIM($2))
             OR LOWER(TRIM(first_name)) = LOWER(TRIM($2))
           )
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

    // Ofrece servicio
    const offersService = await checkStylistOffersService(stylistId, serviceId);
    if (!offersService) {
      return res.status(200).json({
        service: { id: serviceId, name: serviceName },
        stylist: { id: stylistId, name: stylistName },
        offers_service: false,
        is_available: false,
        suggestions: [],
        reason: 'El estilista no ofrece este servicio.'
      });
    }

    // Slots disponibles
    const { slots, duration, effectiveRanges, reason } = await getAvailableSlotsForStylist(
      tenantId, stylistId, serviceId, date, stepMinutes
    );

    // ✅ FILTRAR HORARIOS PASADOS
    const filteredSlots = filterPastSlots(slots, date);

    if (filteredSlots.length === 0) {
      const isPastDay = slots.length > 0 && filteredSlots.length === 0;
      return res.status(200).json({
        service: { id: serviceId, name: serviceName },
        stylist: { id: stylistId, name: stylistName },
        offers_service: true,
        is_available: false,
        suggestions: [],
        reason: isPastDay
          ? 'Todos los horarios de hoy ya pasaron. Intenta con mañana u otra fecha.'
          : (reason || 'No hay disponibilidad')
      });
    }

    const allLocalTimes = filteredSlots.map(toLocalHHmm);

    let isAvailable = false;
    let suggestions = [];

    if (time) {
      const wanted = String(time).slice(0, 5);
      isAvailable = allLocalTimes.includes(wanted);

      if (!isAvailable) {
        const wantedDate = makeLocalUtc(date, wanted);
        const withDist = filteredSlots.map(d => ({
          d, dist: Math.abs(d.getTime() - wantedDate.getTime())
        })).sort((a, b) => a.dist - b.dist);

        suggestions = [...new Set(withDist.slice(0, suggestLimit).map(x => toLocalHHmm(x.d)))];
      }
    } else {
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

exports.smartAvailabilityPublicJSON = async (req, res) => {
  try {
    const { tenantId, service, stylist, date, time, step, limit } = req.body || {};
    req.query = {
      tenantId: tenantId ?? '',
      service: service ?? '',
      stylist: stylist ?? '',
      date: date ?? '',
      time: time ?? '',
      step: step ?? '',
      limit: limit ?? ''
    };
    return exports.smartAvailabilityPublic(req, res);
  } catch (e) {
    console.error('smartAvailabilityPublicJSON', e);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

exports.verifyStylistServiceAndAvailabilityPublic = async (req, res) => {
  try {
    let { tenantId, service, stylist, date, time, limit } = req.query;
    tenantId = clean(tenantId);
    service = clean(service);
    stylist = clean(stylist);
    date = clean(date);
    time = cleanHHMM(time);
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
            AND (
              LOWER(TRIM(first_name || ' ' || COALESCE(last_name,''))) = LOWER(TRIM($2))
              OR LOWER(TRIM(first_name)) = LOWER(TRIM($2))
            )
          LIMIT 1`, [tenantId, stylist]);
    const sty = (await styQ).rows[0];
    if (!sty) return res.status(404).json({ error: 'Estilista no encontrado.' });
    if ((sty.status || 'active') !== 'active') {
      return res.status(409).json({ error: 'El estilista no está activo.' });
    }

    const stylistName = `${sty.first_name} ${sty.last_name || ''}`.trim();

    // Ofrece servicio
    const offersService = await checkStylistOffersService(sty.id, svc.id);
    if (!offersService) {
      return res.status(200).json({
        service: { id: svc.id, name: svc.name },
        stylist: { id: sty.id, name: stylistName },
        offers_service: false,
        is_available: false,
        reason: 'El estilista no ofrece este servicio.',
        suggestions: []
      });
    }

    // Slots
    const { slots, duration, effectiveRanges, reason } = await getAvailableSlotsForStylist(
      tenantId, sty.id, svc.id, date, 15
    );

    // ✅ FILTRAR HORARIOS PASADOS
    const filteredSlots = filterPastSlots(slots, date);

    if (filteredSlots.length === 0) {
      const isPastDay = slots.length > 0 && filteredSlots.length === 0;
      return res.status(200).json({
        service: { id: svc.id, name: svc.name },
        stylist: { id: sty.id, name: stylistName },
        offers_service: true,
        is_available: false,
        reason: isPastDay
          ? 'Todos los horarios de hoy ya pasaron. Intenta con mañana u otra fecha.'
          : (reason || 'No hay disponibilidad'),
        suggestions: []
      });
    }

    const wantedStart = makeLocalUtc(date, time);
    const wanted = String(time).slice(0, 5);
    const allLocalTimes = filteredSlots.map(toLocalHHmm);
    const isAvailable = allLocalTimes.includes(wanted);

    if (!isAvailable) {
      const withDist = filteredSlots
        .map(d => ({ d, dist: Math.abs(d.getTime() - wantedStart.getTime()) }))
        .sort((a, b) => a.dist - b.dist);

      const alternos = await findAvailableStylists(tenantId, svc.name, date, time);
      const altStylists = alternos
        .filter(u => u.id !== sty.id)
        .map(u => ({ id: u.id, name: `${u.first_name} ${u.last_name || ''}`.trim() }));

      return res.status(200).json({
        service: { id: svc.id, name: svc.name, duration_minutes: duration },
        stylist: { id: sty.id, name: stylistName },
        offers_service: true,
        is_available: false,
        reason: 'No disponible a esa hora.',
        suggestions: [...new Set(withDist.slice(0, suggestLimit).map(x => toLocalHHmm(x.d)))],
        alternative_stylists: altStylists
      });
    }

    return res.status(200).json({
      service: { id: svc.id, name: svc.name, duration_minutes: duration },
      stylist: { id: sty.id, name: stylistName },
      offers_service: true,
      is_available: true,
      requested: { date, time }
    });

  } catch (e) {
    console.error('verifyStylistServiceAndAvailabilityPublic', e);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

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

exports.agendarCitaConversacional = async (req, res) => {
  try {
    const { appointmentDetails, clientId, tenantId } = req.body;

    if (!appointmentDetails || !clientId || !tenantId) {
      return res.status(400).json({ error: 'Faltan datos obligatorios de n8n.' });
    }
    const { servicio, fecha, hora, estilista } = appointmentDetails;

    // Estilista
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

    // Servicio
    const serviceRes = await db.query(
      'SELECT id, duration_minutes FROM services WHERE tenant_id = $1 AND LOWER(name) = LOWER($2)',
      [tenantId, servicio]
    );
    if (serviceRes.rows.length === 0) {
      return res.status(404).json({ error: `Servicio "${servicio}" no encontrado.` });
    }
    const serviceId = serviceRes.rows[0].id;
    const duration = Number(serviceRes.rows[0].duration_minutes) || 60;

    const offersService = await checkStylistOffersService(stylistId, serviceId);
    if (!offersService) {
      return res.status(400).json({ error: `El estilista "${estilista}" no ofrece el servicio "${servicio}".` });
    }

    const startTimeDate = makeLocalUtc(fecha, hora);

    // ✅ Permitir/denegar pasado según tenant
    await validatePastAppointment(tenantId, startTimeDate);

    const appointment = await createAppointmentRecord(tenantId, clientId, stylistId, serviceId, startTimeDate, duration);

    return res.status(201).json({
      success: true,
      message: `¡Tu cita ha sido agendada con éxito con ${estilista || 'un estilista disponible'} para ${formatInTimeZone(startTimeDate, TIME_ZONE, "yyyy-MM-dd 'a las' HH:mm")}!`,
      appointment
    });
  } catch (error) {
    console.error('Error en agendamiento conversacional:', error.message);
    return res.status(500).json({ error: error.message || 'Error interno del servidor.' });
  }
};

/* =================================================================== */
/* =======================  ENDPOINTS AUTENTICADOS  ================== */
/* =================================================================== */

exports.createAppointment = async (req, res) => {
  const { stylist_id, service_id, start_time, client_id: clientIdFromRequest } = req.body;
  const { tenant_id, id: clientIdFromToken } = req.user;
  const { dryRun } = req.query;

  const final_client_id = clientIdFromRequest || clientIdFromToken;
  if (!stylist_id || !service_id || !start_time || !final_client_id) {
    return res.status(400).json({ error: 'Faltan campos obligatorios.' });
  }

  try {
    const startTimeDate = new Date(start_time);
    if (isNaN(startTimeDate)) {
      return res.status(400).json({ error: 'start_time inválido. Envíe ISO 8601 con zona o UTC.' });
    }

    // ✅ Permitir/denegar pasado según tenant
    await validatePastAppointment(tenant_id, startTimeDate);

    const offersService = await checkStylistOffersService(stylist_id, service_id);
    if (!offersService) {
      return res.status(400).json({ error: 'El estilista no está cualificado para este servicio.' });
    }

    const duration = await getServiceDurationMinutes(service_id, 60);

    if (String(dryRun).toLowerCase() === 'true') {
      const endTimeDate = new Date(startTimeDate.getTime() + duration * 60000);
      return res.status(200).json({
        dryRun: true,
        wouldCreate: {
          tenant_id, client_id: final_client_id, stylist_id, service_id,
          start_time: startTimeDate, end_time: endTimeDate, status: 'scheduled'
        },
        wouldUpdate: { stylist_last_turn_at: 'NOW()' }
      });
    }

    const appointment = await createAppointmentRecord(tenant_id, final_client_id, stylist_id, service_id, startTimeDate, duration);
    return res.status(201).json(appointment);
  } catch (error) {
    console.error('Error al crear la cita:', error);
    return res.status(409).json({ error: error.message || 'Error interno del servidor' });
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

    for (const appt of appointments) {
      const { stylist_id, service_id, start_time } = appt;
      if (!stylist_id || !service_id || !start_time) {
        throw new Error('Cada cita debe tener stylist_id, service_id y start_time.');
      }

      const startTimeDate = new Date(start_time);
      if (isNaN(startTimeDate)) throw new Error('start_time inválido en una de las citas.');

      // ✅ Permitir/denegar pasado según tenant
      await validatePastAppointment(tenant_id, startTimeDate);

      const offersService = await checkStylistOffersService(stylist_id, service_id);
      if (!offersService) {
        throw new Error('El estilista no está cualificado para uno de los servicios.');
      }

      const duration = await getServiceDurationMinutes(service_id, 60);

      const appointment = await createAppointmentRecord(tenant_id, final_client_id, stylist_id, service_id, startTimeDate, duration);
      createdAppointments.push(appointment);
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

    // ✅ Si se está cambiando la fecha/hora, validar pasado según flag
    if (start_time) {
      await validatePastAppointment(tenant_id, newStart);
    }

    if (newStylistId !== current.stylist_id || newServiceId !== current.service_id) {
      const offersService = await checkStylistOffersService(newStylistId, newServiceId);
      if (!offersService) {
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
       WHERE id = $5`,
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
    return res.status(500).json({ error: error.message || "Error interno del servidor" });
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

    const { slots, reason } = await getAvailableSlotsForStylist(tenant_id, stylist_id, service_id, date, serviceDuration);

    // ✅ FILTRAR HORARIOS PASADOS
    const filteredSlots = filterPastSlots(slots, date);

    if (filteredSlots.length === 0) {
      const isPastDay = slots.length > 0 && filteredSlots.length === 0;
      return res.status(200).json({
        availableSlots: [],
        availableSlots_meta: [],
        message: isPastDay
          ? 'Todos los horarios de hoy ya pasaron. Intenta con mañana u otra fecha.'
          : (reason || 'No hay disponibilidad')
      });
    }

    const availableSlots_meta = filteredSlots.map(d => ({
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

  try {
    const serviceRes = await db.query('SELECT name FROM services WHERE id = $1', [service_id]);
    if (serviceRes.rows.length === 0) {
      return res.status(404).json({ error: 'Servicio no encontrado.' });
    }

    const availableStylists = await findAvailableStylists(tenantIdFromToken, serviceRes.rows[0].name, date, time);

    return res.status(200).json({
      availableStylists: availableStylists.map(s => ({
        id: s.id,
        first_name: s.first_name,
        last_name: s.last_name,
        avatar_url: null
      }))
    });
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

    // ✅ Permitir/denegar pasado según tenant (respuesta 200 con valid=false)
    try {
      await validatePastAppointment(tenant_id, start);
    } catch (error) {
      return res.status(200).json({ valid: false, reason: error.message });
    }

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

    const { stylist_id, service_id } = appointmentResult.rows[0];

    // Actualizar tracking global del estilista
    await db.query('UPDATE users SET last_service_at = NOW() WHERE id = $1', [stylist_id]);

    // 🎯 DIGITURNO: Actualizar posición en cola del servicio específico
    await db.query(
      `UPDATE stylist_services 
       SET last_completed_at = NOW(),
           total_completed = COALESCE(total_completed, 0) + 1
       WHERE user_id = $1 AND service_id = $2`,
      [stylist_id, service_id]
    );

    console.log(`🎯 [DIGITURNO] Cola actualizada:`);
    console.log(`   Estilista: ${stylist_id.substring(0, 8)}...`);
    console.log(`   Servicio: ${service_id.substring(0, 8)}...`);
    console.log(`   ✅ Movido al final de la cola para este servicio`);

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

    // ✅ FILTRAR HORARIOS PASADOS
    const filteredSlots = filterPastSlots(slots, date);

    if (filteredSlots.length === 0) {
      const isPastDay = slots.length > 0 && filteredSlots.length === 0;
      return res.status(200).json({
        slots: [],
        slots_meta: [],
        message: isPastDay
          ? 'Todos los horarios de hoy ya pasaron. Intenta con mañana u otra fecha.'
          : 'El salón está cerrado en esta fecha.'
      });
    }

    const slots_meta = filteredSlots.map(d => ({
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

    // ✅ FILTRAR HORARIOS PASADOS
    const filteredSlots = filterPastSlots(slots, date);

    if (filteredSlots.length === 0) {
      const isPastDay = slots.length > 0 && filteredSlots.length === 0;
      return res.status(200).json({
        slots: [],
        slots_meta: [],
        message: isPastDay
          ? 'Todos los horarios de hoy ya pasaron. Intenta con mañana u otra fecha.'
          : 'El salón está cerrado en esta fecha.'
      });
    }

    const slots_meta = filteredSlots.map(d => ({
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

exports.scheduleWithFallback = async (req, res) => {
  try {
    const { tenantId, clientId, service, date, time, stylist, limit } = req.body || {};
    const suggestLimit = Math.max(1, parseInt(limit || '6', 10));

    if (!tenantId || !clientId || !service || !date || !time) {
      return res.status(400).json({ error: 'Faltan campos: tenantId, clientId, service, date, time.' });
    }

    // Servicio
    const svcQ = UUID_RE.test(service)
      ? db.query(`SELECT id, name, duration_minutes FROM services WHERE id=$1 AND tenant_id=$2 LIMIT 1`, [service, tenantId])
      : db.query(`SELECT id, name, duration_minutes FROM services WHERE tenant_id=$1 AND LOWER(name)=LOWER($2) LIMIT 1`, [tenantId, service]);
    const svc = (await svcQ).rows[0];
    if (!svc) return res.status(404).json({ error: 'Servicio no encontrado.' });

    const durationBase = Number(svc.duration_minutes) || 60;

    if (stylist) {
      // Con estilista específico
      const styQ = UUID_RE.test(stylist)
        ? db.query(`SELECT id, first_name, last_name, working_hours, status FROM users WHERE id=$1 AND tenant_id=$2 AND role_id=3 LIMIT 1`, [stylist, tenantId])
        : db.query(`
            SELECT id, first_name, last_name, working_hours, status
            FROM users
            WHERE tenant_id=$1 AND role_id=3
              AND (
                LOWER(TRIM(first_name || ' ' || COALESCE(last_name,''))) = LOWER(TRIM($2))
                OR LOWER(TRIM(first_name)) = LOWER(TRIM($2))
              )
            LIMIT 1`, [tenantId, stylist]);
      const sty = (await styQ).rows[0];
      if (!sty) return res.status(404).json({ error: 'Estilista no encontrado.' });
      if ((sty.status || 'active') !== 'active') {
        return res.status(409).json({ error: 'El estilista no está activo.' });
      }

      const offersService = await checkStylistOffersService(sty.id, svc.id);
      if (!offersService) {
        return res.status(200).json({
          booked: false,
          reason: 'El estilista no ofrece este servicio.',
          suggestions: [],
          alternative_stylists: []
        });
      }

      const duration = await getStylistEffectiveDuration(sty.id, svc.id, durationBase);
      const { slots, effectiveRanges } = await getAvailableSlotsForStylist(tenantId, sty.id, svc.id, date, 15);

      // ✅ FILTRAR HORARIOS PASADOS
      const filteredSlots = filterPastSlots(slots, date);

      const wantedStart = makeLocalUtc(date, time);
      const wantedEnd = new Date(wantedStart.getTime() + duration * 60000);

      // ✅ Permitir/denegar pasado según tenant
      try {
        await validatePastAppointment(tenantId, wantedStart);
      } catch (error) {
        return res.status(400).json({
          booked: false,
          reason: error.message,
          suggestions: [],
          alternative_stylists: []
        });
      }

      const inRange = effectiveRanges && effectiveRanges.length > 0 && isWithinRanges(date, effectiveRanges, wantedStart, wantedEnd);

      if (!inRange || filteredSlots.length === 0) {
        const withDist = filteredSlots.map(d => ({ d, dist: Math.abs(d.getTime() - wantedStart.getTime()) }))
          .sort((a, b) => a.dist - b.dist);
        return res.status(200).json({
          booked: false,
          reason: filteredSlots.length === 0 && slots.length > 0
            ? 'Todos los horarios de hoy ya pasaron. Intenta con mañana.'
            : 'La hora solicitada no está disponible.',
          suggestions: [...new Set(withDist.slice(0, suggestLimit).map(x => toLocalHHmm(x.d)))],
          alternative_stylists: []
        });
      }

      const wanted = toLocalHHmm(wantedStart);
      const allLocalTimes = filteredSlots.map(toLocalHHmm);
      const isAvailable = allLocalTimes.includes(wanted);

      if (!isAvailable) {
        const withDist = filteredSlots.map(d => ({ d, dist: Math.abs(d.getTime() - wantedStart.getTime()) }))
          .sort((a, b) => a.dist - b.dist);

        const alternos = await findAvailableStylists(tenantId, svc.name, date, time);
        const altStylists = alternos
          .filter(u => u.id !== sty.id)
          .map(u => ({ id: u.id, name: `${u.first_name} ${u.last_name || ''}`.trim() }));

        return res.status(200).json({
          booked: false,
          reason: 'Conflicto de horario.',
          suggestions: [...new Set(withDist.slice(0, suggestLimit).map(x => toLocalHHmm(x.d)))],
          alternative_stylists: altStylists
        });
      }

      const appointment = await createAppointmentRecord(tenantId, clientId, sty.id, svc.id, wantedStart, duration);
      return res.status(201).json({ booked: true, appointment });
    }

    // Sin estilista específico
    const start = makeLocalUtc(date, time);

    // ✅ Permitir/denegar pasado según tenant
    try {
      await validatePastAppointment(tenantId, start);
    } catch (error) {
      return res.status(400).json({
        booked: false,
        reason: error.message,
        suggestions: [],
        alternative_stylists: []
      });
    }

    const exactAlternatives = await findAvailableStylists(tenantId, svc.name, date, time);
    if (exactAlternatives.length > 0) {
      const styId = exactAlternatives[0].id;
      const appointment = await createAppointmentRecord(tenantId, clientId, styId, svc.id, start, durationBase);
      return res.status(201).json({ booked: true, appointment });
    }

    // Nadie libre → sugerencias
    const tRes = await db.query(`SELECT working_hours FROM tenants WHERE id=$1`, [tenantId]);
    const tenantWH = tRes.rows[0]?.working_hours || {};
    const dayRanges = getDayRangesFromWorkingHours(tenantWH, date);
    const candidates = buildSlotsFromRanges(date, dayRanges, 15);

    // ✅ FILTRAR HORARIOS PASADOS
    const filteredCandidates = filterPastSlots(candidates, date);
    const wanted = makeLocalUtc(date, time);

    const scored = [];
    for (const c of filteredCandidates) {
      const hh = toLocalHHmm(c);
      const alts = await findAvailableStylists(tenantId, svc.name, date, hh);
      if (alts.length > 0) {
        scored.push({ d: c, dist: Math.abs(c.getTime() - wanted.getTime()), stylists: alts.slice(0, 3) });
      }
    }
    scored.sort((a, b) => a.dist - b.dist);

    return res.status(200).json({
      booked: false,
      reason: filteredCandidates.length === 0 && candidates.length > 0
        ? 'Todos los horarios de hoy ya pasaron. Intenta con mañana.'
        : 'No hay estilistas disponibles a la hora solicitada.',
      suggestions: [...new Set(scored.slice(0, suggestLimit).map(x => toLocalHHmm(x.d)))],
      alternative_stylists: (scored[0]?.stylists || []).map(s => ({
        id: s.id, name: `${s.first_name} ${s.last_name || ''}`.trim()
      }))
    });

  } catch (e) {
    console.error('scheduleWithFallback', e);
    return res.status(500).json({ error: e.message || 'Error interno del servidor' });
  }
};

/* =================================================================== */
/* =========================  AI ORCHESTRATOR  ======================= */
/* =================================================================== */

exports.aiOrchestratorPublic = async (req, res) => {
  try {
    const payload = { ...(req.query || {}), ...(req.body || {}) };

    let {
      action,
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
    const stepMinutes = Math.max(5, parseInt(step || '15', 10));

    if (!tenantId || !UUID_RE.test(tenantId)) {
      return res.status(400).json({ error: 'Falta tenantId válido (UUID).' });
    }

    date = normalizeDateKeyword(clean(date));

    // 🔍 DEBUG: Ver valor original de time
    console.log('⏰ [aiOrchestrator] Time ANTES de normalizar:', time);
    time = normalizeHumanTimeToHHMM(time);
    console.log('⏰ [aiOrchestrator] Time DESPUÉS de normalizar:', time);

    const svc = await resolveServiceFuzzy(tenantId, { service, service_id, selected_service_id }, 10);
    let chosenService = svc.chosen;
    const serviceOptions = svc.options || [];

    const sty = await resolveStylistFuzzy(tenantId, { stylist, stylist_id, selected_stylist_id }, 10);
    let chosenStylist = sty.chosen;
    const stylistOptions = sty.options || [];

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

    // ✅ NUEVO: Si tengo estilista pero NO servicio, listar sus servicios
    if (chosenStylist && !chosenService) {
      const stylistServices = await getStylistServices(chosenStylist.id);

      if (stylistServices.length === 0) {
        return res.status(200).json({
          status: 'stylist_no_services',
          message: `${chosenStylist.name} no tiene servicios configurados.`,
          services: []
        });
      }

      return res.status(200).json({
        status: 'list_stylist_services',
        message: `${chosenStylist.name} ofrece estos servicios:`,
        stylist: {
          id: chosenStylist.id,
          name: chosenStylist.name
        },
        services: stylistServices.map(s => ({
          id: s.id,
          name: s.name,
          duration_minutes: Number(s.duration_minutes) || null
        })),
        next: 'Envía selected_service_id con el servicio que deseas o usa "service" con el nombre.'
      });
    }

    if (!chosenService) {
      return res.status(200).json({
        status: 'need_service',
        message: '¿Qué servicio deseas?',
        options_hint: 'Envía service por nombre o selected_service_id.'
      });
    }

    // Camino A: con estilista específico
    if (chosenStylist) {
      const offersService = await checkStylistOffersService(chosenStylist.id, chosenService.id);
      if (!offersService) {
        // Obtener servicios que SÍ ofrece
        const stylistServices = await getStylistServices(chosenStylist.id);

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
          message: `${chosenStylist.name} no ofrece "${chosenService.name}".`,
          stylist_services: stylistServices.map(s => ({
            id: s.id,
            name: s.name,
            duration_minutes: Number(s.duration_minutes) || null
          })),
          alternative_stylists: alt.slice(0, suggestLimit),
          next: 'Elige otro servicio de los que ofrece, o elige un estilista alterno.'
        });
      }

      let duration = Number(chosenService.duration_minutes) || 60;
      duration = await getStylistEffectiveDuration(chosenStylist.id, chosenService.id, duration);

      if (!date) {
        return res.status(200).json({
          status: 'need_date',
          message: '¿Para qué fecha quieres agendar?',
          hint: 'Puedes enviar "hoy" / "mañana" o YYYY-MM-DD.'
        });
      }

      const { slots, effectiveRanges, reason } = await getAvailableSlotsForStylist(
        tenantId, chosenStylist.id, chosenService.id, date, stepMinutes
      );

      // ✅ FILTRAR HORARIOS PASADOS
      const filteredSlots = filterPastSlots(slots, date);

      if (filteredSlots.length === 0) {
        const isPastDay = slots.length > 0 && filteredSlots.length === 0;
        return res.status(200).json({
          status: isPastDay ? 'all_slots_past' : (reason || 'no_availability'),
          message: isPastDay
            ? 'Todos los horarios de hoy ya pasaron. Intenta con mañana u otra fecha.'
            : (reason || 'No hay disponibilidad'),
          suggestions: []
        });
      }

      const allLocalTimes = filteredSlots.map(toLocalHHmm);

      if (!time) {
        return res.status(200).json({
          status: 'choose_time',
          message: 'Estos son los horarios disponibles para ese día:',
          suggestions: allLocalTimes.slice(0, suggestLimit),
          slots_all: allLocalTimes.slice(0, 48),
          next: 'Envía time con una de las opciones.'
        });
      }

      const wanted = String(time).slice(0, 5);

      // 🔍 DEBUG: Ver qué está comparando
      console.log('🔍 [aiOrchestrator] Comparando disponibilidad:');
      console.log('   wanted (hora solicitada):', wanted);
      console.log('   allLocalTimes (primeros 10 slots):', allLocalTimes.slice(0, 10));
      console.log('   ¿Está incluido?:', allLocalTimes.includes(wanted));

      const isAvailable = allLocalTimes.includes(wanted);

      if (!isAvailable) {
        const wantedDate = makeLocalUtc(date, wanted);

        // 🔍 DEBUG: Ver la fecha construida
        console.log('🔍 [aiOrchestrator] Fecha construida:');
        console.log('   date:', date);
        console.log('   wanted:', wanted);
        console.log('   wantedDate:', wantedDate.toISOString());

        const withDist = filteredSlots.map(d => ({ d, dist: Math.abs(d.getTime() - wantedDate.getTime()) }))
          .sort((a, b) => a.dist - b.dist);

        const alternos = await findAvailableStylists(tenantId, chosenService.name, date, wanted);
        const altStylists = alternos
          .filter(u => u.id !== chosenStylist.id)
          .map(u => ({ id: u.id, name: `${u.first_name} ${u.last_name || ''}`.trim() }));

        return res.status(200).json({
          status: 'choose_time',
          message: `A las ${wanted} no tiene disponibilidad ${chosenStylist.name} para ${chosenService.name}.`,
          suggestions: [...new Set(withDist.slice(0, suggestLimit).map(x => toLocalHHmm(x.d)))],
          slots_all: allLocalTimes.slice(0, 48),
          alternative_stylists: altStylists,
          next: 'Elige una de las horas sugeridas o un estilista alterno.'
        });
      }

      // ✅ SI LLEGÓ AQUÍ, SÍ HAY DISPONIBILIDAD
      const startTimeDate = makeLocalUtc(date, wanted);
      const endTimeDate = new Date(startTimeDate.getTime() + duration * 60000);

      console.log('✅ [aiOrchestrator] DISPONIBLE - Preparando para confirmar');
      console.log('   startTimeDate:', startTimeDate.toISOString());
      console.log('   action:', action);

      if (action === 'agendar') {
        if (!clientId) {
          return res.status(400).json({ error: 'Para agendar se requiere clientId.' });
        }

        try {
          await validatePastAppointment(tenantId, startTimeDate);

          const appointment = await createAppointmentRecord(
            tenantId, clientId, chosenStylist.id, chosenService.id, startTimeDate, duration
          );

          return res.status(201).json({
            status: 'booked',
            message: `¡Listo! Tu cita quedó con ${chosenStylist.name} el ${formatInTimeZone(startTimeDate, TIME_ZONE, 'yyyy-MM-dd')} a las ${formatInTimeZone(startTimeDate, TIME_ZONE, 'HH:mm')}.`,
            appointment
          });
        } catch (error) {
          return res.status(409).json({
            status: 'conflict_or_invalid',
            message: error.message || 'Se ocupó el turno mientras confirmabas. Elige otra hora.',
            suggestions: allLocalTimes.slice(0, suggestLimit)
          });
        }
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
    }

    // Camino B: sin estilista específico
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

    let duration = Number(chosenService.duration_minutes) || 60;
    duration = await getStylistEffectiveDuration(chosenStylist.id, chosenService.id, duration);

    const startTimeDate = makeLocalUtc(date, time);
    const wanted = String(time).slice(0, 5);

    if (action === 'agendar') {
      if (!clientId) {
        return res.status(400).json({ error: 'Para agendar se requiere clientId.' });
      }

      try {
        await validatePastAppointment(tenantId, startTimeDate);

        const appointment = await createAppointmentRecord(
          tenantId, clientId, chosenStylist.id, chosenService.id, startTimeDate, duration
        );

        return res.status(201).json({
          status: 'booked',
          message: `¡Listo! Tu cita quedó con ${chosenStylist.name} el ${formatInTimeZone(startTimeDate, TIME_ZONE, 'yyyy-MM-dd')} a las ${formatInTimeZone(startTimeDate, TIME_ZONE, 'HH:mm')}.`,
          appointment
        });
      } catch (error) {
        return res.status(409).json({
          status: 'conflict_or_invalid',
          message: error.message || '¡Uy! Justo se ocupó ese turno mientras confirmabas. ¿Intentamos de nuevo?'
        });
      }
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

  } catch (e) {
    console.error('aiOrchestratorPublic', e);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

exports.aiOrchestrator = async (req, res) => {
  try {
    const method = req.method.toUpperCase();
    const src = method === 'GET' ? req.query : req.body;

    let tenantId = clean(src.tenantId || src.tenant_id || '');
    let clientId = src.clientId || src.client_id || null;

    let intent = clean((src.ai_intent || src.intent || '').toLowerCase());
    let ai_service = clean(src.ai_service || src.service || '');
    let ai_stylist = clean(src.ai_stylist || src.stylist || '');
    let ai_date = clean(src.ai_date || src.date || '');
    let ai_time = cleanHHMM(src.ai_time || src.time || '');

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
          stylists: r.rows.map(u => ({ id: u.id, name: `${u.first_name} ${u.last_name || ''}`.trim() }))
        });
      }

      if (intent === 'validar' || (ai_service && ai_stylist && ai_date)) {
        const svcQ = UUID_RE.test(ai_service)
          ? db.query(`SELECT id, name, duration_minutes FROM services WHERE id=$1 AND tenant_id=$2 LIMIT 1`, [ai_service, tenantId])
          : db.query(`SELECT id, name, duration_minutes FROM services WHERE tenant_id=$1 AND LOWER(name)=LOWER($2) LIMIT 1`, [tenantId, ai_service]);
        const svc = (await svcQ).rows[0];
        if (!svc) return res.status(404).json({ ok: false, error: 'Servicio no encontrado.' });

        // Estilista
        const styQ = UUID_RE.test(ai_stylist)
          ? db.query(`SELECT id, first_name, last_name, working_hours, status FROM users WHERE id=$1 AND tenant_id=$2 AND role_id=3 LIMIT 1`, [ai_stylist, tenantId])
          : db.query(`
              SELECT id, first_name, last_name, working_hours, status
              FROM users
              WHERE tenant_id=$1 AND role_id=3
                AND (
                  LOWER(TRIM(first_name || ' ' || COALESCE(last_name,''))) = LOWER(TRIM($2))
                  OR LOWER(TRIM(first_name)) = LOWER(TRIM($2))
                )
              LIMIT 1`, [tenantId, ai_stylist]);
        const sty = (await styQ).rows[0];
        if (!sty) return res.status(404).json({ ok: false, error: 'Estilista no encontrado.' });
        if ((sty.status || 'active') !== 'active') {
          return res.status(409).json({ ok: false, error: 'El estilista no está activo.' });
        }

        const offersService = await checkStylistOffersService(sty.id, svc.id);
        if (!offersService) {
          // Listar servicios del estilista
          const stylistServices = await getStylistServices(sty.id);

          let alternatives = [];
          if (ai_date && ai_time) {
            const alts = await findAvailableStylists(tenantId, svc.name, ai_date, ai_time);
            alternatives = alts
              .filter(u => u.id !== sty.id)
              .map(u => ({ id: u.id, name: `${u.first_name} ${u.last_name || ''}`.trim() }));
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
              .map(u => ({ id: u.id, name: `${u.first_name} ${u.last_name || ''}`.trim() }));
          }

          return res.status(200).json({
            ok: true,
            intent: 'validar',
            service: { id: svc.id, name: svc.name },
            stylist: { id: sty.id, name: `${sty.first_name} ${sty.last_name || ''}`.trim() },
            offers_service: false,
            is_available: false,
            reason: 'El estilista no ofrece este servicio.',
            stylist_services: stylistServices.map(s => ({
              id: s.id,
              name: s.name,
              duration_minutes: Number(s.duration_minutes) || null
            })),
            alternative_stylists: alternatives
          });
        }

        const { slots, duration, reason } = await getAvailableSlotsForStylist(tenantId, sty.id, svc.id, ai_date, 15);

        // ✅ FILTRAR HORARIOS PASADOS
        const filteredSlots = filterPastSlots(slots, ai_date);

        if (filteredSlots.length === 0) {
          const isPastDay = slots.length > 0 && filteredSlots.length === 0;
          return res.status(200).json({
            ok: true,
            intent: 'validar',
            service: { id: svc.id, name: svc.name },
            stylist: { id: sty.id, name: `${sty.first_name} ${sty.last_name || ''}`.trim() },
            offers_service: true,
            is_available: false,
            reason: isPastDay
              ? 'Todos los horarios de hoy ya pasaron. Intenta con mañana u otra fecha.'
              : (reason || 'No hay disponibilidad'),
            suggestions: []
          });
        }

        const allLocalTimes = filteredSlots.map(toLocalHHmm);

        if (!ai_time) {
          return res.status(200).json({
            ok: true,
            intent: 'validar',
            service: { id: svc.id, name: svc.name, duration_minutes: duration },
            stylist: { id: sty.id, name: `${sty.first_name} ${sty.last_name || ''}`.trim() },
            offers_service: true,
            is_available: false,
            reason: 'No se proporcionó hora, mostrando opciones.',
            suggestions: allLocalTimes.slice(0, suggestLimit),
            slots_all: allLocalTimes.slice(0, 48)
          });
        }

        const wanted = String(ai_time).slice(0, 5);
        const isAvailable = allLocalTimes.includes(wanted);

        if (!isAvailable) {
          const wantedDate = makeLocalUtc(ai_date, wanted);
          const withDist = filteredSlots.map(d => ({ d, dist: Math.abs(d.getTime() - wantedDate.getTime()) }))
            .sort((a, b) => a.dist - b.dist);

          const alternos = await findAvailableStylists(tenantId, svc.name, ai_date, ai_time);
          const altStylists = alternos
            .filter(u => u.id !== sty.id)
            .map(u => ({ id: u.id, name: `${u.first_name} ${u.last_name || ''}`.trim() }));

          return res.status(200).json({
            ok: true,
            intent: 'validar',
            service: { id: svc.id, name: svc.name, duration_minutes: duration },
            stylist: { id: sty.id, name: `${sty.first_name} ${sty.last_name || ''}`.trim() },
            offers_service: true,
            is_available: false,
            reason: 'No disponible a esa hora.',
            suggestions: [...new Set(withDist.slice(0, suggestLimit).map(x => toLocalHHmm(x.d)))],
            alternative_stylists: altStylists
          });
        }

        return res.status(200).json({
          ok: true,
          intent: 'validar',
          service: { id: svc.id, name: svc.name, duration_minutes: duration },
          stylist: { id: sty.id, name: `${sty.first_name} ${sty.last_name || ''}`.trim() },
          offers_service: true,
          is_available: true,
          requested: { date: ai_date, time: ai_time }
        });
      }

      return res.status(400).json({ ok: false, error: 'Intención GET no reconocida.' });
    }

    if (method === 'POST') {
      if (!intent) intent = 'agendar';
      if (intent !== 'agendar') {
        return res.status(400).json({ ok: false, error: 'Para POST, use ai_intent=agendar.' });
      }
      if (!clientId) return res.status(400).json({ ok: false, error: 'Falta clientId para agendar.' });
      if (!ai_service || !ai_date || !ai_time) {
        return res.status(400).json({ ok: false, error: 'Faltan campos: service/date/time.' });
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

    return res.status(405).json({ ok: false, error: 'Método no permitido.' });

  } catch (err) {
    console.error('aiOrchestrator', err);
    return res.status(500).json({ ok: false, error: 'Error interno del servidor' });
  }
};

exports.getDigiturnoQueue = async (req, res) => {
  try {
    const { tenantId } = req.params;

    if (!tenantId || !UUID_RE.test(tenantId)) {
      return res.status(400).json({ error: 'tenantId inválido (UUID).' });
    }

    console.log('🎯 [DIGITURNO QUEUE] Consultando cola para tenant:', tenantId);

    // Obtener todos los servicios del tenant
    const servicesResult = await db.query(
      `SELECT id, name FROM services WHERE tenant_id = $1 ORDER BY name`,
      [tenantId]
    );

    const queue = [];

    // Para cada servicio, obtener la cola ordenada
    for (const service of servicesResult.rows) {
      const stylistsResult = await db.query(
        `SELECT 
          u.id as stylist_id,
          u.first_name,
          u.last_name,
          ss.last_completed_at,
          ss.total_completed,
          ROW_NUMBER() OVER (
            ORDER BY 
              ss.last_completed_at NULLS FIRST,
              ss.total_completed ASC,
              u.created_at ASC
          ) as queue_position
        FROM users u
        INNER JOIN stylist_services ss ON u.id = ss.user_id
        WHERE u.tenant_id = $1
          AND u.role_id = 3
          AND COALESCE(NULLIF(u.status,''),'active') = 'active'
          AND ss.service_id = $2
        ORDER BY 
          ss.last_completed_at NULLS FIRST,
          ss.total_completed ASC,
          u.created_at ASC`,
        [tenantId, service.id]
      );

      // Agregar cada estilista con su posición en la cola de este servicio
      stylistsResult.rows.forEach((row) => {
        queue.push({
          service_id: service.id,
          service_name: service.name,
          stylist_id: row.stylist_id,
          stylist_name: `${row.first_name} ${row.last_name || ''}`.trim(),
          order: row.queue_position,
          last_completed_at: row.last_completed_at,
          total_completed: row.total_completed || 0
        });
      });
    }

    console.log(`✅ [DIGITURNO QUEUE] Cola generada: ${queue.length} registros`);

    return res.status(200).json({
      tenant_id: tenantId,
      timestamp: new Date().toISOString(),
      queue
    });

  } catch (error) {
    console.error('❌ [DIGITURNO QUEUE] Error:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};