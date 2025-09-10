// =========================================================
// File: src/controllers/staffPurchaseController.js
// (Tu versión, fusionada con la lógica de seller_user_id)
// =========================================================
const db = require('../config/db');

exports.createPurchase = async (req, res) => {
    // <-- CAMBIO 1: Capturamos el ID del usuario logueado (el vendedor) del token.
    const { tenant_id, id: seller_user_id } = req.user;
    const { stylist_id, items, purchase_date, payment_terms_weeks } = req.body;

    if (!stylist_id || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'Se requiere stylist_id y una lista no vacía de items.' });
    }

    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        // ... (Toda tu lógica de validación y cálculo de precios se mantiene, es excelente) ...
        const styRes = await client.query(`SELECT id FROM users WHERE id = $1 AND tenant_id = $2 AND role_id = 3`, [stylist_id, tenant_id]);
        if (styRes.rowCount === 0) { throw new Error('El estilista no existe o no pertenece a tu negocio.'); }

        let totalAmount = 0;
        const normalized = [];
        for (const it of items) {
            const { product_id, quantity } = it || {};
            const qty = Number(quantity);
            if (!product_id || !Number.isFinite(qty) || qty <= 0) { throw new Error('Cada item debe tener product_id y quantity > 0.'); }

            const prodRes = await client.query(`SELECT id, sale_price, staff_price, stock FROM products WHERE id = $1 AND tenant_id = $2`, [product_id, tenant_id]);
            if (prodRes.rowCount === 0) { throw new Error('Producto no encontrado o no pertenece a tu negocio.'); }
            const prod = prodRes.rows[0];

            const rawPrice = it.price_at_sale != null && it.price_at_sale !== '' ? Number(it.price_at_sale) : (prod.staff_price != null ? Number(prod.staff_price) : Number(prod.sale_price));
            if (!Number.isFinite(rawPrice) || rawPrice < 0) { throw new Error('price_at_sale inválido para algún producto.'); }
            
            totalAmount += rawPrice * qty;
            normalized.push({ product_id, quantity: qty, price_at_sale: rawPrice });
        }
        if (totalAmount <= 0) { throw new Error('El total de la compra debe ser mayor que cero.'); }

        // <-- CAMBIO 2: Añadimos seller_user_id a la consulta INSERT.
        const purchaseRes = await client.query(
            `INSERT INTO staff_purchases (tenant_id, stylist_id, seller_user_id, total_amount, purchase_date, payment_terms_weeks)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id`,
            [tenant_id, stylist_id, seller_user_id, totalAmount, purchase_date || new Date(), payment_terms_weeks || 1]
        );
        const purchaseId = purchaseRes.rows[0].id;

        // ... (Tu lógica para insertar ítems y descontar stock se mantiene intacta) ...
        for (const row of normalized) {
            const upd = await client.query(`UPDATE products SET stock = stock - $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3 AND stock >= $1 RETURNING stock`, [row.quantity, row.product_id, tenant_id]);
            if (upd.rowCount === 0) { throw new Error('Stock insuficiente en uno de los productos.'); }
            await client.query(`INSERT INTO staff_purchase_items (purchase_id, product_id, quantity, price_at_sale) VALUES ($1, $2, $3, $4)`, [purchaseId, row.product_id, row.quantity, row.price_at_sale]);
        }

        await client.query('COMMIT');
        return res.status(201).json({
            success: true,
            message: 'Compra registrada con éxito.',
            purchaseId,
            total_amount: totalAmount,
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error al registrar compra de personal:', err);
        return res.status(400).json({ error: err.message || 'Error interno del servidor' });
    } finally {
        client.release();
    }
};

// --- El resto de tus funciones no necesitan cambios ---

exports.getPurchasesByStylist = async (req, res) => {
    // ... (Tu código original)
    const { tenant_id } = req.user;
    const { stylistId } = req.params;
    try {
        const val = await db.query(`SELECT 1 FROM users WHERE id = $1 AND tenant_id = $2 AND role_id = 3`,[stylistId, tenant_id]);
        if (val.rowCount === 0) { return res.status(404).json({ error: 'Estilista no encontrado en tu negocio.' });}
        const result = await db.query( `SELECT sp.*, (SELECT COALESCE(SUM(quantity),0) FROM staff_purchase_items spi WHERE spi.purchase_id = sp.id) AS total_units FROM staff_purchases sp WHERE sp.stylist_id = $1 AND sp.tenant_id = $2 ORDER BY sp.purchase_date DESC`, [stylistId, tenant_id]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error al obtener las compras del estilista:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

exports.getPurchaseWithItems = async (req, res) => {
    // ... (Tu código original)
    const { tenant_id } = req.user;
    const { purchaseId } = req.params;
    try {
        const head = await db.query(`SELECT sp.*, u.first_name, u.last_name FROM staff_purchases sp JOIN users u ON sp.stylist_id = u.id WHERE sp.id = $1 AND sp.tenant_id = $2`, [purchaseId, tenant_id]);
        if (head.rowCount === 0) { return res.status(404).json({ error: 'Compra no encontrada.' }); }
        const items = await db.query(`SELECT spi.*, p.name AS product_name FROM staff_purchase_items spi JOIN products p ON p.id = spi.product_id WHERE spi.purchase_id = $1`, [purchaseId]);
        res.status(200).json({ purchase: head.rows[0], items: items.rows });
    } catch (error) {
        console.error('Error al obtener detalle de compra:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

exports.updatePurchaseStatus = async (req, res) => {
    // ... (Tu código original)
    const { tenant_id } = req.user;
    const { purchaseId } = req.params;
    const { status } = req.body;
    const valid = ['pendiente', 'deducido', 'parcial'];
    if (!valid.includes(String(status))) { return res.status(400).json({ error: "Estado inválido. Use 'pendiente', 'deducido' o 'parcial'." });}
    try {
        const result = await db.query(`UPDATE staff_purchases SET status = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3 RETURNING *`,[status, purchaseId, tenant_id]);
        if (result.rowCount === 0) { return res.status(404).json({ message: 'Compra no encontrada.' }); }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error al actualizar el estado de la compra:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};