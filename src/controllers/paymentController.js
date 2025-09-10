// =============================================
// File: src/controllers/paymentController.js
// (Soporta seller_id en productos + congela comisiones)
// =============================================
const db = require('../config/db');

/**
 * Crea una factura, sus ítems (servicios y productos), actualiza el stock,
 * registra los pagos y los movimientos de caja. TODO en una transacción.
 *
 * Espera:
 *  - services: array de appointment_id (uuid)
 *  - products: array de { product_id (uuid), quantity (int), seller_id? (uuid) }
 *    * Si NO se envía seller_id y la factura tiene exactamente 1 estilista por servicios,
 *      se usa ese estilista. Si hay 0 o >1 estilistas, se exige seller_id en cada producto.
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

    // 1) Validar sesión de caja (para pagos en efectivo)
    const openSession = await client.query(
      "SELECT id FROM cash_sessions WHERE tenant_id = $1 AND status = 'OPEN'",
      [tenant_id]
    );
    const cash_session_id = openSession.rowCount > 0 ? openSession.rows[0].id : null;
    if (!cash_session_id) {
      throw new Error("No hay una sesión de caja abierta. No se puede procesar el pago.");
    }

    // 2) Calcular total usando precios del momento (congelados en invoice_items)
    let totalServices = 0;
    let totalProducts = 0;

    // -- a) Servicios: sumar precios actuales del service ligado al appointment
    if (services.length > 0) {
      const svcPrices = await client.query(
        `SELECT a.id AS appointment_id, s.price::numeric AS price
           FROM appointments a
           JOIN services s ON a.service_id = s.id
          WHERE a.id = ANY($1::uuid[]) AND a.tenant_id = $2`,
        [services, tenant_id]
      );
      totalServices = svcPrices.rows.reduce((acc, r) => acc + Number(r.price || 0), 0);
    }

    // -- b) Productos: sumar sale_price * quantity
    if (products.length > 0) {
      for (const p of products) {
        const { product_id, quantity } = p;
        const prodRes = await client.query(
          'SELECT sale_price::numeric FROM products WHERE id = $1 AND tenant_id = $2',
          [product_id, tenant_id]
        );
        if (prodRes.rowCount === 0) {
          throw new Error('Producto no encontrado o no pertenece al tenant.');
        }
        const unit = Number(prodRes.rows[0].sale_price || 0);
        totalProducts += unit * Number(quantity || 0);
      }
    }

    const calculatedTotal = Number(totalServices + totalProducts);
    if (!Number.isFinite(calculatedTotal) || calculatedTotal <= 0) {
      throw new Error("El total de la factura no puede ser cero o negativo.");
    }

    // (Opcional) Enforce: suma de pagos debe coincidir con el total
    // const paymentsSum = payments.reduce((acc, p) => acc + Number(p.amount || 0), 0);
    // if (Math.round(paymentsSum * 100) !== Math.round(calculatedTotal * 100)) {
    //   throw new Error('La suma de los pagos no coincide con el total de la factura.');
    // }

    // 3) Determinar contexto de estilistas desde los appointments (para fallback de seller_id)
    let distinctStylists = [];
    if (services.length > 0) {
      const stylistsRes = await client.query(
        `SELECT DISTINCT a.stylist_id
           FROM appointments a
          WHERE a.id = ANY($1::uuid[]) AND a.tenant_id = $2`,
        [services, tenant_id]
      );
      distinctStylists = stylistsRes.rows.map(r => r.stylist_id);
    }

    // 4) Crear factura inicialmente en estado "open"
    const invoiceRes = await client.query(
      `INSERT INTO invoices (tenant_id, client_id, cash_session_id, total_amount, status)
       VALUES ($1, $2, $3, $4, 'open') RETURNING id`,
      [tenant_id, client_id, cash_session_id, calculatedTotal]
    );
    const invoiceId = invoiceRes.rows[0].id;

    // 5) ÍTEMS DE SERVICIO (congelan precio; trigger calcula comisión)
    if (services.length > 0) {
      const svcRows = await client.query(
        `SELECT a.id AS appointment_id, s.name, s.price::numeric
           FROM appointments a
           JOIN services s ON a.service_id = s.id
          WHERE a.id = ANY($1::uuid[]) AND a.tenant_id = $2`,
        [services, tenant_id]
      );
      for (const row of svcRows.rows) {
        const { appointment_id, name, price } = row;
        await client.query(
          `INSERT INTO invoice_items
             (invoice_id, item_type, related_id, description, quantity, unit_price, total_price)
           VALUES ($1, 'service', $2, $3, 1, $4, $4)`,
          [invoiceId, appointment_id, name, Number(price)]
        );
        // marcar appointment como completado (seguro por tenant)
        await client.query(
          "UPDATE appointments SET status = 'completed', updated_at = NOW() WHERE id = $1 AND tenant_id = $2",
          [appointment_id, tenant_id]
        );
      }
    }

    // 6) ÍTEMS DE PRODUCTO (requieren seller_id o fallback si hay 1 estilista)
    if (products.length > 0) {
      for (const p of products) {
        const { product_id, quantity, seller_id = null } = p;

        // Resolver seller_id efectivo
        let sellerToUse = seller_id || null;
        if (!sellerToUse) {
          if (distinctStylists.length === 1) {
            sellerToUse = distinctStylists[0];
          } else {
            throw new Error('Falta "seller_id" en un producto y la factura tiene 0 o múltiples estilistas; seleccione vendedor.');
          }
        }

        // Traer name y sale_price
        const prodRes = await client.query(
          'SELECT name, sale_price::numeric FROM products WHERE id = $1 AND tenant_id = $2',
          [product_id, tenant_id]
        );
        if (prodRes.rowCount === 0) throw new Error('Producto no encontrado o no pertenece al tenant.');
        const { name: prodName, sale_price } = prodRes.rows[0];
        const unit = Number(sale_price || 0);
        const qty = Number(quantity || 0);
        const lineTotal = unit * qty;

        // Insertar ítem (incluye seller_id → pasa el CHECK y el trigger calcula comisión)
        await client.query(
          `INSERT INTO invoice_items
             (invoice_id, item_type, related_id, description, quantity, unit_price, total_price, seller_id)
           VALUES ($1, 'product', $2, $3, $4, $5, $6, $7)`,
          [invoiceId, product_id, prodName, qty, unit, lineTotal, sellerToUse]
        );

        // Descontar stock
        const stockUpdate = await client.query(
          "UPDATE products SET stock = stock - $1 WHERE id = $2 AND tenant_id = $3 AND stock >= $1",
          [qty, product_id, tenant_id]
        );
        if (stockUpdate.rowCount === 0) {
          throw new Error(`Stock insuficiente para el producto: ${prodName}`);
        }

        // (Opcional) registrar movimiento de inventario de salida por venta
        // await client.query(
        //   `INSERT INTO inventory_movements (tenant_id, product_id, user_id, type, quantity, description)
        //    VALUES ($1, $2, $3, 'sale', $4, $5)`,
        //   [tenant_id, product_id, cashier_id, qty, `Venta en factura ${String(invoiceId).slice(0,8)}`]
        // );
      }
    }

    // 7) Registrar Pagos + cash_movements
    for (const p of payments) {
      await client.query(
        `INSERT INTO payments (tenant_id, invoice_id, amount, payment_method, cashier_id, cash_session_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [tenant_id, invoiceId, Number(p.amount || 0), p.payment_method, cashier_id, cash_session_id]
      );

      // Movimiento de caja si es efectivo
      if (String(p.payment_method || '').toLowerCase() === 'cash') {
        await client.query(
          `INSERT INTO cash_movements
             (tenant_id, user_id, invoice_id, type, description, amount, category, payment_method, cash_session_id)
           VALUES
             ($1, $2, $3, 'income', $4, $5, 'sale', 'cash', $6)`,
          [
            tenant_id,
            cashier_id,
            invoiceId,
            `Ingreso por Factura #${String(invoiceId).slice(0, 8)}`,
            Number(p.amount || 0),
            cash_session_id,
          ]
        );
      }
    }

    // 8) Poner factura en 'paid' para disparar el trigger de "congelar" comisiones
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
