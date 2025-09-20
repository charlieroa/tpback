// =============================================
// File: src/controllers/paymentController.js
// VERSIÓN FINAL CORREGIDA
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

    // 1) Validar sesión de caja
    const openSession = await client.query("SELECT id FROM cash_sessions WHERE tenant_id = $1 AND status = 'OPEN'", [tenant_id]);
    const cash_session_id = openSession.rowCount > 0 ? openSession.rows[0].id : null;
    if (!cash_session_id) {
      throw new Error("No hay una sesión de caja abierta. No se puede procesar el pago.");
    }

    // 2) Calcular total usando precios del momento
    let totalServices = 0;
    let totalProducts = 0;

    if (services.length > 0) {
      const svcPrices = await client.query(
        `SELECT a.id AS appointment_id, s.price::numeric AS price
         FROM appointments a JOIN services s ON a.service_id = s.id
         WHERE a.id = ANY($1::uuid[]) AND a.tenant_id = $2`,
        [services, tenant_id]
      );
      totalServices = svcPrices.rows.reduce((acc, r) => acc + Number(r.price || 0), 0);
    }

    if (products.length > 0) {
      for (const p of products) {
        const prodRes = await client.query('SELECT sale_price::numeric FROM products WHERE id = $1 AND tenant_id = $2', [p.product_id, tenant_id]);
        if (prodRes.rowCount === 0) throw new Error('Producto no encontrado.');
        totalProducts += Number(prodRes.rows[0].sale_price || 0) * Number(p.quantity || 0);
      }
    }

    const calculatedTotal = totalServices + totalProducts;
    if (!Number.isFinite(calculatedTotal) || calculatedTotal <= 0) {
      throw new Error("El total de la factura no puede ser cero o negativo.");
    }

    // 3) Determinar contexto de estilistas
    let distinctStylists = [];
    if (services.length > 0) {
      const stylistsRes = await client.query(
        `SELECT DISTINCT a.stylist_id FROM appointments a WHERE a.id = ANY($1::uuid[]) AND a.tenant_id = $2`,
        [services, tenant_id]
      );
      distinctStylists = stylistsRes.rows.map(r => r.stylist_id);
    }

    // 4) Crear factura
    const invoiceRes = await client.query(
      `INSERT INTO invoices (tenant_id, client_id, cash_session_id, total_amount, status)
       VALUES ($1, $2, $3, $4, 'open') RETURNING id`,
      [tenant_id, client_id, cash_session_id, calculatedTotal]
    );
    const invoiceId = invoiceRes.rows[0].id;

    // 5) ÍTEMS DE SERVICIO (congelan precio Y CALCULAN COMISIÓN)
    if (services.length > 0) {
      // Se buscan más datos, incluyendo el estilista y su tasa de comisión.
      const svcRows = await client.query(
        `SELECT
            a.id AS appointment_id,
            a.stylist_id,
            s.name,
            s.price::numeric,
            u.commission_rate
         FROM appointments a
         JOIN services s ON a.service_id = s.id
         JOIN users u ON a.stylist_id = u.id
         WHERE a.id = ANY($1::uuid[]) AND a.tenant_id = $2`,
        [services, tenant_id]
      );

      for (const row of svcRows.rows) {
        const { appointment_id, name, price, stylist_id, commission_rate } = row;

        // Se calcula el valor de la comisión.
        const servicePrice = Number(price || 0);
        const commissionRate = Number(commission_rate || 0); // Ej: 0.50 para 50%
        const calculatedCommissionValue = servicePrice * commissionRate;

        // Se inserta el valor calculado en la nueva columna.
        await client.query(
          `INSERT INTO invoice_items
            (invoice_id, item_type, related_id, description, quantity, unit_price, total_price, commission_value, seller_id, tenant_id)
           VALUES ($1, 'service', $2, $3, 1, $4, $4, $5, $6, $7)`,
          [invoiceId, appointment_id, name, servicePrice, calculatedCommissionValue, stylist_id, tenant_id]
        );

        // Marcar appointment como completado
        await client.query(
          "UPDATE appointments SET status = 'completed', updated_at = NOW() WHERE id = $1 AND tenant_id = $2",
          [appointment_id, tenant_id]
        );
      }
    }
    
    // 6) ÍTEMS DE PRODUCTO (con su propia lógica de comisión, si la tuviera)
    if (products.length > 0) {
      // ... (tu lógica de productos aquí, asegúrate de que también calcule commission_value si aplica)
      // Por ahora, se mantiene tu lógica original que asume un trigger o cálculo posterior.
      for (const p of products) {
        const { product_id, quantity, seller_id = null } = p;
        let sellerToUse = seller_id || null;
        if (!sellerToUse) {
          if (distinctStylists.length === 1) {
            sellerToUse = distinctStylists[0];
          } else {
            throw new Error('Falta "seller_id" en un producto y la factura tiene 0 o múltiples estilistas.');
          }
        }
        const prodRes = await client.query('SELECT name, sale_price::numeric FROM products WHERE id = $1 AND tenant_id = $2', [product_id, tenant_id]);
        if (prodRes.rowCount === 0) throw new Error('Producto no encontrado.');
        const { name: prodName, sale_price } = prodRes.rows[0];
        const unit = Number(sale_price || 0);
        const qty = Number(quantity || 0);
        const lineTotal = unit * qty;

        // NOTA: Aquí también deberías calcular la comisión del producto si aplica.
        // Por simplicidad, se deja como estaba, asumiendo 0 o que otro sistema lo maneja.
        await client.query(
          `INSERT INTO invoice_items
            (invoice_id, item_type, related_id, description, quantity, unit_price, total_price, seller_id, tenant_id)
           VALUES ($1, 'product', $2, $3, $4, $5, $6, $7, $8)`,
          [invoiceId, product_id, prodName, qty, unit, lineTotal, sellerToUse, tenant_id]
        );

        const stockUpdate = await client.query("UPDATE products SET stock = stock - $1 WHERE id = $2 AND tenant_id = $3 AND stock >= $1", [qty, product_id, tenant_id]);
        if (stockUpdate.rowCount === 0) {
          throw new Error(`Stock insuficiente para el producto: ${prodName}`);
        }
      }
    }

    // 7) Registrar Pagos
    for (const p of payments) {
      await client.query(
        `INSERT INTO payments (tenant_id, invoice_id, amount, payment_method, cashier_id, cash_session_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [tenant_id, invoiceId, Number(p.amount || 0), p.payment_method, cashier_id, cash_session_id]
      );
      if (String(p.payment_method || '').toLowerCase() === 'cash') {
        await client.query(
          `INSERT INTO cash_movements (tenant_id, user_id, invoice_id, type, description, amount, category, payment_method, cash_session_id)
           VALUES ($1, $2, $3, 'income', $4, $5, 'sale', 'cash', $6)`,
          [tenant_id, cashier_id, invoiceId, `Ingreso por Factura #${String(invoiceId).slice(0, 8)}`, Number(p.amount || 0), cash_session_id]
        );
      }
    }
    
    // 8) Poner factura en 'paid'
    await client.query(`UPDATE invoices SET status = 'paid' WHERE id = $1 AND tenant_id = $2`, [invoiceId, tenant_id]);

    await client.query('COMMIT');
    return res.status(201).json({
      success: true,
      message: 'Pago y factura creados con éxito',
      invoiceId,
      total_amount: calculatedTotal,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al crear la factura y el pago:', error);
    return res.status(400).json({ error: error.message || 'No se pudo crear la factura.' });
  } finally {
    client.release();
  }
};

/**
 * (Legacy) Obtiene todos los pagos de un tenant.
 */
exports.getPaymentsByTenant = async (_req, res) => {
  res.status(200).json([]);
};