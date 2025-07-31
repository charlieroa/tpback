// src/controllers/paymentController.js
const db = require('../config/db');

// Crear un nuevo Pago y actualizar la cita (con validación de estado)
exports.createPayment = async (req, res) => {
    const { tenant_id, appointment_id, amount, payment_method, cashier_id } = req.body;

    if (!tenant_id || !appointment_id || !amount || !cashier_id) {
        return res.status(400).json({ error: 'Faltan campos obligatorios.' });
    }

    try {
        // Iniciamos la transacción para asegurar la integridad de los datos
        await db.query('BEGIN');

        // 1. VALIDACIÓN CLAVE: Buscamos la cita y comprobamos su estado
        const appointmentResult = await db.query(
            "SELECT status FROM appointments WHERE id = $1 FOR UPDATE", 
            [appointment_id]
        );

        if (appointmentResult.rows.length === 0) {
            // Si no se encuentra la cita, lanzamos un error
            throw new Error('Cita no encontrada.');
        }

        const currentStatus = appointmentResult.rows[0].status;
        if (currentStatus !== 'checked_out') {
            // Si el estado no es 'checked_out', lanzamos un error personalizado
            throw new Error('El servicio debe estar en estado Checkout para poder ser pagado.');
        }
        
        // 2. Si la validación pasa, insertamos el pago
        const paymentResult = await db.query(
            'INSERT INTO payments (tenant_id, appointment_id, amount, payment_method, cashier_id, payment_date) VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING *',
            [tenant_id, appointment_id, amount, payment_method, cashier_id]
        );
        
        // 3. Actualizamos el estado de la cita a 'completed'
        await db.query(
            "UPDATE appointments SET status = 'completed', updated_at = NOW() WHERE id = $1", 
            [appointment_id]
        );

        // 4. Si todo ha ido bien, confirmamos los cambios en la base de datos
        await db.query('COMMIT');
        
        // 5. Enviamos la respuesta con el pago creado
        res.status(201).json(paymentResult.rows[0]);

    } catch (error) {
        // Si algo falla en cualquier punto del 'try', revertimos todos los cambios
        await db.query('ROLLBACK');
        
        console.error('Error al crear el pago:', error.message);
        // Enviamos el mensaje de error específico (el que lanzamos o el de la BD)
        res.status(400).json({ error: error.message });
    }
};

// Obtener todos los pagos de un Tenant (sin cambios)
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