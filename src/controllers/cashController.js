// =============================================
// File: src/controllers/cashController.js
// =============================================
const db = require('../config/db');

/**
 * Crea un nuevo movimiento de caja (anticipo, gasto, ingreso).
 */
exports.createCashMovement = async (req, res) => {
  // Datos que vienen del frontend
  const {
    type,                     // 'income' | 'expense' | 'payroll_advance'
    description,
    amount,
    related_user_id = null,   // compatibilidad con versión anterior
    category = null,          // 'stylist_advance' | 'vendor_invoice' | ...
    payment_method = null,    // 'cash' | 'nequi' | 'bancolombia' | 'card'
    invoice_ref = null,       // para facturas
    related_entity_type = null, // 'stylist', 'appointment', etc.
    related_entity_id = null    // UUID relacionado
  } = req.body;

  // Datos que vienen del token del usuario que realiza la acción
  const { tenant_id, id: user_id } = req.user;

  // --- Validaciones ---
  if (!type || !description || amount == null) {
    return res.status(400).json({ error: 'Los campos type, description y amount son obligatorios.' });
  }

  let numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount)) {
    return res.status(400).json({ error: 'El monto (amount) debe ser un número.' });
  }

  // Reglas de negocio: ingresos positivos, egresos negativos
  if ((type === 'payroll_advance' || type === 'expense') && numericAmount > 0) {
    numericAmount = -Math.abs(numericAmount);
  }
  if (type === 'income' && numericAmount < 0) {
    numericAmount = Math.abs(numericAmount);
  }

  // Reglas: anticipos deben estar asociados a un estilista
  if ((type === 'payroll_advance' || category === 'stylist_advance') && !related_entity_id && !related_user_id) {
    return res.status(400).json({ error: 'Un anticipo debe estar asociado a un estilista (related_entity_id).' });
  }

  try {
    const query = `
      INSERT INTO cash_movements (
        tenant_id,
        user_id,
        related_user_id,
        type,
        description,
        amount,
        category,
        payment_method,
        invoice_ref,
        related_entity_type,
        related_entity_id
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *
    `;

    const params = [
      tenant_id,
      user_id,
      related_user_id || related_entity_id || null,
      type,
      description,
      numericAmount,
      category,
      payment_method,
      invoice_ref,
      related_entity_type,
      related_entity_id || related_user_id || null
    ];

    const result = await db.query(query, params);
    res.status(201).json(result.rows[0]);

  } catch (error) {
    console.error('Error al crear el movimiento de caja:', error);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
};


/**
 * Obtiene los movimientos de caja de un tenant, con opción de filtrar por fecha.
 * Ejemplo: GET /api/cash-movements?startDate=2025-10-01&endDate=2025-10-31
 */
exports.getCashMovements = async (req, res) => {
  const { tenant_id } = req.user;
  const { startDate, endDate } = req.query;

  try {
    let query = `
      SELECT 
        cm.id, 
        cm.type, 
        cm.category,
        cm.description, 
        cm.amount, 
        cm.payment_method,
        cm.invoice_ref,
        cm.related_entity_type,
        cm.related_entity_id,
        cm.created_at,
        u.first_name as registered_by,
        ru.first_name as related_to
      FROM cash_movements cm
      LEFT JOIN users u ON cm.user_id = u.id
      LEFT JOIN users ru ON cm.related_user_id = ru.id
      WHERE cm.tenant_id = $1
    `;

    const queryParams = [tenant_id];

    if (startDate && endDate) {
      query += ' AND cm.created_at BETWEEN $2 AND $3';
      queryParams.push(startDate, endDate);
    }

    query += ' ORDER BY cm.created_at DESC';

    const result = await db.query(query, queryParams);
    res.status(200).json(result.rows);

  } catch (error) {
    console.error('Error al obtener movimientos de caja:', error);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
};
