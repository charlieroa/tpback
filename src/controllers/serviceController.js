// Contenido COMPLETO y FINAL para: src/controllers/serviceController.js

const db = require('../config/db');

// Crear un nuevo Servicio
exports.createService = async (req, res) => {
    const { tenant_id, name, description, price, duration_minutes, category_id } = req.body;

    if (!tenant_id || !name || !price || !duration_minutes) {
        return res.status(400).json({ error: 'Campos obligatorios: tenant_id, name, price, duration_minutes.' });
    }

    try {
        const result = await db.query(
            'INSERT INTO services (tenant_id, name, description, price, duration_minutes, category_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [tenant_id, name, description, price, duration_minutes, category_id]
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Error al crear el servicio:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// Obtener todos los servicios de un Tenant (con filtro por categoría)
exports.getServicesByTenant = async (req, res) => {
    const { tenantId } = req.params;
    const { category_id } = req.query;

    let baseQuery = 'SELECT * FROM services WHERE tenant_id = $1';
    const queryParams = [tenantId];

    if (category_id) {
        baseQuery += ' AND category_id = $2';
        queryParams.push(category_id);
    }
    
    baseQuery += ' ORDER BY name';

    try {
        const result = await db.query(baseQuery, queryParams);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error al obtener servicios:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// Obtener un servicio por su ID
exports.getServiceById = async (req, res) => {
    const { id } = req.params;
    try {
        const result = await db.query('SELECT * FROM services WHERE id = $1', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Servicio no encontrado' });
        }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error al obtener servicio por ID:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// Actualizar un Servicio
exports.updateService = async (req, res) => {
    const { id } = req.params;
    const { name, description, price, duration_minutes, category_id } = req.body;
    try {
        const result = await db.query(
            'UPDATE services SET name = $1, description = $2, price = $3, duration_minutes = $4, category_id = $5, updated_at = NOW() WHERE id = $6 RETURNING *',
            [name, description, price, duration_minutes, category_id, id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Servicio no encontrado para actualizar.' });
        }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error al actualizar servicio:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// Eliminar un Servicio
exports.deleteService = async (req, res) => {
    const { id } = req.params;
    try {
        const result = await db.query('DELETE FROM services WHERE id = $1', [id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Servicio no encontrado para eliminar' });
        }
        res.status(204).send();
    } catch (error) {
        console.error('Error al eliminar servicio:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};


// --- NUEVA FUNCIÓN AÑADIDA ---
/**
 * @description Busca y devuelve todos los estilistas cualificados para realizar un servicio específico.
 * @route GET /api/services/:id/stylists
 */
exports.getStylistsForService = async (req, res) => {
    const { id } = req.params; // ID del servicio
    const { tenant_id } = req.user; // Obtenemos el tenant del token para seguridad

    try {
        const query = `
            SELECT u.id, u.first_name, u.last_name, u.status
            FROM users u
            JOIN stylist_services ss ON u.id = ss.user_id
            WHERE ss.service_id = $1
              AND u.tenant_id = $2
              AND u.role_id = 3; -- Solo estilistas
        `;
        
        const result = await db.query(query, [id, tenant_id]);

        res.status(200).json(result.rows);

    } catch (error) {
        console.error("Error al obtener estilistas por servicio:", error);
        res.status(500).json({ error: "Error interno del servidor" });
    }
};
// --- FIN DE LA NUEVA FUNCIÓN ---