// src/controllers/stylistController.js
const db = require('../config/db');

/**
 * GET /api/stylists/next-available
 * Siguiente estilista en la cola global (sin filtrar por servicio ni horario).
 * Ordena por la “antigüedad de turno” global: primero last_turn_at, si no existe usa last_service_at.
 */
exports.getNextAvailable = async (req, res) => {
  const { tenant_id } = req.user;
  try {
    const result = await db.query(
      `
      SELECT id, first_name, last_name, last_service_at, last_turn_at
      FROM users
      WHERE tenant_id = $1
        AND role_id = 3
        AND status = 'active'
      ORDER BY COALESCE(last_turn_at, last_service_at) ASC NULLS FIRST
      LIMIT 1;
      `,
      [tenant_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'No hay estilistas disponibles.' });
    }
    return res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error('Error al obtener el siguiente estilista:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/**
 * GET /api/stylists/suggest-by-turn
 * Sugerir estilista calificado y disponible para (fecha, hora, servicio),
 * ordenando por la cola global (COALESCE(last_turn_at, last_service_at)).
 * Después de sugerir, actualiza last_turn_at = NOW() para moverlo al final de la cola.
 * Query params: date=YYYY-MM-DD, start_time=HH:mm[:ss], service_id=<id>
 */
exports.suggestStylistByTurn = async (req, res) => {
  const { tenant_id } = req.user;
  const { date, start_time, service_id } = req.query;

  if (!date || !start_time || !service_id) {
    return res.status(400).json({ message: 'Se requiere fecha, hora de inicio y servicio.' });
  }

  try {
    // 1) Duración del servicio
    const serviceResult = await db.query(
      'SELECT duration_minutes FROM services WHERE id = $1 AND tenant_id = $2',
      [service_id, tenant_id]
    );
    if (serviceResult.rows.length === 0) {
      return res.status(404).json({ message: 'Servicio no encontrado.' });
    }
    const duration = serviceResult.rows[0].duration_minutes; // minutos

    // 2) Ventana de tiempo de la cita (UTC)
    const startTimeUTC = new Date(`${date}T${start_time}`);
    const endTimeUTC = new Date(startTimeUTC.getTime() + duration * 60000);

    // 3) Buscar estilista calificado, disponible y más “antiguo” en la cola global
    const suggested = await db.query(
      `
      SELECT u.id, u.first_name, u.last_name
      FROM users u
      WHERE u.tenant_id = $1
        AND u.role_id = 3
        AND u.status = 'active'
        AND EXISTS (
          SELECT 1
          FROM stylist_services ss
          WHERE ss.stylist_id = u.id
            AND ss.service_id = $2
        )
        AND NOT EXISTS (
          SELECT 1
          FROM appointments a
          WHERE a.stylist_id = u.id
            AND a.status NOT IN ('cancelled', 'completed')
            AND a.start_time < $4   -- solapa: empieza antes de que termine la nueva
            AND a.end_time   > $3   -- solapa: termina después de que empiece la nueva
        )
      ORDER BY COALESCE(u.last_turn_at, u.last_service_at) ASC NULLS FIRST
      LIMIT 1;
      `,
      [tenant_id, service_id, startTimeUTC.toISOString(), endTimeUTC.toISOString()]
    );

    if (suggested.rows.length === 0) {
      return res.status(404).json({ message: 'No se encontraron estilistas disponibles en ese horario.' });
    }

    const stylist = suggested.rows[0];

    // 4) Moverlo al final de la cola global (para todas sus categorías)
    await db.query('UPDATE users SET last_turn_at = NOW() WHERE id = $1', [stylist.id]);

    return res.status(200).json(stylist);
  } catch (error) {
    console.error('Error al sugerir estilista por turno:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};
