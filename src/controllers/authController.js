// src/controllers/authController.js

const db = require('../config/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const slugify = require('slugify');

// -----------------------------
// Helpers
// -----------------------------
const createSlug = (text) =>
  slugify(text, { lower: true, strict: true, remove: /[*+~.()'"!:@]/g });

/**
 * Intenta parsear JSON de forma segura.
 * Si ya es objeto, lo devuelve tal cual. Si falla, retorna {}.
 */
function safeParseJSON(maybeJSON) {
  if (!maybeJSON) return {};
  if (typeof maybeJSON === 'object') return maybeJSON;
  try {
    return JSON.parse(maybeJSON);
  } catch {
    return {};
  }
}

/**
 * Retorna true si algún día en working_hours tiene { active: true }.
 * Estructura esperada:
 * {
 *   monday: { open: "09:00", close: "17:00", active: true },
 *   tuesday: { ... }, ...
 * }
 */
function hasActiveWorkingHours(working_hours) {
  const hours = safeParseJSON(working_hours);
  return Object.values(hours).some((day) => {
    if (!day || typeof day !== 'object') return false;
    return day.active === true; // basta con que sea true
  });
}

// -----------------------------
// LOGIN (mejorado)
// -----------------------------
exports.login = async (req, res) => {
  let { email, password } = req.body || {};

  if (!email || !password) {
    return res
      .status(400)
      .json({ error: 'Por favor, ingrese email y contraseña.' });
  }

  // Normalizar email a minúsculas (login case-insensitive)
  email = String(email).trim().toLowerCase();

  try {
    // Si tu columna no es CITEXT, esta consulta sigue siendo case-insensitive
    const userResult = await db.query(
      'SELECT * FROM users WHERE LOWER(email) = $1 LIMIT 1',
      [email]
    );

    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: 'Credenciales inválidas.' });
    }

    const user = userResult.rows[0];

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Credenciales inválidas.' });
    }

    // ---------------- Verificación avanzada de setup ----------------
    let isSetupComplete = false;

    if (user.tenant_id) {
      // 1) Datos del tenant
      const tenantResult = await db.query(
        'SELECT name, address, phone, working_hours FROM tenants WHERE id = $1',
        [user.tenant_id]
      );

      // 2) Conteos dependientes del tenant
      const servicesCountResult = await db.query(
        'SELECT COUNT(id) AS count FROM services WHERE tenant_id = $1',
        [user.tenant_id]
      );

      // role_id = 3 => estilistas (según tu modelo)
      const staffCountResult = await db.query(
        'SELECT COUNT(id) AS count FROM users WHERE tenant_id = $1 AND role_id = 3',
        [user.tenant_id]
      );

      if (tenantResult.rows.length > 0) {
        const tenant = tenantResult.rows[0];
        const servicesCount = parseInt(servicesCountResult.rows[0].count, 10) || 0;
        const staffCount = parseInt(staffCountResult.rows[0].count, 10) || 0;

        const hasBasicInfo = Boolean(
          (tenant.name || '').trim() &&
          (tenant.address || '').trim() &&
          (tenant.phone || '').trim()
        );

        const hasHours = hasActiveWorkingHours(tenant.working_hours);
        const hasServices = servicesCount > 0;
        const hasStaff = staffCount > 0;

        isSetupComplete = hasBasicInfo && hasHours && hasServices && hasStaff;
      }
    }
    // ----------------------------------------------------------------

    const payload = {
      user: {
        id: user.id,
        role_id: user.role_id,
        tenant_id: user.tenant_id,
      },
    };

    jwt.sign(
      payload,
      process.env.JWT_SECRET,
      { expiresIn: '8h' },
      (err, token) => {
        if (err) throw err;

        const userForResponse = {
          id: user.id,
          first_name: user.first_name,
          last_name: user.last_name,
          email: user.email, // como está en DB
          role_id: user.role_id,
          tenant_id: user.tenant_id,
        };

        return res.json({
          token,
          user: userForResponse,
          setup_complete: isSetupComplete,
        });
      }
    );
  } catch (error) {
    console.error('Error en el login:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// -----------------------------
// Registro de Tenant + Admin
// -----------------------------
exports.registerTenantAndAdmin = async (req, res) => {
  const {
    tenantName,
    adminFirstName,
    adminEmail,
    adminPassword,
  } = req.body || {};

  if (!tenantName || !adminFirstName || !adminEmail || !adminPassword) {
    return res.status(400).json({ error: 'Todos los campos son obligatorios.' });
  }

  // Normalizar email de admin (guardar siempre en minúsculas)
  const adminEmailNorm = String(adminEmail).trim().toLowerCase();

  try {
    await db.query('BEGIN');

    const slug = createSlug(tenantName);

    // Crea tenant (si manejas correo del tenant, también en minúsculas)
    const tenantResult = await db.query(
      'INSERT INTO tenants (name, email, slug) VALUES ($1, $2, $3) RETURNING id',
      [tenantName, adminEmailNorm, slug]
    );
    const newTenantId = tenantResult.rows[0].id;

    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(adminPassword, salt);

    // Crea admin (role_id = 1) con email normalizado
    const adminResult = await db.query(
      `INSERT INTO users (tenant_id, role_id, first_name, last_name, email, password_hash)
       VALUES ($1, 1, $2, '(Admin)', $3, $4)
       RETURNING id, email`,
      [newTenantId, adminFirstName, adminEmailNorm, password_hash]
    );

    await db.query('COMMIT');
    return res.status(201).json(adminResult.rows[0]);
  } catch (error) {
    await db.query('ROLLBACK');
    console.error('Error en el registro de tenant y admin:', error);

    // Violación de unique (email o slug)
    if (error.code === '23505') {
      return res
        .status(409)
        .json({ error: 'Ya existe una peluquería o un usuario con ese nombre/email.' });
    }

    return res.status(500).json({ error: 'Error interno del servidor.' });
  }
};
