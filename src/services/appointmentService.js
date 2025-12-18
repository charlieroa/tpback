// src/services/appointmentService.js
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
  isWithinRanges,
  buildSlotsFromRanges,
} = require('../utils/appointmentHelpers');

// ==================== CACHE & HELPERS ====================
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

// ==================== RESOLVERS ====================
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

// ==================== DISPONIBILIDAD ====================

/**
 * 🎯 DIGITURNO: Encuentra estilistas disponibles ordenados por cola justa
 * * LÓGICA ACTUALIZADA (Round Robin con Estado + Orden Visual):
 * - Busca a todos los que hacen el servicio.
 * - Verifica horarios laborales.
 * - Verifica citas existentes (marca is_busy).
 * - **REORDENA** la lista final: Disponibles Primero, Ocupados Después (respetando su turno relativo).
 */
async function findAvailableStylists(tenantId, serviceName, dateStr, timeStr) {
  try {
    // 1. Obtener información del servicio
    const serviceRes = await db.query(
      'SELECT id, duration_minutes FROM services WHERE tenant_id = $1 AND LOWER(name) = LOWER($2)',
      [tenantId, serviceName]
    );

    if (serviceRes.rows.length === 0) {
      console.log('❌ [DIGITURNO] Servicio no encontrado:', serviceName);
      return [];
    }

    const serviceId = serviceRes.rows[0].id;
    const serviceDuration = Number(serviceRes.rows[0].duration_minutes) || 60;

    // 2. Calcular ventana de tiempo requerida
    const requestedStartDateTime = makeLocalUtc(dateStr, timeStr);
    const requestedEndDateTime = new Date(requestedStartDateTime.getTime() + serviceDuration * 60000);

    console.log('\n' + '🎯'.repeat(40));
    console.log('🎯 [DIGITURNO] Búsqueda de estilista disponible');
    console.log('   Servicio:', serviceName, `(${serviceId.substring(0, 8)}...)`);
    console.log('   Fecha/Hora:', dateStr, timeStr);
    console.log('   Duración:', serviceDuration, 'minutos');
    console.log('   Ventana:', requestedStartDateTime.toISOString(), '→', requestedEndDateTime.toISOString());

    // 3. Verificar horario del tenant
    const tenantResult = await db.query('SELECT working_hours FROM tenants WHERE id = $1', [tenantId]);
    if (tenantResult.rows.length === 0) {
      console.log('❌ [DIGITURNO] Tenant no encontrado');
      return [];
    }

    const tenantWorkingHours = tenantResult.rows[0].working_hours || {};
    const tenantDayRanges = getDayRangesFromWorkingHours(tenantWorkingHours, dateStr);

    if (!Array.isArray(tenantDayRanges) || tenantDayRanges.length === 0) {
      console.log('❌ [DIGITURNO] El salón está cerrado ese día');
      return [];
    }

    if (!isWithinRanges(dateStr, tenantDayRanges, requestedStartDateTime, requestedEndDateTime)) {
      console.log('❌ [DIGITURNO] La hora solicitada está fuera del horario del salón');
      return [];
    }

    // 4. 🔥 CONSULTA PRINCIPAL CON SISTEMA DE COLA JUSTA POR SERVICIO
    // Traemos a todos ordenados por su turno "lógico" (quien lleva más tiempo sin trabajar va primero)
    console.log('🔍 [DIGITURNO] Consultando cola del servicio...');

    const stylistsResult = await db.query(
      `SELECT 
          u.id, 
          u.first_name, 
          u.last_name, 
          u.working_hours,
          u.created_at as user_created_at,
          ss.last_completed_at,
          ss.total_completed
        FROM users u
        INNER JOIN stylist_services ss ON u.id = ss.user_id
        WHERE u.tenant_id = $1
          AND u.role_id = 3
          AND COALESCE(NULLIF(u.status,''),'active') = 'active'
          AND ss.service_id = $2
        ORDER BY 
          ss.last_completed_at ASC NULLS FIRST,
          ss.total_completed ASC,
          u.created_at ASC`,
      [tenantId, serviceId]
    );

    const allPotentialStylists = stylistsResult.rows;
    console.log(`📊 [DIGITURNO] Estilistas que ofrecen el servicio: ${allPotentialStylists.length}`);

    // 5. Procesar disponibilidad
    const processedQueue = [];

    for (const stylist of allPotentialStylists) {
      // 5.1 Verificar horario laboral
      const stylistDayRanges = getEffectiveStylistDayRanges(
        stylist.working_hours ?? null,
        tenantWorkingHours,
        dateStr
      );

      if (!Array.isArray(stylistDayRanges) || stylistDayRanges.length === 0) {
        console.log(`   ⏰ ${stylist.first_name}: No trabaja ese día (Excluido)`);
        continue;
      }

      const effectiveRanges = intersectRangesArrays(tenantDayRanges, stylistDayRanges);
      if (effectiveRanges.length === 0) {
        console.log(`   ⏰ ${stylist.first_name}: Horarios no coinciden (Excluido)`);
        continue;
      }

      if (!isWithinRanges(dateStr, effectiveRanges, requestedStartDateTime, requestedEndDateTime)) {
        console.log(`   ⏰ ${stylist.first_name}: Fuera de horario laboral en esa hora`);
        continue;
      }

      // 5.2 Verificar conflictos (CITAS)
      const overlap = await db.query(
        `SELECT 1 FROM appointments
          WHERE stylist_id = $1 
            AND status = ANY($4) 
            AND (start_time, end_time) OVERLAPS ($2, $3)
          LIMIT 1`,
        [stylist.id, requestedStartDateTime, requestedEndDateTime, BLOCKING_STATUSES]
      );

      const isBusy = overlap.rowCount > 0;

      stylist.is_busy = isBusy;
      stylist.status_label = isBusy ? 'OCUPADO' : 'DISPONIBLE';

      if (isBusy) {
        console.log(`   📅 ${stylist.first_name}: Tiene cita (Marcado OCUPADO)`);
      } else {
        console.log(`   ✅ ${stylist.first_name}: DISPONIBLE`);
      }

      processedQueue.push(stylist);
    }

    // 6. 🚨 REORDENAMIENTO PARA UI (EL CAMBIO CLAVE) 🚨
    // Separamos la cola en dos grupos, manteniendo el orden de SQL dentro de cada uno.
    // Grupo 1: Disponibles (Prioridad visual)
    // Grupo 2: Ocupados (Fondo de la lista)

    const availableStylists = processedQueue.filter(s => !s.is_busy);
    const busyStylists = processedQueue.filter(s => s.is_busy);

    // Concatenamos: Verdes primero, Rojos al final.
    const finalSortedQueue = [...availableStylists, ...busyStylists];

    // 7. Encontrar al SUGERIDO (Será el primero de la lista finalSortedQueue)
    const suggestedStylist = finalSortedQueue.length > 0 ? finalSortedQueue[0] : null;

    // 8. Resumen final en Logs
    console.log('─'.repeat(90));
    console.log(`✅ [DIGITURNO] Resultado ordenado para UI: ${finalSortedQueue.length} estilistas.`);

    if (finalSortedQueue.length > 0) {
      console.log('🏆 [DIGITURNO] Estado de la cola (Disponibles primero):');
      finalSortedQueue.forEach((s, idx) => {
        const lastService = s.last_completed_at
          ? formatInTimeZone(new Date(s.last_completed_at), TIME_ZONE, 'dd/MM HH:mm')
          : 'NUNCA';

        const prefix = (suggestedStylist && s.id === suggestedStylist.id) ? '👉' : '  ';
        const statusIcon = s.is_busy ? '🔴 OCUPADO' : '🟢 DISPONIBLE';

        console.log(`   ${prefix} ${idx + 1}. ${s.first_name} ${s.last_name || ''} | ${statusIcon} | (último: ${lastService})`);
      });
    } else {
      console.log('⚠️ [DIGITURNO] No hay estilistas trabajando en este horario.');
    }

    console.log('🎯'.repeat(40) + '\n');

    // Retornamos la lista YA ORDENADA.
    // El frontend mostrará esta lista tal cual, así que los verdes salen arriba.
    return finalSortedQueue;

  } catch (error) {
    console.error('❌ [DIGITURNO ERROR] Error al encontrar estilistas disponibles:', error);
    return [];
  }
}

