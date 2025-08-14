const db = require('../config/db');

// Esta función se mantiene, pero la nueva será la principal para el turnero.
exports.getNextAvailable = async (req, res) => {
    const { tenant_id } = req.user;
    try {
        const result = await db.query(
            `SELECT id, first_name, last_name, last_service_at FROM users
             WHERE tenant_id = $1 AND role_id = 3 AND status = 'active'
             ORDER BY last_service_at ASC NULLS FIRST
             LIMIT 1;`,
            [tenant_id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'No hay estilistas disponibles.' });
        }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error al obtener el siguiente estilista:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// ✅ NUEVA FUNCIÓN: El corazón del turnero inteligente
// ✅ NUEVA FUNCIÓN: El corazón del turnero inteligente
exports.suggestStylistByTurn = async (req, res) => {
    const { tenant_id } = req.user;
    // Recibimos la fecha y hora deseadas desde el frontend
    const { date, start_time, service_id } = req.query;

    if (!date || !start_time || !service_id) {
        return res.status(400).json({ message: 'Se requiere fecha, hora de inicio y servicio.' });
    }

    try {
        // ==================================================================
        // CORRECCIÓN FINAL Y DEFINITIVA
        // El nombre correcto es 'duration_minutes' (con T de Tomate)
        // ==================================================================

        // 1. Obtener la duración del servicio para calcular la hora de fin
        const serviceResult = await db.query('SELECT duration_minutes FROM services WHERE id = $1 AND tenant_id = $2', [service_id, tenant_id]);
        
        if (serviceResult.rows.length === 0) {
            return res.status(404).json({ message: 'Servicio no encontrado.' });
        }
        
        // También usamos el nombre correcto aquí
        const duration = serviceResult.rows[0].duration_minutes; // en minutos

        // ==================================================================
        // FIN DEL AJUSTE.
        // ==================================================================

        // 2. Calcular la ventana de tiempo de la cita en formato UTC
        const startTimeUTC = new Date(`${date}T${start_time}`);
        const endTimeUTC = new Date(startTimeUTC.getTime() + duration * 60000);

        // 3. La consulta mágica
        const suggestedStylistResult = await db.query(
            `
            SELECT u.id, u.first_name, u.last_name
            FROM users u
            WHERE u.tenant_id = $1
              AND u.role_id = 3
              AND u.status = 'active'
              AND NOT EXISTS (
                  SELECT 1
                  FROM appointments a
                  WHERE a.stylist_id = u.id
                    AND a.status NOT IN ('cancelled', 'completed')
                    AND a.start_time < $3
                    AND a.end_time > $2
              )
            ORDER BY u.last_service_at ASC NULLS FIRST
            LIMIT 1;
            `,
            [tenant_id, startTimeUTC.toISOString(), endTimeUTC.toISOString()]
        );

        if (suggestedStylistResult.rows.length === 0) {
            return res.status(404).json({ message: 'No se encontraron estilistas disponibles en ese horario.' });
        }

        res.status(200).json(suggestedStylistResult.rows[0]);

    } catch (error) {
        console.error('Error al sugerir estilista por turno:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};