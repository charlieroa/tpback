// src/controllers/stylistController.js
const db = require('../config/db');

// -------------------------------
// Utilidades compartidas
// -------------------------------

// Estados que BLOQUEAN disponibilidad
// (si no quieres que 'pending_approval' bloquee, elimínalo de la lista)
const BLOCKING_STATUSES = [
  'scheduled',
  'rescheduled',
  'checked_in',
  'checked_out',
  'pending_approval'
];

// Obtiene duración (minutos) del servicio; si no existe, usa fallback
async function getServiceDurationMinutes(service_id, tenant_id, fallback = 60) {
  if (!service_id) return fallback;
  const res = await db.query(
    'SELECT duration_minutes FROM services WHERE id = $1 AND tenant_id = $2',
    [service_id, tenant_id]
  );
  if (res.rows.length === 0) return fallback;
  const n = Number(res.rows[0].duration_minutes);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Construye Date local (sin 'Z') a partir de YYYY-MM-DD + HH:mm (o HH:mm:ss)
function makeLocalDate(dateStr, timeStr) {
  const t = timeStr.length === 5 ? `${timeStr}:00` : timeStr;
  // Interpretado en zona local del servidor
  return new Date(`${dateStr}T${t}`);
}

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
    // 1) Duración real del servicio (por tenant)
    const duration = await getServiceDurationMinutes(service_id, tenant_id, 60);

    // 2) Ventana de tiempo (LOCAL)
    const startLocal = makeLocalDate(date, start_time);
    const endLocal = new Date(startLocal.getTime() + duration * 60000);

    // 3) Buscar estilista calificado, disponible y más “antiguo” en la cola global
    //    - skills: stylist_services.user_id (unificado con createAppointment)
    //    - disponibilidad: sin solape con estados bloqueantes
    //    - por tenant en appointments
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
          WHERE ss.user_id   = u.id
            AND ss.service_id = $2
        )
        AND NOT EXISTS (
          SELECT 1
          FROM appointments a
          WHERE a.tenant_id  = $1
            AND a.stylist_id = u.id
            AND a.status = ANY($5)
            AND (a.start_time, a.end_time) OVERLAPS ($3, $4)
        )
      ORDER BY COALESCE(u.last_turn_at, u.last_service_at) ASC NULLS FIRST
      LIMIT 1;
      `,
      [tenant_id, service_id, startLocal, endLocal, BLOCKING_STATUSES]
    );

    if (suggested.rows.length === 0) {
      return res.status(404).json({ message: 'No se encontraron estilistas disponibles en ese horario.' });
    }

    const stylist = suggested.rows[0];

    // 4) Moverlo al final de la cola global (para todas sus categorías)
    //    Si prefieres mover solo al crear la cita, comenta esta línea;
    //    pero asegúrate de que en createAppointment ya estás actualizando last_turn_at (lo hicimos).
    await db.query('UPDATE users SET last_turn_at = NOW() WHERE id = $1', [stylist.id]);

    return res.status(200).json(stylist);
  } catch (error) {
    console.error('Error al sugerir estilista por turno:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};
