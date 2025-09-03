// src/controllers/userController.js
const db = require('../config/db');
const bcrypt = require('bcryptjs');

// Helpers de horarios centralizados
const {
  normalizeWorkingHours,
  intersectRangesArrays,
  normalizeDayValueToRanges,
} = require('../helpers/timeHelpers');

/* ===========================================
   Utilidades locales
=========================================== */
const safeJSON = (s) => { try { return JSON.parse(s); } catch { return null; } };

const dbToApiUser = (row) => ({
  id: row.id,
  tenant_id: row.tenant_id,
  role_id: row.role_id,
  first_name: row.first_name,
  last_name: row.last_name,
  email: row.email,
  phone: row.phone,
  payment_type: row.payment_type,
  base_salary: row.base_salary,
  commission_rate: row.commission_rate,
  status: row.status,
  last_service_at: row.last_service_at,
  last_turn_at: row.last_turn_at,
  // Puede venir string JSON o json o null
  working_hours: typeof row.working_hours === 'string'
    ? safeJSON(row.working_hours)
    : row.working_hours ?? null,
});

const minutesFromHHMM = (hhmm) => {
  if (!hhmm || typeof hhmm !== 'string') return null;
  const [h, m] = hhmm.split(':').map(n => parseInt(n, 10));
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
};

/* ===========================================
   Validación: horario de estilista dentro del tenant
=========================================== */
const validateStylistWorkingHoursAgainstTenant = async (tenantId, stylistHours) => {
  if (!stylistHours) return; // hereda o sin horario

  // 1) Horario del tenant
  const tenantResult = await db.query('SELECT working_hours FROM tenants WHERE id = $1', [tenantId]);
  const tenantWorkingHours = tenantResult.rows[0]?.working_hours;

  // Si el tenant no tiene horario definido, no validamos contra nada.
  if (!tenantWorkingHours) return;

  const tenantDays = Object.keys(tenantWorkingHours);
  for (const day of tenantDays) {
    const sDay = stylistHours?.[day];
    const tDay = tenantWorkingHours?.[day];

    // Si el estilista marca activo y el salón no, error
    if (sDay?.active && !tDay?.active) {
      throw new Error(`El estilista no puede trabajar el ${day} si el salón está cerrado.`);
    }

    const stylistRanges = normalizeDayValueToRanges(sDay);
    const tenantRanges  = normalizeDayValueToRanges(tDay);
    const commonRanges  = intersectRangesArrays(stylistRanges, tenantRanges);

    if (sDay?.active && commonRanges.length === 0) {
      throw new Error(`El horario del estilista el ${day} no coincide con el horario del salón.`);
    }
  }
};

