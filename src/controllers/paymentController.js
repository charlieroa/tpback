// Contenido COMPLETO y DEFINITIVO para: src/controllers/paymentController.js

const db = require('../config/db');

/**
 * Crea un pago y marca la cita como 'completed'
 */
exports.createPayment = async (req, res) => {
  // 1. Extraer datos del Body y del Token
  const { appointment_id, amount, payment_method } = req.body;
  
  if (!req.user || !req.user.id || !req.user.tenant_id) {
    return res.status(403).json({ error: 'Fallo de autenticación: req.user no está correctamente definido.' });
  }
  const { tenant_id, id: cashier_id } = req.user;

  // 2. Validaciones de entrada
  if (!appointment_id || !amount) {
    return res.status(400).json({ error: 'Los campos appointment_id y amount son obligatorios.' });
  }

  // 3. Iniciar la transacción de la base de datos
  try {
    await db.query('BEGIN');

    // Paso A: Obtener y bloquear la cita para evitar problemas de concurrencia
    const apptRes = await db.query(
        'SELECT status, tenant_id FROM appointments WHERE id = $1 FOR UPDATE', 
        [appointment_id]
    );

    if (apptRes.rows.length === 0) {
        throw new Error('Cita no encontrada.');
    }
    
    // Paso B: Validar la lógica de negocio
    const appt = apptRes.rows[0];
    if (String(appt.tenant_id) !== String(tenant_id)) {
        throw new Error('La cita no pertenece a esta peluquería.');
    }
    if (appt.status !== 'checked_out') {
        throw new Error('El servicio debe estar en estado Checkout para poder ser pagado.');
    }

    // Paso C: Insertar el registro del pago y guardarlo en la variable 'payRes'
    const payRes = await db.query(
      `INSERT INTO payments (tenant_id, appointment_id, amount, payment_method, cashier_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [tenant_id, appointment_id, Number(amount), payment_method || 'cash', cashier_id]
    );

    // Paso D: Actualizar el estado de la cita a 'completed'
    await db.query(
        'UPDATE appointments SET status = \'completed\', updated_at = NOW() WHERE id = $1',
        [appointment_id]
    );

    // Paso E: Si todo fue bien, confirmar los cambios
    await db.query('COMMIT');
    
    // Paso F: Devolver la respuesta de éxito con los datos del pago creado
    res.status(201).json(payRes.rows[0]);

  } catch (error) {
    // Si algo falla, deshacer todos los cambios
    await db.query('ROLLBACK');
    console.error('Error al crear el pago:', error.message);
    res.status(400).json({ error: error.message });
  }
};

/**
 * Obtiene todos los pagos de un tenant.
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