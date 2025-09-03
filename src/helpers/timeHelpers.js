// src/helpers/timeHelpers.js

const DAY_KEYS_EN = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"];
const DAY_KEYS_ES = ["lunes","martes","miercoles","miércoles","jueves","viernes","sabado","sábado","domingo"];

const ES_TO_EN = {
  "lunes": "monday",
  "martes": "tuesday",
  "miercoles": "wednesday",
  "miércoles": "wednesday",
  "jueves": "thursday",
  "viernes": "friday",
  "sabado": "saturday",
  "sábado": "saturday",
  "domingo": "sunday",
};

// Valida HH:mm
function isHHmm(s) {
  if (typeof s !== "string") return false;
  const m = s.match(/^(\d{2}):(\d{2})$/);
  if (!m) return false;
  const hh = +m[1], mm = +m[2];
  return hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59;
}

// Normaliza un objeto week con llaves ES/EN a EN y valida
function normalizeWorkingHours(input) {
  if (!input || typeof input !== "object") return null;
  const out = {};
  for (const k of Object.keys(input)) {
    const low = k.toLowerCase();
    const enKey = ES_TO_EN[low] || low;
    if (!DAY_KEYS_EN.includes(enKey)) continue;

    const v = input[k] || {};
    const active = !!v.active;
    let open = v.open ?? v.start ?? v.inicio ?? null;
    let close = v.close ?? v.end ?? v.fin ?? null;

    if (typeof v === "string" && v.toLowerCase().includes("cerrad")) {
      out[enKey] = { active: false, open: null, close: null };
      continue;
    }
    if (active) {
      if (!isHHmm(open) || !isHHmm(close)) {
        throw new Error(`Horario inválido para ${enKey}: formato HH:mm requerido`);
      }
      const [oh, om] = open.split(":").map(Number);
      const [ch, cm] = close.split(":").map(Number);
      if (ch*60+cm <= oh*60+om) {
        throw new Error(`Horario inválido para ${enKey}: close debe ser mayor que open`);
      }
      out[enKey] = { active: true, open, close };
    } else {
      out[enKey] = { active: false, open: null, close: null };
    }
  }
  for (const d of DAY_KEYS_EN) {
    if (!out[d]) out[d] = { active: false, open: null, close: null };
  }
  return out;
}

// Estos helpers ya los tenías en appointmentController.js, los necesitamos aquí también.
function timeToMin(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
}

function intersectRange(r1, r2) {
  const [o1, c1] = r1.split('-').map(s => s.trim());
  const [o2, c2] = r2.split('-').map(s => s.trim());
  const start = Math.max(timeToMin(o1), timeToMin(o2));
  const end   = Math.min(timeToMin(c1), timeToMin(c2));
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

function minToTime(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}


module.exports = {
  normalizeWorkingHours,
  intersectRangesArrays,
  normalizeDayValueToRanges,
};