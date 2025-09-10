// =========================================================
// File: src/controllers/serviceController.js (Final con % comisión)
// =========================================================
const db = require('../config/db');

// --- Helper: valida/normaliza porcentaje (0–100) o null ---
function parsePercentOrNull(input, fieldName = 'commission_percent') {
  if (input === undefined || input === null || input === '') return null;
  const n = Number(input);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    const err = new Error(`${fieldName} debe estar entre 0 y 100.`);
    err.status = 400;
    throw err;
  }
  return Math.round(n * 100) / 100;
}

// Crear un nuevo Servicio
exports.createService = async (req, res) => {
  const { tenant_id } = req.user; // SIEMPRE del token
  const { name, description, price, duration_minutes, category_id, commission_percent } = req.body;

  if (!name || price == null || duration_minutes == null) {
    return res.status(400).json({ error: 'Campos obligatorios: name, price, duration_minutes.' });
  }

  let pct = null;
  try {
    pct = parsePercentOrNull(commission_percent);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }

  try {
    const result = await db.query(
      `INSERT INTO services (tenant_id, name, description, price, duration_minutes, category_id, commission_percent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [tenant_id, name, description ?? null, price, duration_minutes, category_id ?? null, pct]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error al crear el servicio:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// Obtener todos los servicios del tenant (con filtro por categoría)
exports.getServicesByTenant = async (req, res) => {
  const { tenant_id } = req.user; // Seguridad: del token
  const { category_id } = req.query;

  let baseQuery = `
    SELECT s.*
    FROM services s
    WHERE s.tenant_id = $1
  `;
  const params = [tenant_id];

  if (category_id) {
    baseQuery += ` AND s.category_id = $2`;
    params.push(category_id);
  }

  baseQuery += ' ORDER BY s.name';

  try {
    const result = await db.query(baseQuery, params);
    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Error al obtener servicios:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// Obtener un servicio por su ID (valida pertenencia al tenant)
exports.getServiceById = async (req, res) => {
  const { id } = req.params;
  const { tenant_id } = req.user;

  try {
    const result = await db.query(
      `SELECT *
       FROM services
       WHERE id = $1 AND tenant_id = $2`,
      [id, tenant_id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Servicio no encontrado' });
    }
    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error('Error al obtener servicio por ID:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// Actualizar un Servicio
exports.updateService = async (req, res) => {
  const { id } = req.params;
  const { tenant_id } = req.user;
  const { name, description, price, duration_minutes, category_id, commission_percent } = req.body;

  // Validar % si viene
  let pct = undefined;
  try {
    if (commission_percent !== undefined) {
      pct = parsePercentOrNull(commission_percent);
    }
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }

  try {
    // Leer actual para merge
    const curRes = await db.query('SELECT * FROM services WHERE id = $1 AND tenant_id = $2', [id, tenant_id]);
    if (curRes.rowCount === 0) return res.status(404).json({ message: 'Servicio no encontrado para actualizar.' });
    const cur = curRes.rows[0];

    const updated = {
      name: name ?? cur.name,
      description: description ?? cur.description,
      price: price ?? cur.price,
      duration_minutes: duration_minutes ?? cur.duration_minutes,
      category_id: category_id ?? cur.category_id,
      commission_percent: pct === undefined ? cur.commission_percent : pct,
    };

    const result = await db.query(
      `UPDATE services SET
         name = $1,
         description = $2,
         price = $3,
         duration_minutes = $4,
         category_id = $5,
         commission_percent = $6,
         updated_at = NOW()
       WHERE id = $7 AND tenant_id = $8
       RETURNING *`,
      [
        updated.name,
        updated.description,
        updated.price,
        updated.duration_minutes,
        updated.category_id,
        updated.commission_percent,
        id,
        tenant_id,
      ]
    );

    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error('Error al actualizar servicio:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// Eliminar un Servicio
exports.deleteService = async (req, res) => {
  const { id } = req.params;
  const { tenant_id } = req.user;
  try {
    const result = await db.query('DELETE FROM services WHERE id = $1 AND tenant_id = $2', [id, tenant_id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'Servicio no encontrado para eliminar' });
    }
    res.status(204).send();
  } catch (error) {
    if (error.code === '23503') {
      // FK en uso (appointments, invoice_items, etc.)
      return res.status(409).json({ error: 'No se puede eliminar: el servicio está en uso.' });
    }
    console.error('Error al eliminar servicio:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// --- NUEVA FUNCIÓN ---
// Lista estilistas cualificados para un servicio (acotado al tenant del token)
exports.getStylistsForService = async (req, res) => {
  const { id } = req.params; // service_id
  const { tenant_id } = req.user;

  try {
    const query = `
      SELECT u.id, u.first_name, u.last_name, u.status
      FROM users u
      JOIN stylist_services ss ON u.id = ss.user_id
      WHERE ss.service_id = $1
        AND u.tenant_id = $2
        AND u.role_id = 3
      ORDER BY u.first_name, u.last_name
    `;
    const result = await db.query(query, [id, tenant_id]);
    res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error al obtener estilistas por servicio:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
};
