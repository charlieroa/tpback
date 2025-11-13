// src/utils/appointmentHelpers.js
'use strict';

const { zonedTimeToUtc, utcToZonedTime, formatInTimeZone } = require('date-fns-tz');

// ==================== CONSTANTES ====================
const TIME_ZONE = 'America/Bogota';

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

// ==================== LIMPIEZA ====================
const clean = v => (v ?? '').toString().trim();

const cleanHHMM = v => {
  const s = clean(v);
  if (!s) return s;
  const m = s.match(/^(\d{1,2})(?::?(\d{2}))?/);
  if (!m) return s.slice(0, 5);
  const h = String(Math.min(23, parseInt(m[1] || '0', 10))).padStart(2, '0');
  const mm = String(Math.min(59, parseInt(m[2] || '0', 10))).padStart(2, '0');
  return `${h}:${mm}`;
};

// ==================== CONVERSIONES DE TIEMPO ====================
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

function toLocalHHmm(date) {
  return formatInTimeZone(date, TIME_ZONE, 'HH:mm');
}

function toLocalISO(date) {
  return formatInTimeZone(date, TIME_ZONE, "yyyy-MM-dd'T'HH:mm:ssXXX");
}

// ==================== NORMALIZACIÓN ====================
function normalizeDateKeyword(dateStr) {
  if (!dateStr) return dateStr;
  const s = String(dateStr).toLowerCase();
  const now = new Date();
  const today = formatInTimeZone(now, TIME_ZONE, 'yyyy-MM-dd');
  const tomorrow = formatInTimeZone(new Date(now.getTime() + 24 * 60 * 60 * 1000), TIME_ZONE, 'yyyy-MM-dd');
  if (s.includes('mañana')) return tomorrow;
  if (s.includes('hoy')) return today;
  return dateStr;
}

function normalizeHumanTimeToHHMM(t) {
  if (!t) return t;
  
  const original = String(t).trim();
  let s = original.toLowerCase().replace(/\s+/g, '');
  
  console.log('🕐 [normalizeHumanTimeToHHMM] Input:', original);
  console.log('   Input procesado (sin espacios):', s);
  
  // Buscar patrón: número + opcional(:minutos) + opcional(am/pm)
  const m = s.match(/^(\d{1,2})(?::?(\d{2}))?(am|pm)?$/);
  if (!m) {
    console.log('   ⚠️ No match con regex, usando cleanHHMM');
    return cleanHHMM(t);
  }
  
  let h = parseInt(m[1], 10);
  let mm = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3];
  
  console.log('   Hora extraída:', h, '| Minuto:', mm, '| AM/PM:', ampm || 'no especificado');
  
  // Convertir 12h a 24h
  if (ampm === 'pm' && h < 12) {
    h += 12;
    console.log('   🔄 Convertido PM a 24h:', h);
  }
  if (ampm === 'am' && h === 12) {
    h = 0;
    console.log('   🔄 Convertido 12 AM a 00');
  }
  
  const result = `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  console.log('   ✅ Resultado final:', result);
  
  return result;
}

// ==================== RANGOS ====================
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

function isWithinRanges(dateStr, ranges, startUtc, endUtc) {
  if (!ranges || ranges.length === 0) return false;
  return ranges.some(r => {
    const [o, c] = r.split('-').map(s => s.trim());
    const openDT  = makeLocalUtc(dateStr, o);
    const closeDT = makeLocalUtc(dateStr, c);
    return startUtc >= openDT && endUtc <= closeDT;
  });
}

// ==================== SLOTS ====================
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

// ==================== WORKING HOURS ====================
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

// ==================== EXPORTS ====================
module.exports = {
  // Constantes
  TIME_ZONE,
  BLOCKING_STATUSES,
  DAY_KEYS_SPA,
  DAY_KEYS_ENG,
  UUID_RE,
  
  // Limpieza
  clean,
  cleanHHMM,
  
  // Tiempo
  makeLocalUtc,
  getLocalJsDow,
  toLocalHHmm,
  toLocalISO,
  
  // Normalización
  normalizeDateKeyword,
  normalizeHumanTimeToHHMM,
  
  // Rangos
  normalizeDayValueToRanges,
  timeToMin,
  minToTime,
  intersectRange,
  intersectRangesArrays,
  isWithinRanges,
  
  // Slots
  buildSlotsFromRanges,
  
  // Working Hours
  getDayRangesFromWorkingHours,
  getEffectiveStylistDayRanges,
};