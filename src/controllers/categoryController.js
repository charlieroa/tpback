// src/controllers/categoryController.js
const db = require('../config/db');

// Crear una nueva Categoría de Servicio
exports.createCategory = async (req, res) => {
    const { name } = req.body;
    const { tenant_id } = req.user; // Obtenemos el tenant_id desde el token
    try {
        const result = await db.query(
            'INSERT INTO service_categories (tenant_id, name) VALUES ($1, $2) RETURNING *',
            [tenant_id, name]
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        if (error.code === '23505') {
            return res.status(409).json({ error: 'Ya existe una categoría con ese nombre.' });
        }
        console.error('Error al crear la categoría:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// Obtener todas las categorías de un Tenant
exports.getCategoriesByTenant = async (req, res) => {
    const { tenant_id } = req.user;
    try {
        const result = await db.query('SELECT * FROM service_categories WHERE tenant_id = $1 ORDER BY name', [tenant_id]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error al obtener categorías:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// Actualizar una Categoría
exports.updateCategory = async (req, res) => {
    const { id } = req.params;
    const { name } = req.body;
    try {
        const result = await db.query(
            'UPDATE service_categories SET name = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
            [name, id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Categoría no encontrada.' });
        }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error al actualizar la categoría:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// Eliminar una Categoría
exports.deleteCategory = async (req, res) => {
    const { id } = req.params;
    try {
        await db.query('DELETE FROM service_categories WHERE id = $1', [id]);
        res.status(204).send();
    } catch (error) {
        console.error('Error al eliminar la categoría:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};