// =============================================
// File: src/controllers/paymentController.js
// =============================================
const db = require('../config/db');

/**
 * Crea un pago, lo asocia a una sesión de caja, y marca la cita como 'completed'.
 */
exports.createPayment = async (req, res) => {
  const { appointment_id, amount, payment_method } = req.body;

  if (!req.user || !req.user.id || !req.user.tenant_id) {
    return res.status(403).json({ error: 'Fallo de autenticación: req.user no está correctamente definido.' });
  }
  const { tenant_id, id: cashier_id } = req.user;

  if (!appointment_id || !amount) {
    return res.status(400).json({ error: 'Los campos appointment_id y amount son obligatorios.' });
  }

  try {
    await db.query('BEGIN');

    // --- NUEVO: OBTENER LA SESIÓN DE CAJA ACTIVA ---
    // Buscamos si hay una sesión de caja abierta para este tenant.
    const openSession = await db.query(
      "SELECT id FROM cash_sessions WHERE tenant_id = $1 AND status = 'OPEN'",
      [tenant_id]
    );
    // Si encontramos una sesión, guardamos su ID. Si no, será null.
    const cash_session_id = openSession.rowCount > 0 ? openSession.rows[0].id : null;


    // A) Obtener y bloquear la cita (sin cambios)
    const apptRes = await db.query(
      'SELECT status, tenant_id FROM appointments WHERE id = $1 FOR UPDATE',
      [appointment_id]
    );

    if (apptRes.rows.length === 0) throw new Error('Cita no encontrada.');

    const appt = apptRes.rows[0];
    if (String(appt.tenant_id) !== String(tenant_id)) {
      throw new Error('La cita no pertenece a esta peluquería.');
    }
    if (appt.status !== 'checked_out') {
      throw new Error('El servicio debe estar en estado Checkout para poder ser pagado.');
    }

    // B) Insertar el registro del pago (MODIFICADO para incluir cash_session_id)
    const payRes = await db.query(
      `INSERT INTO payments (tenant_id, appointment_id, amount, payment_method, cashier_id, cash_session_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`, // <-- MODIFICADO
      [tenant_id, appointment_id, Number(amount), payment_method || 'cash', cashier_id, cash_session_id] // <-- MODIFICADO
    );

    // C) Actualizar la cita a 'completed' (sin cambios)
    await db.query(
      `UPDATE appointments 
       SET status = 'completed', updated_at = NOW() 
       WHERE id = $1`,
      [appointment_id]
    );

    // D) Registrar movimiento de caja si es efectivo (MODIFICADO para incluir cash_session_id)
    const pm = (payment_method || 'cash').toLowerCase();
    if (pm === 'cash') {
      await db.query(
        `INSERT INTO cash_movements
          (tenant_id, user_id, type, description, amount, category, payment_method, related_entity_type, related_entity_id, cash_session_id)
         VALUES ($1, $2, 'income', $3, $4, 'service_payment', 'cash', 'appointment', $5, $6)`, // <-- MODIFICADO
        [
          tenant_id,
          cashier_id,
          `Pago cita #${appointment_id}`,
          Math.abs(Number(amount)),
          appointment_id,
          cash_session_id // <-- MODIFICADO
        ]
      );
    }

    await db.query('COMMIT');
    res.status(201).json(payRes.rows[0]);

  } catch (error) {
    await db.query('ROLLBACK');
    console.error('Error al crear el pago:', error.message);
    res.status(400).json({ error: error.message });
  }
};

/**
 * Obtiene todos los pagos de un tenant. (Sin cambios)
 */
exports.getPaymentsByTenant = async (req, res) => {
  const { tenantId } = req.params;
  try {
    const query = `
      SELECT p.id, p.amount, p.payment_method, p.payment_date,
             a.start_time as appointment_date,
             c.first_name as cashier_name
      FROM payments p
      JOIN users c ON p.cashier_id = c.id
      JOIN appointments a ON p.appointment_id = a.id
      WHERE p.tenant_id = $1
      ORDER BY p.payment_date DESC;
    `;
    const result = await db.query(query, [tenantId]);
    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Error al obtener pagos:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};