async function getStylistEffectiveDuration(stylistId, serviceId, baseDuration) {
  let duration = baseDuration;
  if (await hasDurationOverrideColumn()) {
    const over = await db.query(
      `SELECT duration_override_minutes FROM stylist_services WHERE user_id=$1 AND service_id=$2 LIMIT 1`,
      [stylistId, serviceId]
    );
    const d = Number(over.rows[0]?.duration_override_minutes);
    if (Number.isFinite(d) && d > 0) duration = d;
  }
  return duration;
}

async function checkStylistOffersService(stylistId, serviceId) {
  const skill = await db.query(
    `SELECT 1 FROM stylist_services WHERE user_id=$1 AND service_id=$2 LIMIT 1`,
    [stylistId, serviceId]
  );
  return skill.rowCount > 0;
}

async function getAvailableSlotsForStylist(tenantId, stylistId, serviceId, date, stepMinutes = 15) {
  const tRes = await db.query(`SELECT working_hours FROM tenants WHERE id=$1`, [tenantId]);
  if (tRes.rowCount === 0) return { slots: [], reason: 'Tenant no encontrado' };

  const tenantWH = tRes.rows[0].working_hours || {};
  const tenantRanges = getDayRangesFromWorkingHours(tenantWH, date);
  if (!tenantRanges.length) return { slots: [], reason: 'El salón está cerrado ese día' };

  const styRes = await db.query(
    `SELECT working_hours FROM users WHERE id=$1 AND tenant_id=$2 AND role_id=3`,
    [stylistId, tenantId]
  );
  if (styRes.rowCount === 0) return { slots: [], reason: 'Estilista no encontrado' };

  const stylistWH = styRes.rows[0].working_hours ?? null;
  const stylistRanges = getEffectiveStylistDayRanges(stylistWH, tenantWH, date);
  if (!stylistRanges.length) return { slots: [], reason: 'El estilista no trabaja ese día' };

  const effectiveRanges = intersectRangesArrays(tenantRanges, stylistRanges);
  if (!effectiveRanges.length) return { slots: [], reason: 'Horarios no coinciden' };

  const svcRes = await db.query(`SELECT duration_minutes FROM services WHERE id=$1`, [serviceId]);
  const baseDuration = Number(svcRes.rows[0]?.duration_minutes) || 60;
  const duration = await getStylistEffectiveDuration(stylistId, serviceId, baseDuration);

  const apptRes = await db.query(
    `SELECT start_time, end_time
      FROM appointments
      WHERE stylist_id=$1
        AND (start_time AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date = $2::date
        AND status = ANY($3)`,
    [stylistId, date, BLOCKING_STATUSES]
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

  return { slots: availableSlots, duration, effectiveRanges };
}

// ==================== BOOKING ====================

/**
 * 🎯 DIGITURNO: Crea una cita
 * * IMPORTANTE: La actualización de la cola (last_completed_at) se hace en el CHECKOUT,
 * NO en la creación de la cita.
 */
async function createAppointmentRecord(tenantId, clientId, stylistId, serviceId, startTime, duration) {
  const endTime = new Date(startTime.getTime() + duration * 60000);

  console.log('\n' + '📝'.repeat(40));
  console.log('📝 [DIGITURNO] Creando cita...');
  console.log('   Cliente:', clientId.substring(0, 8) + '...');
  console.log('   Estilista:', stylistId.substring(0, 8) + '...');
  console.log('   Servicio:', serviceId.substring(0, 8) + '...');
  console.log('   Inicio:', startTime.toISOString());
  console.log('   Fin:', endTime.toISOString());

  // 1. Verificar conflictos
  const overlap = await db.query(
    `SELECT id FROM appointments
      WHERE stylist_id=$1 AND status=ANY($4) AND (start_time, end_time) OVERLAPS ($2,$3)`,
    [stylistId, startTime, endTime, BLOCKING_STATUSES]
  );

  if (overlap.rowCount > 0) {
    console.log('❌ [DIGITURNO] Conflicto de horario detectado');
    console.log('📝'.repeat(40) + '\n');
    throw new Error('Conflicto de horario');
  }

  // 2. Crear la cita
  const result = await db.query(
    `INSERT INTO appointments (tenant_id, client_id, stylist_id, service_id, start_time, end_time, status)
      VALUES ($1,$2,$3,$4,$5,$6,'scheduled')
      RETURNING *`,
    [tenantId, clientId, stylistId, serviceId, startTime, endTime]
  );

  const appointment = result.rows[0];
  console.log('✅ [DIGITURNO] Cita creada exitosamente:', appointment.id);

  // ✅ NO actualizar la cola aquí - se hace en checkout
  console.log('ℹ️  [DIGITURNO] La posición en cola se actualizará al completar la cita (checkout)');
  console.log('📝'.repeat(40) + '\n');

  return appointment;
}

// ==================== EXPORTS ====================
module.exports = {
  hasDurationOverrideColumn,
  getServiceDurationMinutes,
  resolveServiceFuzzy,
  resolveStylistFuzzy,
  findAvailableStylists,
  getStylistEffectiveDuration,
  checkStylistOffersService,
  getAvailableSlotsForStylist,
  createAppointmentRecord,
};