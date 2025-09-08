// En: src/controllers/productCategoryController.js
const db = require('../config/db');

// Crear una nueva Categoría de Producto (Ya la tienes)
exports.createCategory = async (req, res) => {
    const { name } = req.body;
    const { tenant_id } = req.user;
    if (!name) {
        return res.status(400).json({ error: 'El campo "name" es obligatorio.' });
    }
    try {
        const result = await db.query(
            'INSERT INTO product_categories (tenant_id, name) VALUES ($1, $2) RETURNING *',
            [tenant_id, name]
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        if (error.code === '23505') {
            return res.status(409).json({ error: 'Ya existe una categoría de producto con ese nombre.' });
        }
        console.error('Error al crear la categoría de producto:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// Obtener todas las categorías de un Tenant (Ya la tienes)
exports.getAllCategories = async (req, res) => {
    const { tenant_id } = req.user;
    try {
        const result = await db.query('SELECT * FROM product_categories WHERE tenant_id = $1 ORDER BY name', [tenant_id]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error al obtener las categorías de producto:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// ======================================================
// ========= NUEVAS FUNCIONES QUE DEBES AÑADIR =========
// ======================================================

/**
 * Actualiza una categoría de producto existente.
 */
exports.updateCategory = async (req, res) => {
    const { id } = req.params;
    const { name } = req.body;
    const { tenant_id } = req.user;

    if (!name) {
        return res.status(400).json({ error: 'El campo "name" es obligatorio.' });
    }

    try {
        const result = await db.query(
            'UPDATE product_categories SET name = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3 RETURNING *',
            [name, id, tenant_id]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Categoría no encontrada o no pertenece a tu negocio.' });
        }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        if (error.code === '23505') {
            return res.status(409).json({ error: 'Ya existe otra categoría con ese nombre.' });
        }
        console.error('Error al actualizar la categoría de producto:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

/**
 * Elimina una categoría de producto.
 */
exports.deleteCategory = async (req, res) => {
    const { id } = req.params;
    const { tenant_id } = req.user;

    try {
        // NOTA: Gracias a "ON DELETE SET NULL" en la tabla 'products',
        // al eliminar una categoría, los productos asociados no se borran,
        // simplemente su 'category_id' se establecerá en NULL.
        const result = await db.query(
            'DELETE FROM product_categories WHERE id = $1 AND tenant_id = $2',
            [id, tenant_id]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Categoría no encontrada o no pertenece a tu negocio.' });
        }
        res.status(204).send(); // Éxito, sin contenido que devolver
    } catch (error) {
        console.error('Error al eliminar la categoría de producto:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};