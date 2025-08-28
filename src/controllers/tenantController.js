// src/controllers/tenantController.js
const db = require('../config/db');
const slugify = require('slugify');

// Helper: crea slug consistente
const createSlug = (text = '') =>
  slugify(text, { lower: true, strict: true, remove: /[*+~.()'"!:@]/g });

// Helper: normaliza nulls/strings vacíos
const clean = (v) => (v === undefined || v === null ? null : v);

// Helper: convierte fracción (0.19) -> porcentaje (19) para API
const fracToPct = (v) => (v === null || v === undefined ? null : Number(v) * 100);

// Helper: convierte porcentaje (19) -> fracción (0.19) para BD
const pctToFrac = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n / 100 : null;
};

// Mapea fila de BD -> objeto API esperado por el frontend
const dbToApiTenant = (row) => ({
  id: row.id,
  name: row.name,
  address: row.address,
  phone: row.phone,
  email: row.email,
  website: row.website,
  logo_url: row.logo_url,
  // el front espera estos nombres y en PORCENTAJE
  iva_rate: fracToPct(row.tax_rate),
  admin_fee_percent: fracToPct(row.admin_fee_rate),
  slug: row.slug,
  // working_hours puede venir como objeto o string JSON
  working_hours: typeof row.working_hours === 'string'
    ? safeParseJSON(row.working_hours)
    : row.working_hours,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const safeParseJSON = (s) => {
  try { return JSON.parse(s); } catch { return null; }
};

// Construye SET dinámico para UPDATE en función de campos presentes
const buildUpdateSet = (payload) => {
  const fields = [];
  const values = [];
  let i = 1;

  for (const [k, v] of Object.entries(payload)) {
    fields.push(`${k} = $${i++}`);
    values.push(v);
  }
  // updated_at
  fields.push(`updated_at = NOW()`);
  return { clause: fields.join(', '), values };
};

// --- Controlador ---

// Crear un nuevo Tenant
exports.createTenant = async (req, res) => {
  try {
    const {
      name,
      address,
      phone,
      working_hours,
      email,
      website,
      logo_url,
      // desde el front en porcentaje
      iva_rate,
      admin_fee_percent,
    } = req.body;

    if (!name) return res.status(400).json({ error: 'name es requerido' });

    const slug = createSlug(name);

    const result = await db.query(
      `INSERT INTO tenants
        (name, address, phone, working_hours, slug, email, website, logo_url, tax_rate, admin_fee_rate)
       VALUES
        ($1,   $2,      $3,    $4,            $5,   $6,    $7,      $8,       $9,        $10)
       RETURNING *`,
      [
        clean(name),
        clean(address),
        clean(phone),
        // guarda JSON si viene objeto
        working_hours ? JSON.stringify(working_hours) : null,
        slug,
        clean(email),
        clean(website),
        clean(logo_url),
        pctToFrac(iva_rate),
        pctToFrac(admin_fee_percent),
      ]
    );

    return res.status(201).json(dbToApiTenant(result.rows[0]));
  } catch (error) {
    console.error('Error al crear tenant:', error);
    if (error.code === '23505') {
      // índice único (por ejemplo slug unique)
      return res.status(409).json({ error: 'Ya existe una peluquería con un nombre similar.' });
    }
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// Listar todos o por slug
exports.getAllTenants = async (req, res) => {
  const { slug } = req.query;

  try {
    if (slug) {
      const r = await db.query('SELECT * FROM tenants WHERE slug = $1', [slug]);
      if (r.rows.length === 0) return res.status(404).json({ message: 'Peluquería no encontrada con ese slug.' });
      return res.status(200).json(dbToApiTenant(r.rows[0]));
    }

    const result = await db.query('SELECT * FROM tenants ORDER BY created_at DESC');
    return res.status(200).json(result.rows.map(dbToApiTenant));
  } catch (error) {
    console.error('Error al obtener tenants:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// Obtener por ID
exports.getTenantById = async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query('SELECT * FROM tenants WHERE id = $1', [id]);
    if (result.rows.length === 0) return res.status(404).json({ message: 'Tenant no encontrado' });
    return res.status(200).json(dbToApiTenant(result.rows[0]));
  } catch (error) {
    console.error('Error al obtener tenant por ID:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// Actualizar (parcial) un Tenant
exports.updateTenant = async (req, res) => {
  const { id } = req.params;

  try {
    // Traemos el actual para defaults/slug
    const prev = await db.query('SELECT * FROM tenants WHERE id = $1', [id]);
    if (prev.rows.length === 0) return res.status(404).json({ message: 'Tenant no encontrado para actualizar' });

    const {
      name = prev.rows[0].name,
      address = prev.rows[0].address,
      phone = prev.rows[0].phone,
      working_hours = prev.rows[0].working_hours,
      email = prev.rows[0].email,
      website = prev.rows[0].website,
      logo_url = prev.rows[0].logo_url,
      iva_rate,            // porcentaje desde front (opcional)
      admin_fee_percent,   // porcentaje desde front (opcional)
    } = req.body;

    const slug = createSlug(name);

    const updatePayload = {
      name: clean(name),
      address: clean(address),
      phone: clean(phone),
      slug,
      email: clean(email),
      website: clean(website),
      logo_url: clean(logo_url),
      // si vienen definidos, convertimos; si no, dejamos lo existente
      tax_rate: iva_rate !== undefined ? pctToFrac(iva_rate) : prev.rows[0].tax_rate,
      admin_fee_rate:
        admin_fee_percent !== undefined ? pctToFrac(admin_fee_percent) : prev.rows[0].admin_fee_rate,
      // working_hours a JSON si es objeto
      working_hours: working_hours
        ? (typeof working_hours === 'string' ? working_hours : JSON.stringify(working_hours))
        : null,
    };

    const { clause, values } = buildUpdateSet(updatePayload);
    const sql = `UPDATE tenants SET ${clause} WHERE id = $${values.length + 1} RETURNING *`;
    const result = await db.query(sql, [...values, id]);

    return res.status(200).json(dbToApiTenant(result.rows[0]));
  } catch (error) {
    console.error('Error al actualizar tenant:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// Eliminar
exports.deleteTenant = async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query('DELETE FROM tenants WHERE id = $1 RETURNING *', [id]);
    if (result.rowCount === 0) return res.status(404).json({ message: 'Tenant no encontrado para eliminar' });
    return res.status(204).send();
  } catch (error) {
    console.error('Error al eliminar tenant:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};
