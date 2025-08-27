// src/controllers/userController.js
const db = require('../config/db');
const bcrypt = require('bcryptjs');

/* =========================================================
   Helpers de horarios (acepta llaves en español o inglés)
   Estructura canónica (inglés):
   {
     "monday":    { "open":"09:00", "close":"17:00", "active": true },
     "tuesday":   { ... },
     ...
     "sunday":    { ... }
   }
========================================================= */

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
    const enKey = ES_TO_EN[low] || low; // si viene en inglés, queda igual
    if (!DAY_KEYS_EN.includes(enKey)) continue;

    const v = input[k] || {};
    const active = !!v.active;

    let open = v.open ?? v.start ?? v.inicio ?? null;
    let close = v.close ?? v.end ?? v.fin ?? null;

    // si viene "cerrado", forzamos inactive
    if (typeof v === "string" && v.toLowerCase().includes("cerrad")) {
      out[enKey] = { active: false, open: null, close: null };
      continue;
    }

    // saneo
    if (active) {
      if (!isHHmm(open) || !isHHmm(close)) {
        throw new Error(`Horario inválido para ${enKey}: formato HH:mm requerido`);
      }
      // open < close
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

  // Rellenar faltantes con inactive
  for (const d of DAY_KEYS_EN) {
    if (!out[d]) out[d] = { active: false, open: null, close: null };
  }
  return out;
}

