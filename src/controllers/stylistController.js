// src/controllers/stylistController.js
const db = require('../config/db');

/* ============================================================
   Utilidades compartidas
============================================================ */

const BLOCKING_STATUSES = [
  'scheduled',
  'rescheduled',
  'checked_in',
  'checked_out',
  'pending_approval',
];

// Obtiene la duración del servicio (minutos) por tenant; si no existe, usa fallback
async function getServiceDurationMinutes(service_id, tenant_id, fallback = 60) {
  if (!service_id) return fallback;
  const res = await db.query(
    `SELECT duration_minutes
       FROM services
      WHERE id = $1 AND tenant_id = $2`,
    [service_id, tenant_id]
  );
  if (res.rows.length === 0) return fallback;
  const n = Number(res.rows[0].duration_minutes);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Construye Date local (sin 'Z') a partir de YYYY-MM-DD + HH:mm (o HH:mm:ss)
function makeLocalDate(dateStr, timeStr) {
  const t = (timeStr || '').length === 5 ? `${timeStr}:00` : (timeStr || '00:00:00');
  return new Date(`${dateStr}T${t}`);
}

/* ============================================================
   1) Siguiente estilista disponible global (sin filtrar por servicio)
   GET /api/stylists/next-available
============================================================ */
exports.getNextAvailable = async (req, res) => {
  const { tenant_id } = req.user;
  try {
    const result = await db.query(
      `
      SELECT id, first_name, last_name, last_service_at, last_turn_at
        FROM users
       WHERE tenant_id = $1
         AND role_id = 3
         AND status = 'active'
       ORDER BY COALESCE(last_turn_at, last_service_at) ASC NULLS FIRST
       LIMIT 1
      `,
      [tenant_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'No hay estilistas disponibles.' });
    }
    return res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error('Error al obtener el siguiente estilista:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* ============================================================
   2) Sugerir estilista por turno (calificado + disponible)
   GET /api/stylists/suggest-by-turn?date=YYYY-MM-DD&start_time=HH:mm[:ss]&service_id=<id>
   - Ordena por COALESCE(last_turn_at, last_service_at)
   - Actualiza last_turn_at = NOW() al sugerir
============================================================ */
exports.suggestStylistByTurn = async (req, res) => {
  const { tenant_id } = req.user;
  const { date, start_time, service_id } = req.query;

  if (!date || !start_time || !service_id) {
    return res.status(400).json({ message: 'Se requiere fecha, hora de inicio y service_id.' });
  }

  try {
    const duration = await getServiceDurationMinutes(service_id, tenant_id, 60);
    const startLocal = makeLocalDate(date, start_time);
    const endLocal = new Date(startLocal.getTime() + duration * 60000);

    const suggested = await db.query(
      `
      SELECT u.id, u.first_name, u.last_name
        FROM users u
       WHERE u.tenant_id = $1
         AND u.role_id = 3
         AND u.status = 'active'
         AND EXISTS (
               SELECT 1
                 FROM stylist_services ss
                WHERE ss.user_id = u.id
                  AND ss.service_id = $2
         )
         AND NOT EXISTS (
               SELECT 1
                 FROM appointments a
                WHERE a.tenant_id  = $1
                  AND a.stylist_id = u.id
                  AND a.status = ANY($5)
                  AND (a.start_time, a.end_time) OVERLAPS ($3, $4)
         )
       ORDER BY COALESCE(u.last_turn_at, u.last_service_at) ASC NULLS FIRST
       LIMIT 1
      `,
      [tenant_id, service_id, startLocal, endLocal, BLOCKING_STATUSES]
    );

    if (suggested.rows.length === 0) {
      return res.status(404).json({ message: 'No se encontraron estilistas disponibles en ese horario.' });
    }

    const stylist = suggested.rows[0];
    await db.query(`UPDATE users SET last_turn_at = NOW() WHERE id = $1`, [stylist.id]);

    return res.status(200).json(stylist);
  } catch (error) {
    console.error('Error al sugerir estilista por turno:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* ============================================================
   3) Obtener servicios asignados a un estilista
   GET /api/stylists/:id/services
============================================================ */
exports.getStylistServices = async (req, res) => {
  const { tenant_id } = req.user;
  const { id: stylistId } = req.params;

  try {
    const u = await db.query(
      `SELECT id FROM users WHERE id = $1 AND tenant_id = $2 AND role_id = 3`,
      [stylistId, tenant_id]
    );
    if (u.rows.length === 0) {
      return res.status(404).json({ message: 'Estilista no encontrado.' });
    }

    const result = await db.query(
      `
      SELECT s.id, s.name, s.price, s.duration_minutes, s.category_id, c.name AS category_name
        FROM stylist_services ss
        JOIN services s ON s.id = ss.service_id
   LEFT JOIN service_categories c ON c.id = s.category_id
       WHERE ss.user_id = $1
         AND s.tenant_id = $2
       ORDER BY c.name NULLS LAST, s.name ASC
      `,
      [stylistId, tenant_id]
    );

    return res.status(200).json(result.rows);
  } catch (error) {
    console.error('Error al obtener servicios del estilista:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* ============================================================
   4) Asignar (reemplazar) servicios a un estilista
   POST /api/stylists/:id/services
   Body: { "service_ids": ["uuid1","uuid2", ...] }
   - Reemplaza todas las asignaciones actuales por las recibidas
   - Usa transacción manual (db.getClient) para ser consistente con tu proyecto
============================================================ */
exports.setStylistServices = async (req, res) => {
  const { tenant_id } = req.user;
  const { id: stylistId } = req.params;
  const { service_ids } = req.body;

  if (!Array.isArray(service_ids)) {
    return res.status(400).json({ message: 'service_ids debe ser un arreglo.' });
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const u = await client.query(
      `SELECT id FROM users WHERE id = $1 AND tenant_id = $2 AND role_id = 3`,
      [stylistId, tenant_id]
    );
    if (u.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Estilista no encontrado.' });
    }

    if (service_ids.length > 0) {
      const valid = await client.query(
        `SELECT id
           FROM services
          WHERE tenant_id = $1
            AND id = ANY($2::uuid[])`,
        [tenant_id, service_ids]
      );
      if (valid.rows.length !== service_ids.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Uno o más servicios no pertenecen a tu tenant.' });
      }
    }

    await client.query(`DELETE FROM stylist_services WHERE user_id = $1`, [stylistId]);

    if (service_ids.length > 0) {
      // Inserción bulk segura
      const values = service_ids.map((_, i) => `($1, $${i + 2})`).join(', ');
      await client.query(
        `INSERT INTO stylist_services (user_id, service_id) VALUES ${values}`,
        [stylistId, ...service_ids]
      );
    }

    await client.query('COMMIT');
    return res.status(200).json({ message: 'Servicios del estilista actualizados con éxito.' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al asignar servicios al estilista:', error);
    return res.status(500).json({ error: error.message || 'Error interno del servidor' });
  } finally {
    client.release();
  }
};

/* ============================================================
   5) Crear estilista (role_id = 3)
   POST /api/users
============================================================ */
exports.createStylist = async (req, res) => {
  const { tenant_id } = req.user;
  const {
    first_name,
    last_name,
    email,
    password,
    phone = null,
    payment_type = 'salary', // 'salary' | 'commission' | 'mixed'
    base_salary = 0,
    commission_rate = 0,
  } = req.body;

  if (!first_name || !last_name || !email || !password) {
    return res.status(400).json({ message: 'first_name, last_name, email y password son requeridos.' });
  }

  try {
    // Nota: si tu proyecto ya hashea en authController, aquí no lo repetimos.
    const result = await db.query(
      `
      INSERT INTO users (tenant_id, role_id, first_name, last_name, email, password, phone,
                         payment_type, base_salary, commission_rate, status)
      VALUES ($1, 3, $2, $3, $4, $5, $6, $7, $8, $9, 'active')
      RETURNING id, tenant_id, role_id, first_name, last_name, email, phone, payment_type, base_salary, commission_rate, status, created_at, updated_at
      `,
      [tenant_id, first_name, last_name, email, password, phone, payment_type, base_salary, commission_rate]
    );

    return res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error al crear estilista:', error);
    if (String(error.message).includes('duplicate key')) {
      return res.status(409).json({ error: 'El email ya está registrado.' });
    }
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* ============================================================
   6) Listar estilistas del tenant
   GET /api/users/tenant/:tenantId?role_id=3
============================================================ */
exports.listStylistsByTenant = async (req, res) => {
  const { tenant_id } = req.user;
  const { tenantId } = req.params;
  const roleId = Number(req.query.role_id || 3);

  if (tenantId !== tenant_id) {
    return res.status(403).json({ message: 'No autorizado para consultar este tenant.' });
  }

  try {
    const result = await db.query(
      `
      SELECT id, first_name, last_name, email, phone, payment_type, base_salary, commission_rate, status, created_at, updated_at
        FROM users
       WHERE tenant_id = $1
         AND role_id = $2
       ORDER BY first_name, last_name
      `,
      [tenant_id, roleId]
    );
    return res.status(200).json(result.rows);
  } catch (error) {
    console.error('Error al listar estilistas:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* ============================================================
   7) Actualizar estilista
   PUT /api/users/:id
============================================================ */
exports.updateStylist = async (req, res) => {
  const { tenant_id } = req.user;
  const { id } = req.params;

  const allowed = [
    'first_name',
    'last_name',
    'email',
    'phone',
    'payment_type',
    'base_salary',
    'commission_rate',
    'status',
  ];

  const fields = [];
  const values = [];
  let idx = 1;

  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(req.body, key)) {
      fields.push(`${key} = $${idx++}`);
      values.push(req.body[key]);
    }
  }

  if (fields.length === 0) {
    return res.status(400).json({ message: 'No hay campos válidos para actualizar.' });
  }

  try {
    const u = await db.query(
      `SELECT id FROM users WHERE id = $1 AND tenant_id = $2 AND role_id = 3`,
      [id, tenant_id]
    );
    if (u.rows.length === 0) {
      return res.status(404).json({ message: 'Estilista no encontrado.' });
    }

    const result = await db.query(
      `
      UPDATE users
         SET ${fields.join(', ')}, updated_at = NOW()
       WHERE id = $${idx} AND tenant_id = $${idx + 1} AND role_id = 3
   RETURNING id, tenant_id, role_id, first_name, last_name, email, phone, payment_type, base_salary, commission_rate, status, created_at, updated_at
      `,
      [...values, id, tenant_id]
    );

    return res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error('Error al actualizar estilista:', error);
    if (String(error.message).includes('duplicate key')) {
      return res.status(409).json({ error: 'El email ya está registrado.' });
    }
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* ============================================================
   8) Eliminar estilista
   DELETE /api/users/:id
============================================================ */
exports.deleteStylist = async (req, res) => {
  const { tenant_id } = req.user;
  const { id } = req.params;

  try {
    const u = await db.query(
      `SELECT id FROM users WHERE id = $1 AND tenant_id = $2 AND role_id = 3`,
      [id, tenant_id]
    );
    if (u.rows.length === 0) {
      return res.status(404).json({ message: 'Estilista no encontrado.' });
    }

    await db.query(`DELETE FROM users WHERE id = $1 AND tenant_id = $2 AND role_id = 3`, [id, tenant_id]);
    return res.status(204).send();
  } catch (error) {
    console.error('Error al eliminar estilista:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* ============================================================
   Export util (opcional)
============================================================ */
exports.BLOCKING_STATUSES = BLOCKING_STATUSES;
