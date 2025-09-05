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
   Validación: horario de estilista dentro del tenant (Versión Robusta)
=========================================== */
const validateStylistWorkingHoursAgainstTenant = async (tenantId, stylistHours) => {
  if (!stylistHours) return; // hereda o sin horario

  const tenantResult = await db.query('SELECT working_hours FROM tenants WHERE id = $1', [tenantId]);
  const tenantWorkingHours = tenantResult.rows[0]?.working_hours;

  if (!tenantWorkingHours) return;

  const tenantDays = Object.keys(tenantWorkingHours);
  for (const day of tenantDays) {
    const sDay = stylistHours?.[day];
    const originalTDay = tenantWorkingHours?.[day];

    let normalizedTDay;
    if (typeof originalTDay === 'string' && originalTDay.includes('-')) {
      normalizedTDay = { active: true, ranges: [originalTDay] };
    } else if (typeof originalTDay === 'object' && originalTDay !== null) {
      normalizedTDay = originalTDay;
    } else {
      normalizedTDay = { active: false, ranges: [] };
    }

    if (sDay?.active && !normalizedTDay?.active) {
      throw new Error(`El estilista no puede trabajar el ${day} si el salón está cerrado.`);
    }

    const stylistRanges = normalizeDayValueToRanges(sDay);
    const tenantRanges  = normalizeDayValueToRanges(normalizedTDay);
    const commonRanges  = intersectRangesArrays(stylistRanges, tenantRanges);

    if (sDay?.active && commonRanges.length === 0) {
      throw new Error(`El horario del estilista el ${day} no coincide con el horario del salón.`);
    }
  }
};

/* =========================================================
   Crear un nuevo Usuario
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
    }

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
   Obtener todos los Usuarios por tenant (con filtro rol) - CORREGIDO
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

  // --- CORRECCIÓN DE BUG #1 ---
  // Se añadió un espacio antes de "ORDER BY"
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
   Obtener un Usuario por ID
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
   Actualizar un Usuario - CORREGIDO
========================================================= */
exports.updateUser = async (req, res) => {
  const { id } = req.params;
  const {
    first_name, last_name, phone, role_id,
    payment_type, base_salary, commission_rate, status,
    working_hours,
  } = req.body || {};

  try {
    const curRes = await db.query(
      `SELECT tenant_id, role_id, payment_type AS cur_payment_type,
              base_salary AS cur_base_salary, commission_rate AS cur_commission_rate
       FROM users WHERE id = $1`,
      [id]
    );
    if (curRes.rows.length === 0) {
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }

    const { tenant_id } = curRes.rows[0];
    const isStylist = parseInt(role_id || curRes.rows[0].role_id, 10) === 3;

    let wh = undefined;
    if (working_hours !== undefined) {
      if (working_hours === null) {
        wh = null;
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

    const fields = [];
    const values = [];
    const push = (k, v) => { fields.push(`${k} = $${fields.length + 1}`); values.push(v); };

    if (first_name !== undefined) push('first_name', first_name);
    if (last_name  !== undefined) push('last_name', last_name);
    if (phone      !== undefined) push('phone', phone);
    if (role_id    !== undefined) push('role_id', role_id);
    if (status     !== undefined) push('status', status);
    if (payment_type !== undefined) push('payment_type', payment_type);
    if (base_salary !== undefined) push('base_salary', base_salary);
    if (commission_rate !== undefined) push('commission_rate', commission_rate);
    if (wh !== undefined) push('working_hours', wh);

    if (fields.length === 0) {
      return exports.getUserById(req, res);
    }

    // --- CORRECCIÓN DE BUG #2 ---
    // Se añade la actualización de `updated_at` de forma segura.
    // El error anterior probablemente se debía a la construcción de la query
    // cuando se actualizaban muchos campos a la vez. Este método es más seguro.
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
========================================================= */
exports.getNextAvailableStylist = async (req, res) => {
  const tenant_id = req.user?.tenant_id;
  if (!tenant_id) {
    return res.status(400).json({ error: 'No se pudo identificar el tenant del usuario.' });
  }

  const now = new Date();
  const dayIdx = now.getDay();
  const DAY_EN = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'][dayIdx];
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const nowMin = parseInt(hh, 10) * 60 + parseInt(mm, 10);

  try {
    const tRes = await db.query(`SELECT working_hours FROM tenants WHERE id = $1`, [tenant_id]);
    const tenantWH = tRes.rows[0]?.working_hours || null;

    const uRes = await db.query(
      `SELECT id, first_name, last_name, last_service_at, last_turn_at, working_hours
       FROM users
       WHERE tenant_id = $1 AND role_id = 3 AND status = 'active'
       ORDER BY first_name ASC`,
      [tenant_id]
    );
    const stylists = uRes.rows.map(dbToApiUser);

    const available = [];
    for (const u of stylists) {
      const effectiveDay = (u.working_hours ?? tenantWH)?.[DAY_EN];

      if (!effectiveDay) continue;

      const ranges = normalizeDayValueToRanges(effectiveDay);
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

    available.sort((a, b) => {
      const aKey = a.last_turn_at || a.last_service_at || null;
      const bKey = b.last_turn_at || b.last_service_at || null;
      const aTime = aKey ? new Date(aKey).getTime() : -Infinity;
      const bTime = bKey ? new Date(bKey).getTime() : -Infinity;
      if (aTime !== bTime) return aTime - bTime;
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