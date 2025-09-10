// =============================================
// File: src/controllers/paymentController.js (Reestructurado para Facturación)
// =============================================
const db = require('../config/db');

/**
 * Crea una factura, sus ítems (servicios y productos), actualiza el stock,
 * registra los pagos y los movimientos de caja. TODO en una transacción.
 */
exports.createInvoiceAndPayments = async (req, res) => {
    const { tenant_id, id: cashier_id } = req.user;
    const { client_id, services = [], products = [], payments = [] } = req.body;

    if (!client_id || (services.length === 0 && products.length === 0) || payments.length === 0) {
        return res.status(400).json({ error: 'Faltan datos clave: cliente, items a facturar o información de pago.' });
    }

    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        const openSession = await client.query("SELECT id FROM cash_sessions WHERE tenant_id = $1 AND status = 'OPEN'", [tenant_id]);
        const cash_session_id = openSession.rowCount > 0 ? openSession.rows[0].id : null;
        if (!cash_session_id) {
            throw new Error("No hay una sesión de caja abierta. No se puede procesar el pago.");
        }

        let calculatedTotal = 0;
        
        // Sumar servicios
        for (const apptId of services) {
            const apptRes = await client.query(
                `SELECT s.price 
                 FROM appointments a 
                 JOIN services s ON a.service_id = s.id 
                 WHERE a.id = $1 AND a.tenant_id = $2`,
                [apptId, tenant_id]
            );
            if (apptRes.rowCount > 0) calculatedTotal += Number(apptRes.rows[0].price);
        }

        // Sumar productos
        for (const prod of products) {
            const prodRes = await client.query('SELECT sale_price FROM products WHERE id = $1 AND tenant_id = $2', [prod.product_id, tenant_id]);
            if(prodRes.rowCount > 0) {
                calculatedTotal += Number(prodRes.rows[0].sale_price) * Number(prod.quantity);
            }
        }

        if (calculatedTotal <= 0) throw new Error("El total de la factura no puede ser cero o negativo.");

        const invoiceRes = await client.query(
            `INSERT INTO invoices (tenant_id, client_id, cash_session_id, total_amount, status)
             VALUES ($1, $2, $3, $4, 'paid') RETURNING id`,
            [tenant_id, client_id, cash_session_id, calculatedTotal]
        );
        const invoiceId = invoiceRes.rows[0].id;

        // Ítems de servicios
        for (const apptId of services) {
            const apptRes = await client.query(
                `SELECT s.name, s.price 
                 FROM appointments a 
                 JOIN services s ON a.service_id = s.id 
                 WHERE a.id = $1`, 
                [apptId]
            );
            if (apptRes.rowCount > 0) {
                const { name, price } = apptRes.rows[0];
                await client.query(
                    `INSERT INTO invoice_items (invoice_id, item_type, related_id, description, quantity, unit_price, total_price)
                     VALUES ($1, 'service', $2, $3, 1, $4, $4)`,
                    [invoiceId, apptId, name, price]
                );
                await client.query("UPDATE appointments SET status = 'completed', updated_at = NOW() WHERE id = $1", [apptId]);
            }
        }
        
        // Ítems de productos
        for (const prod of products) {
            const prodRes = await client.query('SELECT name, sale_price FROM products WHERE id = $1', [prod.product_id]);
            const prodName = prodRes.rowCount > 0 ? prodRes.rows[0].name : "Producto desconocido";
            const prodPrice = prodRes.rowCount > 0 ? prodRes.rows[0].sale_price : 0;
            
            await client.query(
                `INSERT INTO invoice_items (invoice_id, item_type, related_id, description, quantity, unit_price, total_price)
                 VALUES ($1, 'product', $2, $3, $4, $5, $6)`,
                [invoiceId, prod.product_id, prodName, prod.quantity, prodPrice, Number(prod.quantity) * Number(prodPrice)]
            );
            // Descontar stock
            const stockUpdate = await client.query(
                "UPDATE products SET stock = stock - $1 WHERE id = $2 AND stock >= $1",
                [prod.quantity, prod.product_id]
            );
            if (stockUpdate.rowCount === 0) throw new Error(`Stock insuficiente para el producto: ${prodName}`);
        }
        
        // Registrar Pagos
        for (const p of payments) {
            await client.query(
                `INSERT INTO payments (tenant_id, invoice_id, amount, payment_method, cashier_id, cash_session_id)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [tenant_id, invoiceId, p.amount, p.payment_method, cashier_id, cash_session_id]
            );
            
            // Si es en efectivo, registrar movimiento de caja
            if (p.payment_method.toLowerCase() === 'cash') {
                await client.query(
                    `INSERT INTO cash_movements (tenant_id, user_id, invoice_id, type, description, amount, category, payment_method, cash_session_id)
                     VALUES ($1, $2, $3, 'income', $4, $5, 'sale', 'cash', $6)`,
                    [tenant_id, cashier_id, invoiceId, `Ingreso por Factura #${invoiceId.substring(0, 8)}`, p.amount, cash_session_id]
                );
            }
        }
        
        await client.query('COMMIT');
        res.status(201).json({ success: true, message: 'Pago y factura creados con éxito', invoiceId: invoiceId });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error al crear la factura y el pago:', error.message);
        res.status(400).json({ error: error.message });
    } finally {
        client.release();
    }
};

/**
 * Obtiene todos los pagos de un tenant. (Función Legacy)
 */
exports.getPaymentsByTenant = async (req, res) => {
    res.status(200).json([]); 
};