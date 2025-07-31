// src/controllers/productController.js
const db = require('../config/db');

// --- CRUD de Productos ---

exports.createProduct = async (req, res) => {
    const { tenant_id, name, description, price, stock = 0 } = req.body;
    if (!tenant_id || !name || !price) {
        return res.status(400).json({ error: 'Campos obligatorios: tenant_id, name, price.' });
    }
    try {
        // VERIFICADO: Todos los nombres de columna son correctos.
        const result = await db.query(
            'INSERT INTO products (tenant_id, name, description, price, stock) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [tenant_id, name, description, price, stock]
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Error al crear el producto:', error); // Este es el error que debes buscar en la terminal
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// ... (el resto del código que ya tenías puede quedarse igual, el error suele estar en la función que falla)
// Pero para estar 100% seguros, puedes reemplazar todo el archivo.

// Obtener todos los Productos de un Tenant
exports.getProductsByTenant = async (req, res) => {
    const { tenantId } = req.params;
    try {
        const result = await db.query('SELECT * FROM products WHERE tenant_id = $1 ORDER BY name', [tenantId]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error al obtener productos:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// Actualizar un Producto
exports.updateProduct = async (req, res) => {
    const { id } = req.params;
    const { name, description, price } = req.body;
    try {
        const result = await db.query(
            'UPDATE products SET name = $1, description = $2, price = $3, updated_at = NOW() WHERE id = $4 RETURNING *',
            [name, description, price, id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Producto no encontrado' });
        }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error al actualizar el producto:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// --- Gestión de Stock ---
exports.manageStock = async (req, res) => {
    const { productId } = req.params;
    const { type, quantity, tenant_id } = req.body;

    if (!type || !quantity || !tenant_id) {
        return res.status(400).json({ error: 'Faltan campos: type, quantity, tenant_id.' });
    }

    const qty = parseInt(quantity, 10);
    if (isNaN(qty)) return res.status(400).json({ error: 'La cantidad debe ser un número.'});

    try {
        await db.query('BEGIN');
        let stockUpdateQuery;
        if (type === 'purchase' || (type === 'adjustment' && qty >= 0)) {
            stockUpdateQuery = 'UPDATE products SET stock = stock + $1, updated_at = NOW() WHERE id = $2 RETURNING stock';
        } else if (type === 'sale' || (type === 'adjustment' && qty < 0)) {
            stockUpdateQuery = 'UPDATE products SET stock = stock - $1, updated_at = NOW() WHERE id = $2 AND stock >= $1 RETURNING stock';
        } else {
            throw new Error('Tipo de movimiento no válido.');
        }
        const productUpdateResult = await db.query(stockUpdateQuery, [Math.abs(qty), productId]);
        if (productUpdateResult.rowCount === 0) {
            throw new Error('Stock insuficiente para la venta o producto no encontrado.');
        }
        await db.query(
            'INSERT INTO inventory_movements (tenant_id, product_id, type, quantity) VALUES ($1, $2, $3, $4)',
            [tenant_id, productId, type, qty]
        );
        await db.query('COMMIT');
        res.status(200).json({ message: 'Stock actualizado con éxito', newStock: productUpdateResult.rows[0].stock });
    } catch (error) {
        await db.query('ROLLBACK');
        console.error('Error al gestionar el stock:', error.message);
        res.status(500).json({ error: `Error interno del servidor: ${error.message}` });
    }
};