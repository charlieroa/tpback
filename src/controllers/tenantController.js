// src/controllers/tenantController.js
'use strict';

const db = require('../config/db');
const slugify = require('slugify');

// --- Helpers ---
const createSlug = (text = '') =>
  slugify(text, { lower: true, strict: true, remove: /[*+~.()'"!:@]/g });

const clean = (v) => (v === undefined || v === null ? null : v);
const fracToPct = (v) => (v === null || v === undefined ? null : Number(v) * 100);
const pctToFrac = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n / 100 : null;
};
const safeParseJSON = (s) => {
  try { return JSON.parse(s); } catch { return null; }
};

// Mapea la fila de la BD al objeto que espera el frontend
const dbToApiTenant = (row) => ({
  id: row.id,
  name: row.name,
  address: row.address,
  phone: row.phone,
  email: row.email,
  website: row.website,
  logo_url: row.logo_url,
  iva_rate: fracToPct(row.tax_rate),
  admin_fee_percent: fracToPct(row.admin_fee_rate),
  slug: row.slug,
  working_hours: typeof row.working_hours === 'string'
    ? safeParseJSON(row.working_hours)
    : row.working_hours,
  // Módulos
  products_for_staff_enabled: row.products_for_staff_enabled,
  admin_fee_enabled: row.admin_fee_enabled,
  loans_to_staff_enabled: row.loans_to_staff_enabled,
  // Flag para permitir citas en pasado
  allow_past_appointments: !!row.allow_past_appointments,
  // OpenAI API Key (solo mostramos los últimos 4 caracteres por seguridad)
  openai_api_key: row.openai_api_key
    ? '****' + row.openai_api_key.slice(-4)
    : null,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

// Construye la cláusula SET dinámicamente para updates
const buildUpdateSet = (payload) => {
  const fields = [];
  const values = [];
  let i = 1;
  for (const [k, v] of Object.entries(payload)) {
    fields.push(`${k} = $${i++}`);
    values.push(v);
  }
  fields.push(`updated_at = NOW()`);
  return { clause: fields.join(', '), values };
};

// --- Controlador ---

// Crear Tenant
exports.createTenant = async (req, res) => {
  try {
    const {
      name, address, phone, working_hours, email, website, logo_url,
      iva_rate, admin_fee_percent,
      products_for_staff_enabled = true,
      admin_fee_enabled = false,
      loans_to_staff_enabled = false,
      allow_past_appointments = false, // ⬅️ nuevo en create
    } = req.body;

    if (!name) return res.status(400).json({ error: 'El nombre es requerido' });

    const slug = createSlug(name);

    const result = await db.query(
      `INSERT INTO tenants (
          name, address, phone, working_hours, slug, email, website, logo_url,
          tax_rate, admin_fee_rate,
          products_for_staff_enabled, admin_fee_enabled, loans_to_staff_enabled,
          allow_past_appointments
       ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9, $10,
          $11, $12, $13,
          $14
       ) RETURNING *`,
      [
        clean(name), clean(address), clean(phone),
        working_hours ? JSON.stringify(working_hours) : null,
        slug, clean(email), clean(website), clean(logo_url),
        pctToFrac(iva_rate), pctToFrac(admin_fee_percent),
        !!products_for_staff_enabled, !!admin_fee_enabled, !!loans_to_staff_enabled,
        !!allow_past_appointments,
      ]
    );

    return res.status(201).json(dbToApiTenant(result.rows[0]));
  } catch (error) {
    console.error('Error al crear tenant:', error);
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Ya existe una peluquería con un nombre similar.' });
    }
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// Listar Tenants
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

// Obtener Tenant por ID
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

// Actualizar (parcial) Tenant
exports.updateTenant = async (req, res) => {
  const { id } = req.params;
  const body = req.body;

  try {
    const exists = await db.query('SELECT id FROM tenants WHERE id = $1', [id]);
    if (exists.rowCount === 0) {
      return res.status(404).json({ message: 'Tenant no encontrado para actualizar' });
    }

    const payload = {};

    if (body.name !== undefined) {
      payload.name = clean(body.name);
      payload.slug = createSlug(body.name);
    }
    if (body.address !== undefined) payload.address = clean(body.address);
    if (body.phone !== undefined) payload.phone = clean(body.phone);
    if (body.email !== undefined) payload.email = clean(body.email);
    if (body.website !== undefined) payload.website = clean(body.website);
    if (body.logo_url !== undefined) payload.logo_url = clean(body.logo_url);
    if (body.working_hours !== undefined) {
      payload.working_hours = body.working_hours ? JSON.stringify(body.working_hours) : null;
    }
    if (body.iva_rate !== undefined) payload.tax_rate = pctToFrac(body.iva_rate);

    // Si deshabilitan admin_fee, anulamos la tasa
    if (body.admin_fee_enabled === false) {
      payload.admin_fee_rate = null;
    } else if (body.admin_fee_percent !== undefined) {
      payload.admin_fee_rate = pctToFrac(body.admin_fee_percent);
    }

    if (body.products_for_staff_enabled !== undefined)
      payload.products_for_staff_enabled = !!body.products_for_staff_enabled;
    if (body.admin_fee_enabled !== undefined)
      payload.admin_fee_enabled = !!body.admin_fee_enabled;
    if (body.loans_to_staff_enabled !== undefined)
      payload.loans_to_staff_enabled = !!body.loans_to_staff_enabled;

    // Flag de citas en pasado
    if (body.allow_past_appointments !== undefined)
      payload.allow_past_appointments = !!body.allow_past_appointments;

    // OpenAI API Key (solo guardar si viene un valor válido)
    if (body.openai_api_key !== undefined && body.openai_api_key !== null) {
      // Solo actualizar si no es el placeholder
      if (!body.openai_api_key.startsWith('****')) {
        payload.openai_api_key = body.openai_api_key.trim() || null;
      }
    }

    if (Object.keys(payload).length === 0) {
      const current = await db.query('SELECT * FROM tenants WHERE id = $1', [id]);
      return res.status(200).json(dbToApiTenant(current.rows[0]));
    }

    const { clause, values } = buildUpdateSet(payload);
    const sql = `UPDATE tenants SET ${clause} WHERE id = $${values.length + 1} RETURNING *`;
    const result = await db.query(sql, [...values, id]);

    return res.status(200).json(dbToApiTenant(result.rows[0]));
  } catch (error) {
    console.error('Error al actualizar tenant:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// Subida de logo
exports.uploadTenantLogo = async (req, res) => {
  const { tenantId } = req.params;
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No se ha subido ningún archivo.' });
    }
    const uploadedFileUrl = `/uploads/logos/${req.file.filename}`;
    const tenantExists = await db.query('SELECT id FROM tenants WHERE id = $1', [tenantId]);
    if (tenantExists.rowCount === 0) {
      return res.status(404).json({ message: 'Tenant no encontrado.' });
    }
    await db.query('UPDATE tenants SET logo_url = $1, updated_at = NOW() WHERE id = $2', [uploadedFileUrl, tenantId]);
    return res.status(200).json({ url: uploadedFileUrl });
  } catch (error) {
    console.error('Error al subir el logo:', error);
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }
};

// Eliminar Tenant
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