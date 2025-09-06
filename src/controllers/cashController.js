// =============================================
// File: src/controllers/cashController.js
// =============================================
const db = require('../config/db');

// ... (Las funciones de MOVIMIENTOS al final no cambian) ...

// =============================================
// ===          FUNCIONES DE SESIONES          ===
// =============================================

exports.openCashSession = async (req, res) => {
  const { initial_amount } = req.body;
  const { tenant_id, id: user_id } = req.user;

  const numericAmount = Number(initial_amount);
  if (initial_amount == null || !Number.isFinite(numericAmount) || numericAmount < 0) {
    return res.status(400).json({ error: 'El monto inicial es obligatorio y debe ser un número positivo.' });
  }

  try {
    // --- LÓGICA MODIFICADA ---
    // Ahora verificamos si ESTE USUARIO ya tiene una caja abierta, en lugar de verificar para todo el tenant.
    const existingOpenSession = await db.query(
      "SELECT id FROM cash_sessions WHERE opened_by_user_id = $1 AND status = 'OPEN'",
      [user_id]
    );

    if (existingOpenSession.rowCount > 0) {
      return res.status(409).json({ error: 'Ya tienes una sesión de caja abierta. Debes cerrarla antes de abrir una nueva.' });
    }

    // El resto de la lógica de inserción es igual.
    const query = `
      INSERT INTO cash_sessions (tenant_id, opened_by_user_id, initial_amount, status, opened_at)
      VALUES ($1, $2, $3, 'OPEN', NOW())
      RETURNING *;
    `;
    const result = await db.query(query, [tenant_id, user_id, numericAmount]);
    res.status(201).json(result.rows[0]);

  } catch (error) {
    console.error('Error al abrir la sesión de caja:', error);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
};

exports.getCurrentSession = async (req, res) => {
    // --- LÓGICA MODIFICADA ---
    // Ahora la sesión "actual" es la del usuario que está haciendo la petición.
    const { tenant_id, id: user_id } = req.user;
  
    try {
      const sessionResult = await db.query(
        "SELECT s.*, u.first_name as opener_name FROM cash_sessions s JOIN users u ON s.opened_by_user_id = u.id WHERE s.opened_by_user_id = $1 AND s.status = 'OPEN'",
        [user_id]
      );
  
      if (sessionResult.rowCount === 0) {
        return res.status(200).json(null);
      }
  
      const session = sessionResult.rows[0];
  
      // El resto de la lógica para calcular el resumen es la misma.
      const incomesSummaryResult = await db.query( `SELECT payment_method, COUNT(*)::int as count, COALESCE(SUM(amount), 0) as total FROM payments WHERE cash_session_id = $1 GROUP BY payment_method`, [session.id] );
      const expensesSummaryResult = await db.query( `SELECT category, COUNT(*)::int as count, COALESCE(SUM(amount), 0) as total FROM cash_movements WHERE cash_session_id = $1 AND type IN ('expense', 'payroll_advance') GROUP BY category`, [session.id] );
      const attendedAppointmentsResult = await db.query( `SELECT COUNT(DISTINCT appointment_id)::int FROM payments WHERE cash_session_id = $1 AND appointment_id IS NOT NULL`, [session.id] );
      const netCashMovementsResult = await db.query( `SELECT COALESCE(SUM(amount), 0) as total FROM cash_movements WHERE cash_session_id = $1 AND payment_method = 'cash'`, [session.id] );
      const netCashFromMovements = Number(netCashMovementsResult.rows[0].total);
      const expected_cash_amount = Number(session.initial_amount) + netCashFromMovements;
  
      res.status(200).json({
        session_details: session,
        expected_cash_amount,
        summary: {
            incomes_by_payment_method: incomesSummaryResult.rows,
            expenses_by_category: expensesSummaryResult.rows,
            attended_appointments_count: attendedAppointmentsResult.rows[0].count || 0
        }
      });
  
    } catch (error) {
      console.error('Error al obtener la sesión de caja actual:', error);
      res.status(500).json({ error: 'Error interno del servidor.' });
    }
};

exports.closeCashSession = async (req, res) => {
    const { final_amount_counted = null } = req.body;
    // --- LÓGICA MODIFICADA ---
    // El usuario que cierra la caja es el que está en el token.
    const { tenant_id, id: user_id } = req.user;

    let numericFinalAmount = null;
    let difference = null;

    if (final_amount_counted != null) {
        numericFinalAmount = Number(final_amount_counted);
        if (!Number.isFinite(numericFinalAmount) || numericFinalAmount < 0) {
            return res.status(400).json({ error: 'Si se proporciona, el monto final debe ser un número positivo.' });
        }
    }

    try {
        // --- LÓGICA MODIFICADA ---
        // Buscamos la sesión abierta que pertenece a ESTE usuario.
        const sessionResult = await db.query(
            "SELECT * FROM cash_sessions WHERE opened_by_user_id = $1 AND status = 'OPEN'",
            [user_id]
        );
    
        if (sessionResult.rowCount === 0) {
            return res.status(404).json({ error: 'No tienes una sesión de caja abierta para cerrar.' });
        }
    
        const session = sessionResult.rows[0];
    
        // El resto de la lógica de cálculo es la misma.
        const netCashMovementsResult = await db.query( `SELECT COALESCE(SUM(amount), 0) as total FROM cash_movements WHERE cash_session_id = $1 AND payment_method = 'cash'`, [session.id] );
        const netCashFromMovements = Number(netCashMovementsResult.rows[0].total);
        const expected_cash_amount = Number(session.initial_amount) + netCashFromMovements;
        if (numericFinalAmount !== null) {
            difference = numericFinalAmount - expected_cash_amount;
        }
    
        const updateQuery = `
            UPDATE cash_sessions
            SET 
                status = 'CLOSED', closed_at = NOW(), closed_by_user_id = $1,
                final_amount_counted = $2, expected_cash_amount = $3, difference = $4
            WHERE id = $5
            RETURNING *;
        `;
        const updatedResult = await db.query(updateQuery, [
            user_id, numericFinalAmount, expected_cash_amount, difference, session.id
        ]);

        res.status(200).json(updatedResult.rows[0]);

    } catch (error) {
        console.error('Error al cerrar la sesión de caja:', error);
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
};

// ... (El resto del archivo, getSessionHistory y las funciones de MOVIMIENTOS, no necesitan cambios) ...
exports.getSessionHistory = async (req, res) => {
    const { tenant_id } = req.user;
    try {
        const query = `
            SELECT 
                s.*, opener.first_name as opened_by_name, closer.first_name as closed_by_name
            FROM cash_sessions s
            LEFT JOIN users opener ON s.opened_by_user_id = opener.id
            LEFT JOIN users closer ON s.closed_by_user_id = closer.id
            WHERE s.tenant_id = $1 AND s.status = 'CLOSED'
            ORDER BY s.closed_at DESC;
        `;
        const result = await db.query(query, [tenant_id]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error al obtener el historial de cajas:', error);
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
};
exports.createCashMovement = async (req, res) => {
  const {
    type, description, amount, related_user_id = null, category = null,
    payment_method = null, invoice_ref = null, related_entity_type = null,
    related_entity_id = null
  } = req.body;
  const { tenant_id, id: user_id } = req.user;
  if (!type || !description || amount == null) { return res.status(400).json({ error: 'Los campos type, description y amount son obligatorios.' }); }
  let numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount)) { return res.status(400).json({ error: 'El monto (amount) debe ser un número.' }); }
  if ((type === 'payroll_advance' || type === 'expense') && numericAmount > 0) { numericAmount = -Math.abs(numericAmount); }
  if (type === 'income' && numericAmount < 0) { numericAmount = Math.abs(numericAmount); }
  try {
    const openSession = await db.query( "SELECT id FROM cash_sessions WHERE tenant_id = $1 AND status = 'OPEN'", [tenant_id] );
    const cash_session_id = openSession.rowCount > 0 ? openSession.rows[0].id : null;
    if (!cash_session_id && (type === 'expense' || type === 'payroll_advance')) {
        return res.status(400).json({ error: 'No se puede registrar un gasto o anticipo porque no hay una sesión de caja abierta.' });
    }
    const query = `
      INSERT INTO cash_movements (
        tenant_id, user_id, related_user_id, type, description, amount, category,
        payment_method, invoice_ref, related_entity_type, related_entity_id, cash_session_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, $12) RETURNING *`;
    const params = [
      tenant_id, user_id, related_user_id || related_entity_id || null,
      type, description, numericAmount, category, payment_method,
      invoice_ref, related_entity_type, related_entity_id || related_user_id || null,
      cash_session_id
    ];
    const result = await db.query(query, params);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error al crear el movimiento de caja:', error);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
};
exports.getCashMovements = async (req, res) => {
  const { tenant_id } = req.user;
  const { startDate, endDate } = req.query;
  try {
    let query = `
      SELECT cm.*, u.first_name as registered_by, ru.first_name as related_to
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