/* =========================================================
   Crear un nuevo Usuario
========================================================= */
exports.createUser = async (req, res) => {
  const {
    tenant_id, role_id, first_name, last_name,
    email, password, phone,
    payment_type, base_salary, commission_rate,
    working_hours // <- opcional (JSON)
  } = req.body;

  if (!tenant_id || !role_id || !first_name || !email || !password) {
    return res.status(400).json({ error: 'Faltan campos obligatorios.' });
  }

  try {
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);

    let wh = null;
    if (working_hours) {
      try {
        wh = normalizeWorkingHours(working_hours);
      } catch (e) {
        return res.status(400).json({ error: e.message || 'working_hours inválido' });
      }
    }

    const result = await db.query(
      `INSERT INTO users (
         tenant_id, role_id, first_name, last_name, email, password_hash, phone,
         payment_type, base_salary, commission_rate, working_hours
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id, tenant_id, role_id, email, first_name, last_name, payment_type, working_hours`,
      [
        tenant_id, role_id, first_name, last_name || null, email, password_hash, phone || null,
        payment_type || null,
        payment_type === 'salary' ? (base_salary ?? 0) : 0,
        payment_type === 'commission' ? (commission_rate ?? null) : null,
        wh
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error al crear usuario:', error);
    if (error.code === '23505') {
      return res.status(409).json({ error: 'El correo electrónico ya está registrado.' });
    }
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* =========================================================
   Obtener todos los Usuarios por tenant (con filtro rol)
========================================================= */
exports.getAllUsersByTenant = async (req, res) => {
  const { tenantId } = req.params;
  const { role_id } = req.query;

  let baseQuery = `
    SELECT id, role_id, first_name, last_name, email, phone, created_at,
           status, last_service_at, payment_type, base_salary, commission_rate
    FROM users
    WHERE tenant_id = $1
  `;
  const params = [tenantId];

  if (role_id) {
    baseQuery += ' AND role_id = $2';
    params.push(parseInt(role_id, 10));
  }

  baseQuery += ' ORDER BY first_name';

  try {
    const result = await db.query(baseQuery, params);
    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Error al obtener usuarios:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* =========================================================
   Obtener un Usuario por ID (incluye working_hours)
========================================================= */
exports.getUserById = async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query(
      `SELECT id, tenant_id, role_id, first_name, last_name, email, phone, created_at,
              payment_type, base_salary, commission_rate, status, last_service_at, working_hours
       FROM users
       WHERE id = $1`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }
    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error('Error al obtener usuario por ID:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* =========================================================
   Actualizar un Usuario (permite actualizar working_hours)
========================================================= */
exports.updateUser = async (req, res) => {
  const { id } = req.params;
  const {
    first_name, last_name, phone, role_id,
    payment_type, base_salary, commission_rate, status,
    working_hours // <- opcional
  } = req.body;

  let wh = undefined; // no tocar por defecto
  if (working_hours !== undefined) {
    // Permitir setear a null para usar horario del tenant
    if (working_hours === null) {
      wh = null;
    } else {
      try {
        wh = normalizeWorkingHours(working_hours);
      } catch (e) {
        return res.status(400).json({ error: e.message || 'working_hours inválido' });
      }
    }
  }

  // Construir dinámicamente el UPDATE
  const fields = [
    ['first_name', first_name],
    ['last_name', last_name ?? null],
    ['phone', phone ?? null],
    ['role_id', role_id],
    ['payment_type', payment_type ?? null],
    ['base_salary', (payment_type === 'salary') ? (base_salary ?? 0) : 0],
    ['commission_rate', (payment_type === 'commission') ? (commission_rate ?? null) : null],
    ['status', status ?? null],
  ];

  if (wh !== undefined) {
    fields.push(['working_hours', wh]);
  }

  const sets = fields.map((f, i) => `${f[0]} = $${i+1}`).join(', ') + ', updated_at = NOW()';
  const values = fields.map(f => f[1]);
  values.push(id);

  try {
    const result = await db.query(
      `UPDATE users SET ${sets}
       WHERE id = $${values.length}
       RETURNING id, tenant_id, role_id, first_name, last_name, email, phone,
                 payment_type, base_salary, commission_rate, status, working_hours`,
      values
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Usuario no encontrado para actualizar' });
    }
    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error('Error al actualizar usuario:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* =========================================================
   Eliminar un Usuario
========================================================= */
exports.deleteUser = async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query('DELETE FROM users WHERE id = $1', [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'Usuario no encontrado para eliminar' });
    }
    res.status(204).send();
  } catch (error) {
    console.error('Error al eliminar usuario:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* =========================================================
   Endpoints específicos de Working Hours por usuario
========================================================= */

// GET /users/:id/working-hours
exports.getUserWorkingHours = async (req, res) => {
  const { id } = req.params;
  try {
    const r = await db.query('SELECT working_hours FROM users WHERE id = $1', [id]);
    if (r.rows.length === 0) return res.status(404).json({ message: 'Usuario no encontrado' });
    res.status(200).json(r.rows[0].working_hours || null);
  } catch (e) {
    console.error('Error al leer working_hours:', e);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// PUT /users/:id/working-hours
// Body: { week: { monday:{active,open,close}, ... } }  (se acepta ES/EN)
exports.updateUserWorkingHours = async (req, res) => {
  const { id } = req.params;
  const { week } = req.body || {};
  try {
    const wh = week === null ? null : normalizeWorkingHours(week);
    const r = await db.query(
      `UPDATE users
       SET working_hours = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, working_hours`,
      [wh, id]
    );
    if (r.rows.length === 0) return res.status(404).json({ message: 'Usuario no encontrado' });
    res.status(200).json(r.rows[0]);
  } catch (e) {
    console.error('Error al actualizar working_hours:', e);
    res.status(400).json({ error: e.message || 'working_hours inválido' });
  }
};

/* =========================================================
   Siguiente estilista disponible (turnero + horario)
   - role_id = 3 (estilistas)
   - status = 'active'
   - Orden por COALESCE(last_turn_at, last_service_at) ASC NULLS FIRST (si tienes last_turn_at)
   - Excluye estilistas con working_hours "cerrado hoy" (si tienen JSON)
========================================================= */
exports.getNextAvailableStylist = async (req, res) => {
  // auth middleware debe anexar req.user.tenant_id
  const { tenant_id } = req.user || {};
  if (!tenant_id) {
    return res.status(400).json({ error: 'No se pudo identificar el tenant del usuario.' });
  }

  // Día actual en inglés para mapear JSON (server timezone)
  // Si necesitas TZ del tenant, ajusta con AT TIME ZONE en SQL.
  const now = new Date();
  const dayIdx = now.getDay(); // 0=Dom..6=Sab
  const DAY_EN = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"][dayIdx];

  // Tomar la hora local del servidor en HH:mm
  const hh = String(now.getHours()).padStart(2,'0');
  const mm = String(now.getMinutes()).padStart(2,'0');
  const curr = `${hh}:${mm}`;

  // Construye una cláusula para evaluar JSONB:
  // Permitimos:
  //  - Usuarios sin working_hours -> se consideran "abiertos" (heredan tenant)
  //  - Usuarios con working_hours -> deben tener active=true hoy y curr entre open-close
  //
  // NOTA: Comparamos como TIME; si open/close faltan, se descarta
  const sql = `
    SELECT id, first_name, last_name, last_service_at
    FROM users
    WHERE tenant_id = $1
      AND role_id = 3
      AND status = 'active'
      AND (
        working_hours IS NULL
        OR (
          (working_hours->'${DAY_EN}'->>'active')::boolean = TRUE
          AND (working_hours->'${DAY_EN}'->>'open')  IS NOT NULL
          AND (working_hours->'${DAY_EN}'->>'close') IS NOT NULL
          AND (working_hours->'${DAY_EN}'->>'open')::time  <  (working_hours->'${DAY_EN}'->>'close')::time
          AND $2::time >= (working_hours->'${DAY_EN}'->>'open')::time
          AND $2::time <  (working_hours->'${DAY_EN}'->>'close')::time
        )
      )
    ORDER BY
      COALESCE(last_turn_at, last_service_at) ASC NULLS FIRST,
      first_name ASC
    LIMIT 1;
  `;

  try {
    const result = await db.query(sql, [tenant_id, curr]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'No hay estilistas disponibles en este momento.' });
    }
    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error('Error al obtener el siguiente estilista disponible:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* =========================================================
   Buscar usuario por teléfono (mismo tenant)
========================================================= */
exports.getUserByPhone = async (req, res) => {
  const { phoneNumber } = req.params;
  const { tenant_id } = req.user || {};

  if (!phoneNumber) {
    return res.status(400).json({ error: "Número de teléfono no proporcionado." });
  }
  if (!tenant_id) {
    return res.status(400).json({ error: "No se pudo identificar el tenant." });
  }

  try {
    const result = await db.query(
      `SELECT id, tenant_id, role_id, first_name, last_name, email
       FROM users
       WHERE phone = $1 AND tenant_id = $2`,
      [phoneNumber, tenant_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Usuario no encontrado con ese número de teléfono.' });
    }

    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error('Error al buscar usuario por teléfono:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};