/* =========================================================
   Crear un nuevo Usuario
   - Respeta working_hours = null (herencia)
========================================================= */
exports.createUser = async (req, res) => {
  const {
    tenant_id, role_id, first_name, last_name,
    email, password, phone,
    payment_type, base_salary, commission_rate,
    working_hours,
  } = req.body;

  const isStylist = parseInt(role_id, 10) === 3;

  if (!tenant_id || !role_id || !first_name || !email || !password) {
    return res.status(400).json({ error: 'Faltan campos obligatorios.' });
  }
  if (isStylist && !tenant_id) {
    return res.status(400).json({ error: 'Faltan campos obligatorios para crear un estilista.' });
  }

  try {
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);

    // working_hours: null => hereda; objeto => normalizar y validar
    let wh = null;
    if (working_hours !== undefined && working_hours !== null) {
      try {
        wh = normalizeWorkingHours(working_hours);
        if (isStylist) {
          await validateStylistWorkingHoursAgainstTenant(tenant_id, wh);
        }
      } catch (e) {
        return res.status(400).json({ error: e.message || 'working_hours inválido' });
      }
    } // si viene undefined o null => null (hereda)

    const result = await db.query(
      `INSERT INTO users (
        tenant_id, role_id, first_name, last_name, email, password_hash, phone,
        payment_type, base_salary, commission_rate, working_hours
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING id, tenant_id, role_id, email, first_name, last_name, payment_type, base_salary, commission_rate, working_hours`,
      [
        tenant_id,
        role_id,
        first_name,
        last_name || null,
        email,
        password_hash,
        phone || null,
        payment_type || null,
        payment_type === 'salary' ? (base_salary ?? 0) : 0,
        payment_type === 'commission' ? (commission_rate ?? null) : null,
        wh,
      ]
    );

    return res.status(201).json(dbToApiUser(result.rows[0]));
  } catch (error) {
    console.error('Error al crear usuario:', error);
    if (error.code === '23505') {
      return res.status(409).json({ error: 'El correo electrónico ya está registrado.' });
    }
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* =========================================================
   Obtener todos los Usuarios por tenant (con filtro rol)
========================================================= */
exports.getAllUsersByTenant = async (req, res) => {
  const { tenantId } = req.params;
  const { role_id } = req.query;

  if (!tenantId) {
    return res.status(400).json({ error: 'El ID del tenant es obligatorio.' });
  }

  let sql = `
    SELECT id, tenant_id, role_id, first_name, last_name, email, phone, created_at,
           status, last_service_at, payment_type, base_salary, commission_rate
    FROM users
    WHERE tenant_id = $1
  `;
  const params = [tenantId];

  if (role_id) {
    sql += ' AND role_id = $2';
    params.push(parseInt(role_id, 10));
  }

  sql += ' ORDER BY first_name';

  try {
    const r = await db.query(sql, params);
    return res.status(200).json(r.rows.map(dbToApiUser));
  } catch (error) {
    console.error('Error al obtener usuarios:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* =========================================================
   Obtener un Usuario por ID (incluye working_hours)
========================================================= */
exports.getUserById = async (req, res) => {
  const { id } = req.params;
  try {
    const r = await db.query(
      `SELECT id, tenant_id, role_id, first_name, last_name, email, phone, created_at,
              payment_type, base_salary, commission_rate, status, last_service_at, last_turn_at,
              working_hours
       FROM users
       WHERE id = $1`,
      [id]
    );
    if (r.rows.length === 0) {
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }
    return res.status(200).json(dbToApiUser(r.rows[0]));
  } catch (error) {
    console.error('Error al obtener usuario por ID:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* =========================================================
   Actualizar un Usuario
   - Respeta working_hours = null (hereda)
   - No pisa salario/comisión si no cambias payment_type
========================================================= */
exports.updateUser = async (req, res) => {
  const { id } = req.params;
  const {
    first_name, last_name, phone, role_id,
    payment_type, base_salary, commission_rate, status,
    working_hours,
  } = req.body || {};

  try {
    // Traer estado actual para tomar decisiones
    const curRes = await db.query(
      `SELECT tenant_id, role_id, payment_type AS cur_payment_type,
              base_salary AS cur_base_salary, commission_rate AS cur_commission_rate
       FROM users WHERE id = $1`,
      [id]
    );
    if (curRes.rows.length === 0) {
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }

    const { tenant_id, role_id: curRoleId, cur_payment_type, cur_base_salary, cur_commission_rate } = curRes.rows[0];

    // ¿Estilista?
    const nextRoleId = role_id ?? curRoleId;
    const isStylist = parseInt(nextRoleId, 10) === 3;

    // working_hours: undefined => no tocar; null => hereda; objeto => normalizar + validar
    let wh = undefined;
    if (working_hours !== undefined) {
      if (working_hours === null) {
        wh = null; // hereda
      } else {
        try {
          wh = normalizeWorkingHours(working_hours);
          if (isStylist) {
            await validateStylistWorkingHoursAgainstTenant(tenant_id, wh);
          }
        } catch (e) {
          return res.status(400).json({ error: e.message || 'working_hours inválido' });
        }
      }
    }

    // Construcción dinámica del UPDATE
    const fields = [];
    const values = [];

    const push = (k, v) => { fields.push(`${k} = $${fields.length + 1}`); values.push(v); };

    if (first_name !== undefined) push('first_name', first_name);
    if (last_name  !== undefined) push('last_name', last_name);
    if (phone      !== undefined) push('phone', phone);
    if (role_id    !== undefined) push('role_id', role_id);
    if (status     !== undefined) push('status', status);

    // Lógica de pagos:
    if (payment_type !== undefined) {
      // Cambia tipo de pago: forzar consistencia de montos
      push('payment_type', payment_type);
      if (payment_type === 'salary') {
        push('base_salary', base_salary ?? cur_base_salary ?? 0);
        push('commission_rate', null);
      } else if (payment_type === 'commission') {
        push('base_salary', 0);
        push('commission_rate', commission_rate ?? cur_commission_rate ?? null);
      } else {
        // tipo desconocido -> limpia ambos
        push('base_salary', 0);
        push('commission_rate', null);
      }
    } else {
      // No cambia el tipo => solo actualiza si me pasan explícitamente
      if (base_salary !== undefined) push('base_salary', base_salary);
      if (commission_rate !== undefined) push('commission_rate', commission_rate);
    }

    if (wh !== undefined) push('working_hours', wh);

    if (fields.length === 0) {
      // Nada que cambiar
      return exports.getUserById(req, res);
    }

    // updated_at
    fields.push(`updated_at = NOW()`);

    const sql = `UPDATE users SET ${fields.join(', ')} WHERE id = $${values.length + 1}
                 RETURNING id, tenant_id, role_id, first_name, last_name, email, phone,
                           payment_type, base_salary, commission_rate, status, last_service_at, last_turn_at, working_hours`;
    const r = await db.query(sql, [...values, id]);
    return res.status(200).json(dbToApiUser(r.rows[0]));
  } catch (error) {
    console.error('Error al actualizar usuario:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* =========================================================
   Eliminar un Usuario
========================================================= */
exports.deleteUser = async (req, res) => {
  const { id } = req.params;
  try {
    const r = await db.query('DELETE FROM users WHERE id = $1', [id]);
    if (r.rowCount === 0) {
      return res.status(404).json({ message: 'Usuario no encontrado para eliminar' });
    }
    return res.status(204).send();
  } catch (error) {
    console.error('Error al eliminar usuario:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* =========================================================
   Endpoints específicos de Working Hours
========================================================= */

// GET /users/:id/working-hours
exports.getUserWorkingHours = async (req, res) => {
  const { id } = req.params;
  try {
    const r = await db.query('SELECT working_hours FROM users WHERE id = $1', [id]);
    if (r.rows.length === 0) return res.status(404).json({ message: 'Usuario no encontrado' });
    return res.status(200).json(r.rows[0].working_hours || null);
  } catch (e) {
    console.error('Error al leer working_hours:', e);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// PUT /users/:id/working-hours
exports.updateUserWorkingHours = async (req, res) => {
  const { id } = req.params;
  const { week } = req.body || {};
  try {
    const wh = week === null ? null : normalizeWorkingHours(week);
    const userRes = await db.query(`SELECT tenant_id, role_id FROM users WHERE id = $1`, [id]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }
    const { tenant_id, role_id } = userRes.rows[0];
    const isStylist = parseInt(role_id, 10) === 3;
    if (isStylist && wh) {
      await validateStylistWorkingHoursAgainstTenant(tenant_id, wh);
    }

    const r = await db.query(
      `UPDATE users
       SET working_hours = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, working_hours`,
      [wh, id]
    );
    if (r.rows.length === 0) return res.status(404).json({ message: 'Usuario no encontrado' });
    return res.status(200).json(r.rows[0]);
  } catch (e) {
    console.error('Error al actualizar working_hours:', e);
    return res.status(400).json({ error: e.message || 'working_hours inválido' });
  }
};

/* =========================================================
   Siguiente estilista disponible (turnero + horario)
   - Si working_hours es NULL => hereda horario del tenant
========================================================= */
exports.getNextAvailableStylist = async (req, res) => {
  const tenant_id = req.user?.tenant_id;
  if (!tenant_id) {
    return res.status(400).json({ error: 'No se pudo identificar el tenant del usuario.' });
  }

  const now = new Date();
  const dayIdx = now.getDay(); // 0=Sunday..6=Saturday
  const DAY_EN = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'][dayIdx];
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const nowMin = parseInt(hh, 10) * 60 + parseInt(mm, 10);

  try {
    // 1) Horario del tenant
    const tRes = await db.query(`SELECT working_hours FROM tenants WHERE id = $1`, [tenant_id]);
    const tenantWH = tRes.rows[0]?.working_hours || null;

    // 2) Traer estilistas activos del tenant con sus horarios (pueden ser NULL -> heredan)
    const uRes = await db.query(
      `SELECT id, first_name, last_name, last_service_at, last_turn_at, working_hours
       FROM users
       WHERE tenant_id = $1 AND role_id = 3 AND status = 'active'
       ORDER BY first_name ASC`,
      [tenant_id]
    );
    const stylists = uRes.rows.map(dbToApiUser);

    // 3) Calcular disponibilidad efectiva (herencia)
    const available = [];
    for (const u of stylists) {
      const effectiveDay = (u.working_hours ?? tenantWH)?.[DAY_EN];

      // Si no hay horario en ningún lado -> no disponible
      if (!effectiveDay) continue;

      // Si no está activo -> no disponible
      const ranges = normalizeDayValueToRanges(effectiveDay); // [{start:'HH:MM', end:'HH:MM'}, ...] (asumido)
      if (!effectiveDay.active || !Array.isArray(ranges) || ranges.length === 0) continue;

      const isNowInside = ranges.some(r => {
        const s = minutesFromHHMM(r.start);
        const e = minutesFromHHMM(r.end);
        return s != null && e != null && nowMin >= s && nowMin < e;
      });

      if (isNowInside) {
        available.push(u);
      }
    }

    if (available.length === 0) {
      return res.status(404).json({ message: 'No hay estilistas disponibles en este momento.' });
    }

    // 4) Orden: menos recientemente atendió/turno -> primero
    available.sort((a, b) => {
      const aKey = a.last_turn_at || a.last_service_at || null;
      const bKey = b.last_turn_at || b.last_service_at || null;
      const aTime = aKey ? new Date(aKey).getTime() : -Infinity;
      const bTime = bKey ? new Date(bKey).getTime() : -Infinity;
      if (aTime !== bTime) return aTime - bTime;
      // tie-breaker por nombre
      return String(a.first_name).localeCompare(String(b.first_name));
    });

    return res.status(200).json({
      id: available[0].id,
      first_name: available[0].first_name,
      last_name: available[0].last_name,
      last_service_at: available[0].last_service_at,
      last_turn_at: available[0].last_turn_at,
    });
  } catch (error) {
    console.error('Error al obtener el siguiente estilista disponible:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* =========================================================
   Buscar usuario por teléfono (mismo tenant)
========================================================= */
exports.getUserByPhone = async (req, res) => {
  const { phoneNumber } = req.params;
  const tenant_id = req.user?.tenant_id;

  if (!phoneNumber) {
    return res.status(400).json({ error: 'Número de teléfono no proporcionado.' });
  }
  if (!tenant_id) {
    return res.status(400).json({ error: 'No se pudo identificar el tenant.' });
  }

  try {
    const r = await db.query(
      `SELECT id, tenant_id, role_id, first_name, last_name, email
       FROM users
       WHERE phone = $1 AND tenant_id = $2`,
      [phoneNumber, tenant_id]
    );
    if (r.rows.length === 0) {
      return res.status(404).json({ message: 'Usuario no encontrado con ese número de teléfono.' });
    }
    return res.status(200).json(dbToApiUser(r.rows[0]));
  } catch (error) {
    console.error('Error al buscar usuario por teléfono:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};
