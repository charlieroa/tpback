// src/utils/appointmentHelpers.js
'use strict';

const { formatInTimeZone, toZonedTime } = require('date-fns-tz');
const { addDays, nextDay, parse, isValid, getDay } = require('date-fns');
const { es } = require('date-fns/locale');

// ==================== CONSTANTES ====================
const TIME_ZONE = 'America/Bogota';

const BLOCKING_STATUSES = [
  'scheduled',
  'rescheduled',
  'checked_in',
  'checked_out',
  'pending_approval',
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ==================== PALABRAS CLAVE DE FECHA (NO SON HORAS) ====================
/**
 * 🔴 IMPORTANTE: Lista de palabras que son FECHAS, no HORAS
 * Estas palabras NO deben procesarse como hora
 */
const DATE_KEYWORDS_REGEX = /^(hoy|mañana|manana|pasado\s*mañana|pasado\s*manana|lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo|tomorrow|today|en\s*\d+\s*d[ií]as?|en\s*una?\s*semanas?|el\s*\d{1,2}|para\s*el\s*\d{1,2})$/i;

/**
 * Verifica si un string es una palabra clave de fecha (no hora)
 */
function isDateKeyword(str) {
  if (!str) return false;
  const cleaned = clean(str).toLowerCase();
  return DATE_KEYWORDS_REGEX.test(cleaned);
}

// ==================== UTILIDADES BÁSICAS ====================

function clean(v) {
  if (v == null) return '';
  return String(v).trim();
}

/**
 * 🔴 CORREGIDO: cleanHHMM ahora detecta palabras de fecha y las ignora
 */
function cleanHHMM(v) {
  const s = clean(v);
  if (!s) return '';

  // Si ya es HH:mm válido, devolverlo
  if (/^\d{2}:\d{2}$/.test(s)) return s;

  // 🔴 IMPORTANTE: Detectar palabras de FECHA que NO son horas
  // Esto evita que "mañana", "pasado mañana", etc. se procesen como hora
  if (isDateKeyword(s)) {
    console.log(`⚠️ [cleanHHMM] "${s}" es una palabra de FECHA, no de hora. Ignorando.`);
    return '';
  }

  // Intentar normalizar como hora
  return normalizeHumanTimeToHHMM(s) || s;
}

// ==================== NORMALIZACIÓN DE FECHAS ====================

/**
 * Mapeo de días de la semana en español a número (0=domingo, 1=lunes, etc.)
 */
const DAY_NAME_TO_NUMBER = {
  'domingo': 0,
  'lunes': 1,
  'martes': 2,
  'miercoles': 3,
  'miércoles': 3,
  'jueves': 4,
  'viernes': 5,
  'sabado': 6,
  'sábado': 6,
};

/**
 * Mapeo de meses en español
 */
const MONTH_NAME_TO_NUMBER = {
  'enero': 0,
  'febrero': 1,
  'marzo': 2,
  'abril': 3,
  'mayo': 4,
  'junio': 5,
  'julio': 6,
  'agosto': 7,
  'septiembre': 8,
  'setiembre': 8,
  'octubre': 9,
  'noviembre': 10,
  'diciembre': 11,
};

/**
 * Obtiene la fecha actual en la zona horaria de Colombia
 * @returns {Date} Fecha actual en Colombia
 */
function getTodayInTimeZone() {
  const now = new Date();
  const todayStr = formatInTimeZone(now, TIME_ZONE, 'yyyy-MM-dd');
  return new Date(todayStr + 'T00:00:00');
}

/**
 * Formatea una fecha a YYYY-MM-DD
 * @param {Date} date 
 * @returns {string}
 */
function formatDateToYYYYMMDD(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Encuentra el próximo día de la semana a partir de hoy
 * @param {number} targetDay - Día objetivo (0=domingo, 1=lunes, etc.)
 * @param {Date} fromDate - Fecha desde la cual buscar
 * @returns {Date}
 */
function getNextDayOfWeek(targetDay, fromDate) {
  const currentDay = fromDate.getDay();
  let daysUntilTarget = targetDay - currentDay;

  // Si el día ya pasó esta semana, ir a la próxima semana
  if (daysUntilTarget <= 0) {
    daysUntilTarget += 7;
  }

  return addDays(fromDate, daysUntilTarget);
}

/**
 * 🎯 FUNCIÓN PRINCIPAL: Normaliza palabras clave de fecha a YYYY-MM-DD
 * Soporta:
 * - "hoy", "mañana", "pasado mañana"
 * - "el lunes", "este viernes", "el próximo sábado"
 * - "1 de febrero", "15 de marzo", "20 de diciembre"
 * - "en 3 días", "en una semana"
 * - Formato YYYY-MM-DD (pasa directo)
 * - Formato DD/MM/YYYY o DD-MM-YYYY
 * 
 * @param {string} input - Entrada del usuario
 * @returns {string} Fecha en formato YYYY-MM-DD o string vacío si no se pudo parsear
 */
function normalizeDateKeyword(input) {
  if (!input) return '';

  const raw = clean(input).toLowerCase();

  // Si ya es YYYY-MM-DD, devolverlo
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw;
  }

  const today = getTodayInTimeZone();

  console.log('📅 [normalizeDateKeyword] Input:', input);
  console.log('   Raw (lowercase):', raw);
  console.log('   Today:', formatDateToYYYYMMDD(today));

  // ===== 1. PALABRAS CLAVE SIMPLES =====

  // "hoy"
  if (/^(hoy|today)$/.test(raw)) {
    const result = formatDateToYYYYMMDD(today);
    console.log('   ✅ Detectado: hoy →', result);
    return result;
  }

  // "mañana" - con múltiples variantes de escritura
  if (/^(mañana|manana|mañ|tomorrow)$/i.test(raw)) {
    const result = formatDateToYYYYMMDD(addDays(today, 1));
    console.log('   ✅ Detectado: mañana →', result);
    return result;
  }

  // "pasado mañana" - con múltiples variantes
  if (/^(pasado\s*mañana|pasado\s*manana|pasadomañana|pasadomanana)$/i.test(raw)) {
    const result = formatDateToYYYYMMDD(addDays(today, 2));
    console.log('   ✅ Detectado: pasado mañana →', result);
    return result;
  }

  // ===== 2. DÍAS DE LA SEMANA =====
  // "el lunes", "este martes", "el próximo viernes", "para el sábado"

  const dayMatch = raw.match(/(?:el|este|esta|próximo|proximo|para\s*el|para)?\s*(lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo)/i);
  if (dayMatch) {
    const dayName = dayMatch[1].toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const dayNameNormalized = dayName === 'miercoles' ? 'miércoles' : dayName === 'sabado' ? 'sábado' : dayName;
    const targetDay = DAY_NAME_TO_NUMBER[dayNameNormalized] ?? DAY_NAME_TO_NUMBER[dayName];

    if (targetDay !== undefined) {
      const nextDate = getNextDayOfWeek(targetDay, today);
      const result = formatDateToYYYYMMDD(nextDate);
      console.log(`   ✅ Detectado: día de semana "${dayMatch[1]}" →`, result);
      return result;
    }
  }

  // ===== 3. FECHA CON MES EN TEXTO =====
  // "1 de febrero", "15 de marzo", "el 20 de diciembre", "para el 5 de enero"

  const dateWithMonthMatch = raw.match(/(?:el|para\s*el)?\s*(\d{1,2})\s*(?:de|del)?\s*(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(?:\s*(?:de|del)?\s*(\d{4}))?/i);
  if (dateWithMonthMatch) {
    const day = parseInt(dateWithMonthMatch[1], 10);
    const monthName = dateWithMonthMatch[2].toLowerCase();
    const month = MONTH_NAME_TO_NUMBER[monthName];
    let year = dateWithMonthMatch[3] ? parseInt(dateWithMonthMatch[3], 10) : today.getFullYear();

    // Si el mes ya pasó este año, asumir el próximo año
    const tentativeDate = new Date(year, month, day);
    if (tentativeDate < today && !dateWithMonthMatch[3]) {
      year += 1;
    }

    const result = formatDateToYYYYMMDD(new Date(year, month, day));
    console.log(`   ✅ Detectado: "${day} de ${monthName}" →`, result);
    return result;
  }

  // ===== 4. "EN X DÍAS" / "EN UNA SEMANA" =====

  // "en 3 días", "en 5 dias"
  const inDaysMatch = raw.match(/en\s*(\d+)\s*d[ií]as?/i);
  if (inDaysMatch) {
    const days = parseInt(inDaysMatch[1], 10);
    const result = formatDateToYYYYMMDD(addDays(today, days));
    console.log(`   ✅ Detectado: "en ${days} días" →`, result);
    return result;
  }

  // "en una semana", "en 1 semana", "en 2 semanas"
  const inWeeksMatch = raw.match(/en\s*(?:una|(\d+))\s*semanas?/i);
  if (inWeeksMatch) {
    const weeks = inWeeksMatch[1] ? parseInt(inWeeksMatch[1], 10) : 1;
    const result = formatDateToYYYYMMDD(addDays(today, weeks * 7));
    console.log(`   ✅ Detectado: "en ${weeks} semana(s)" →`, result);
    return result;
  }

  // ===== 5. FORMATOS NUMÉRICOS =====

  // DD/MM/YYYY o DD-MM-YYYY
  const ddmmyyyyMatch = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (ddmmyyyyMatch) {
    const day = parseInt(ddmmyyyyMatch[1], 10);
    const month = parseInt(ddmmyyyyMatch[2], 10) - 1;
    const year = parseInt(ddmmyyyyMatch[3], 10);
    const result = formatDateToYYYYMMDD(new Date(year, month, day));
    console.log(`   ✅ Detectado: formato DD/MM/YYYY →`, result);
    return result;
  }

  // DD/MM o DD-MM (sin año, asumir año actual o próximo)
  const ddmmMatch = raw.match(/^(\d{1,2})[\/\-](\d{1,2})$/);
  if (ddmmMatch) {
    const day = parseInt(ddmmMatch[1], 10);
    const month = parseInt(ddmmMatch[2], 10) - 1;
    let year = today.getFullYear();

    const tentativeDate = new Date(year, month, day);
    if (tentativeDate < today) {
      year += 1;
    }

    const result = formatDateToYYYYMMDD(new Date(year, month, day));
    console.log(`   ✅ Detectado: formato DD/MM →`, result);
    return result;
  }

  // ===== 6. SOLO NÚMERO (ASUMIR DÍA DEL MES ACTUAL O PRÓXIMO) =====
  // "el 15", "para el 20", "día 5"

  const dayOnlyMatch = raw.match(/(?:el|para\s*el|d[ií]a)?\s*(\d{1,2})$/);
  if (dayOnlyMatch) {
    const day = parseInt(dayOnlyMatch[1], 10);
    if (day >= 1 && day <= 31) {
      let month = today.getMonth();
      let year = today.getFullYear();

      // Si el día ya pasó este mes, ir al próximo mes
      if (day < today.getDate()) {
        month += 1;
        if (month > 11) {
          month = 0;
          year += 1;
        }
      }

      const result = formatDateToYYYYMMDD(new Date(year, month, day));
      console.log(`   ✅ Detectado: solo día "${day}" →`, result);
      return result;
    }
  }

  console.log('   ⚠️ No se pudo parsear la fecha');
  return '';
}

// ==================== NORMALIZACIÓN DE HORAS ====================

/**
 * 🎯 FUNCIÓN PRINCIPAL: Normaliza texto de hora humana a formato HH:mm
 * Soporta:
 * - "9am", "9 am", "9:00am", "9:30 am"
 * - "5pm", "5 pm", "5:00pm", "5:30 pm"
 * - "14:30", "9:00"
 * - "a las 9", "a las 5 de la tarde"
 * - "9 de la mañana", "3 de la tarde", "9 de la noche"
 * - "mediodía", "medianoche"
 * - "tipo 10", "como a las 3"
 * 
 * 🔴 IMPORTANTE: NO procesa palabras de fecha como "mañana", "pasado mañana", etc.
 * 
 * @param {string} input - Entrada del usuario
 * @returns {string} Hora en formato HH:mm o string vacío
 */
function normalizeHumanTimeToHHMM(input) {
  if (!input) return '';

  const raw = clean(input).toLowerCase();

  // Si ya es HH:mm válido, devolverlo
  if (/^\d{2}:\d{2}$/.test(raw)) {
    return raw;
  }

  console.log('🕐 [normalizeHumanTimeToHHMM] Input:', input);
  console.log('   Input procesado (lowercase):', raw);

  // 🔴 IMPORTANTE: Detectar palabras de FECHA que NO son horas
  // Palabras como "mañana", "pasado mañana", días de la semana, etc.
  const dateOnlyPatterns = [
    /^(hoy|today)$/i,
    /^(mañana|manana|tomorrow)$/i,
    /^(pasado\s*mañana|pasado\s*manana|pasadomañana|pasadomanana)$/i,
    /^(lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo)$/i,
    /^(el\s*)?(lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo)$/i,
    /^en\s*\d+\s*d[ií]as?$/i,
    /^en\s*una?\s*semanas?$/i,
  ];

  for (const pattern of dateOnlyPatterns) {
    if (pattern.test(raw)) {
      console.log(`   ⚠️ "${raw}" es una palabra de FECHA, no de hora. Retornando vacío.`);
      return '';
    }
  }

  // ===== CASOS ESPECIALES =====

  if (/^(mediod[ií]a|noon)$/.test(raw)) {
    console.log('   ✅ Resultado final: 12:00');
    return '12:00';
  }

  if (/^(medianoche|midnight)$/.test(raw)) {
    console.log('   ✅ Resultado final: 00:00');
    return '00:00';
  }

  // ===== EXTRAER HORA Y MINUTOS =====

  let hour = null;
  let minute = 0;
  let isPM = false;
  let isAM = false;
  let isTarde = false;
  let isNoche = false;
  let isMañana = false;

  // Detectar indicadores de AM/PM
  if (/\bam\b|a\.m\.?/i.test(raw)) isAM = true;
  if (/\bpm\b|p\.m\.?/i.test(raw)) isPM = true;
  if (/de\s*la\s*tarde/i.test(raw)) isTarde = true;
  if (/de\s*la\s*noche/i.test(raw)) isNoche = true;
  if (/de\s*la\s*mañana|de\s*la\s*manana/i.test(raw)) isMañana = true;

  // Patrón: HH:mm (con o sin am/pm)
  const hhmmMatch = raw.match(/(\d{1,2}):(\d{2})/);
  if (hhmmMatch) {
    hour = parseInt(hhmmMatch[1], 10);
    minute = parseInt(hhmmMatch[2], 10);
    console.log(`   Hora extraída (HH:mm): ${hour}:${minute} | AM/PM: ${isAM ? 'AM' : isPM ? 'PM' : 'no especificado'}`);
  }

  // Patrón: solo número con am/pm o contexto
  // "9am", "5pm", "9 am", "5 pm", "a las 9", "tipo 10", "como a las 3"
  if (hour === null) {
    const hourOnlyMatch = raw.match(/(?:a\s*las|tipo|como\s*a\s*las|para\s*las)?\s*(\d{1,2})(?:\s*(?:am|pm|a\.m\.?|p\.m\.?|de\s*la|horas?))?/i);
    if (hourOnlyMatch) {
      const extractedHour = parseInt(hourOnlyMatch[1], 10);

      // 🔴 Validar que sea una hora razonable (1-24)
      // Esto evita que números grandes como "2026" se interpreten como hora
      if (extractedHour >= 1 && extractedHour <= 24) {
        hour = extractedHour;
        console.log(`   Hora extraída (solo número): ${hour} | AM/PM: ${isAM ? 'AM' : isPM ? 'PM' : isTarde ? 'tarde' : isNoche ? 'noche' : isMañana ? 'mañana' : 'no especificado'}`);
      }
    }
  }

  if (hour === null) {
    console.log('   ⚠️ No se pudo extraer la hora');
    return '';
  }

  // ===== AJUSTAR HORA SEGÚN AM/PM =====

  // Convertir a formato 24h
  if (isPM || isTarde) {
    if (hour < 12) hour += 12;
  } else if (isAM || isMañana) {
    if (hour === 12) hour = 0;
  } else if (isNoche) {
    // "de la noche" típicamente es 7pm-11pm
    if (hour < 12) hour += 12;
  } else {
    // Sin indicador: usar heurística
    // Horas 1-6 sin indicador probablemente son PM (tarde)
    // Horas 7-11 sin indicador probablemente son AM (mañana)
    if (hour >= 1 && hour <= 6) {
      // Ambiguo: podría ser mañana o tarde
      // Por defecto, asumir PM para horarios de peluquería
      hour += 12;
    }
    // Horas 7-11 dejamos como están (mañana)
    // Hora 12 dejamos como está (mediodía)
  }

  // Validar rango
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    console.log('   ⚠️ Hora fuera de rango');
    return '';
  }

  const result = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  console.log(`   ✅ Resultado final: ${result}`);
  return result;
}

// ==================== MANEJO DE HORARIOS ====================

/**
 * Convierte HH:mm a minutos desde medianoche
 */
function timeToMin(hhmm) {
  if (!hhmm || typeof hhmm !== 'string') return 0;
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/**
 * Convierte minutos desde medianoche a HH:mm
 */
function minToTime(min) {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Normaliza el valor de un día a un array de rangos horarios
 */
function normalizeDayValueToRanges(val) {
  if (val == null) return [];

  if (typeof val === 'string') {
    const raw = val.trim();
    const s = raw.toLowerCase();
    if (s === 'cerrado' || s === 'closed' || s === '') return [];
    if (s.includes('-')) return [raw];
    return [];
  }

  if (typeof val === 'object') {
    const active = val.active !== false;
    if (!active) return [];
    if (Array.isArray(val.ranges) && val.ranges.length > 0) return val.ranges;
    if (val.open && val.close) return [`${val.open}-${val.close}`];
  }

  return [];
}

/**
 * Intersecta dos rangos horarios
 */
function intersectRange(r1, r2) {
  const [o1, c1] = r1.split('-').map(s => s.trim());
  const [o2, c2] = r2.split('-').map(s => s.trim());
  const start = Math.max(timeToMin(o1), timeToMin(o2));
  const end = Math.min(timeToMin(c1), timeToMin(c2));
  if (end > start) return `${minToTime(start)}-${minToTime(end)}`;
  return null;
}

/**
 * Intersecta dos arrays de rangos horarios
 */
function intersectRangesArrays(rangesA, rangesB) {
  if (!Array.isArray(rangesA) || !Array.isArray(rangesB)) return [];
  const out = [];
  for (const a of rangesA) {
    for (const b of rangesB) {
      const inter = intersectRange(a, b);
      if (inter) out.push(inter);
    }
  }
  return out;
}

/**
 * Mapeo de nombres de días en español/inglés
 */
const ES_TO_EN_DAY = {
  'lunes': 'monday',
  'martes': 'tuesday',
  'miercoles': 'wednesday',
  'miércoles': 'wednesday',
  'jueves': 'thursday',
  'viernes': 'friday',
  'sabado': 'saturday',
  'sábado': 'saturday',
  'domingo': 'sunday',
};

const DAY_KEYS_EN = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * Obtiene el nombre del día en inglés para una fecha
 */
function getDayNameEN(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return DAY_KEYS_EN[d.getDay()];
}

/**
 * Obtiene los rangos horarios de un objeto working_hours para un día específico
 */
function getDayRangesFromWorkingHours(workingHours, dateStr) {
  if (!workingHours || typeof workingHours !== 'object') return [];

  const dayEN = getDayNameEN(dateStr);

  // Buscar la clave (puede ser en español o inglés)
  let dayValue = workingHours[dayEN];

  if (dayValue === undefined) {
    // Buscar en español
    for (const [es, en] of Object.entries(ES_TO_EN_DAY)) {
      if (en === dayEN && workingHours[es]) {
        dayValue = workingHours[es];
        break;
      }
    }
  }

  return normalizeDayValueToRanges(dayValue);
}

/**
 * Obtiene los rangos efectivos de un estilista para un día
 */
function getEffectiveStylistDayRanges(stylistWH, tenantWH, dateStr) {
  // Si el estilista no tiene horarios propios, usar los del tenant
  if (!stylistWH || Object.keys(stylistWH).length === 0) {
    return getDayRangesFromWorkingHours(tenantWH, dateStr);
  }

  return getDayRangesFromWorkingHours(stylistWH, dateStr);
}

/**
 * Verifica si un rango de tiempo está dentro de los rangos permitidos
 */
function isWithinRanges(dateStr, ranges, startDateTime, endDateTime) {
  if (!Array.isArray(ranges) || ranges.length === 0) return false;

  const startMin = startDateTime.getHours() * 60 + startDateTime.getMinutes();
  const endMin = endDateTime.getHours() * 60 + endDateTime.getMinutes();

  for (const range of ranges) {
    const [open, close] = range.split('-').map(s => s.trim());
    const openMin = timeToMin(open);
    const closeMin = timeToMin(close);

    if (startMin >= openMin && endMin <= closeMin) {
      return true;
    }
  }

  return false;
}

/**
 * Construye slots de tiempo a partir de rangos horarios
 */
function buildSlotsFromRanges(dateStr, ranges, stepMinutes = 15) {
  const slots = [];

  for (const range of ranges) {
    const [open, close] = range.split('-').map(s => s.trim());
    let currentMin = timeToMin(open);
    const closeMin = timeToMin(close);

    while (currentMin < closeMin) {
      const hh = String(Math.floor(currentMin / 60)).padStart(2, '0');
      const mm = String(currentMin % 60).padStart(2, '0');
      const slotDate = makeLocalUtc(dateStr, `${hh}:${mm}`);
      slots.push(slotDate);
      currentMin += stepMinutes;
    }
  }

  return slots;
}

// ==================== CONVERSIÓN DE FECHAS/HORAS ====================

/**
 * Crea un objeto Date UTC a partir de fecha local y hora local
 * Ejemplo: makeLocalUtc('2026-01-20', '09:00') para Colombia
 */
function makeLocalUtc(dateStr, timeStr) {
  const t = timeStr && timeStr.length >= 5 ? timeStr.slice(0, 5) : '00:00';
  const localStr = `${dateStr}T${t}:00`;

  // Crear fecha en zona horaria de Colombia y convertir a UTC
  const localDate = new Date(localStr);

  // Colombia es UTC-5
  const offsetMs = 5 * 60 * 60 * 1000;
  const utcDate = new Date(localDate.getTime() + offsetMs);

  return utcDate;
}

/**
 * Convierte un Date UTC a hora local HH:mm (24 horas)
 */
function toLocalHHmm(utcDate) {
  return formatInTimeZone(utcDate, TIME_ZONE, 'HH:mm');
}

/**
 * Convierte un Date UTC a hora local en formato 12 horas (h:mm AM/PM)
 */
function toLocal12Hour(utcDate) {
  return formatInTimeZone(utcDate, TIME_ZONE, 'h:mm a', { locale: require('date-fns/locale/es') });
}

/**
 * Convierte HH:mm (24h) a formato 12 horas (h:mm AM/PM)
 */
function convert24to12(hhmm24) {
  if (!hhmm24 || typeof hhmm24 !== 'string') return hhmm24;
  const [hours, minutes] = hhmm24.split(':').map(Number);
  if (isNaN(hours) || isNaN(minutes)) return hhmm24;
  
  const period = hours >= 12 ? 'PM' : 'AM';
  const hour12 = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
  return `${hour12}:${String(minutes).padStart(2, '0')} ${period}`;
}

/**
 * Convierte un Date UTC a ISO local
 */
function toLocalISO(utcDate) {
  return formatInTimeZone(utcDate, TIME_ZONE, "yyyy-MM-dd'T'HH:mm:ss");
}

// ==================== EXPORTS ====================

module.exports = {
  // Constantes
  TIME_ZONE,
  BLOCKING_STATUSES,
  UUID_RE,

  // Utilidades básicas
  clean,
  cleanHHMM,
  isDateKeyword,

  // Normalización de fechas y horas
  normalizeDateKeyword,
  normalizeHumanTimeToHHMM,

  // Manejo de horarios
  timeToMin,
  minToTime,
  normalizeDayValueToRanges,
  intersectRange,
  intersectRangesArrays,
  getDayRangesFromWorkingHours,
  getEffectiveStylistDayRanges,
  isWithinRanges,
  buildSlotsFromRanges,

  // Conversión de fechas/horas
  makeLocalUtc,
  toLocalHHmm,
  toLocal12Hour,
  convert24to12,
  toLocalISO,
};