// En: src/controllers/productCategoryController.js
const db = require('../config/db');

/**
 * Obtiene todas las categorías de producto de un tenant.
 */
exports.getAllCategories = async (req, res) => {
    const { tenant_id } = req.user;
    try {
        const result = await db.query('SELECT * FROM product_categories WHERE tenant_id = $1 ORDER BY name ASC', [tenant_id]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error al obtener las categorías de producto:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

/**
 * Crea una nueva categoría de producto.
 */
exports.createCategory = async (req, res) => {
    const { name } = req.body;
    const { tenant_id } = req.user;

    if (!name || name.trim() === '') {
        return res.status(400).json({ error: 'El campo "name" es obligatorio.' });
    }

    try {
        const result = await db.query(
            'INSERT INTO product_categories (tenant_id, name) VALUES ($1, $2) RETURNING *',
            [tenant_id, name.trim()]
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        // Código '23505' es para violaciones de unicidad en PostgreSQL
        if (error.code === '23505') {
            return res.status(409).json({ error: 'Ya existe una categoría de producto con ese nombre.' });
        }
        console.error('Error al crear la categoría de producto:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

/**
 * Actualiza una categoría de producto existente.
 */
exports.updateCategory = async (req, res) => {
    const { id } = req.params;
    const { name } = req.body;
    const { tenant_id } = req.user;

    if (!name || name.trim() === '') {
        return res.status(400).json({ error: 'El campo "name" es obligatorio.' });
    }

    try {
        const result = await db.query(
            'UPDATE product_categories SET name = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3 RETURNING *',
            [name.trim(), id, tenant_id]
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
        const result = await db.query(
            'DELETE FROM product_categories WHERE id = $1 AND tenant_id = $2',
            [id, tenant_id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Categoría no encontrada o no pertenece a tu negocio.' });
        }
        res.status(204).send(); // Éxito, sin contenido que devolver
    } catch (error) {
        // Código '23503' es para violaciones de llave foránea en PostgreSQL
        if (error.code === '23503') {
            return res.status(409).json({ error: 'No se puede eliminar la categoría porque está siendo usada por uno o más productos.' });
        }
        console.error('Error al eliminar la categoría de producto:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};