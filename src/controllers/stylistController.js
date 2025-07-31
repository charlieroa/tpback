// Contenido para el NUEVO archivo: src/controllers/stylistController.js

const db = require('../config/db');

exports.getNextAvailable = async (req, res) => {
    // El tenant_id lo obtenemos del token del usuario que hace la petición
    const { tenant_id } = req.user;

    try {
        // Esta consulta SQL es el corazón del turnero
        const result = await db.query(
            `SELECT id, first_name, last_name, last_service_at FROM users
             WHERE tenant_id = $1
               AND role_id = 3      -- Rol de Estilista
               AND status = 'active'  -- Que esté activo
             ORDER BY last_service_at ASC NULLS FIRST
             LIMIT 1;` // Ordena por fecha de último servicio (los nulos, que nunca han trabajado, van primero) y toma solo el primero.
            , [tenant_id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'No hay estilistas disponibles en este momento.' });
        }

        res.status(200).json(result.rows[0]);

    } catch (error) {
        console.error('Error al obtener el siguiente estilista disponible:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};