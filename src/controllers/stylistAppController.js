// src/controllers/stylistAppController.js
const db = require('../config/db');

/* ============================================================
   1) Dashboard Stats
   GET /api/stylists/stats
   Retorna:
   - services_today: Citas completadas hoy
   - earnings_today: Ganancia estimada (comisión) de hoy
   - pending_approval: Citas pendientes de aprobación (futuras o pasadas)
   - total_services_month: Servicios completados este mes
============================================================ */
exports.getDashboardStats = async (req, res) => {
    // El middleware authMiddleware inyecta req.user
    // Se asume que el usuario es un estilista (role_id=3)
    const { id: stylistId, tenant_id, commission_rate } = req.user;

    try {
        // 1. Servicios Completados HOY
        const todayStatsQuery = `
      SELECT COUNT(a.id) as count, SUM(s.price) as total_sales
      FROM appointments a
      JOIN services s ON a.service_id = s.id
      WHERE a.stylist_id = $1
        AND a.tenant_id = $2
        AND a.status IN ('completed', 'checked_out')
        AND DATE(a.start_time AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota') = DATE(NOW() AT TIME ZONE 'America/Bogota')
    `;
        const todayRes = await db.query(todayStatsQuery, [stylistId, tenant_id]);
        const servicesToday = parseInt(todayRes.rows[0].count || 0, 10);
        const salesToday = parseFloat(todayRes.rows[0].total_sales || 0);

        // Calcular ganancia basada en comisión (si aplica)
        // commission_rate viene del token/user (ej: 0.50 para 50%)
        const rate = parseFloat(commission_rate || 0);
        const earningsToday = salesToday * rate;

        // 2. Pendientes de Aprobación (Total global)
        const pendingQuery = `
      SELECT COUNT(id) as count
      FROM appointments
      WHERE stylist_id = $1
        AND tenant_id = $2
        AND status = 'pending_approval'
    `;
        const pendingRes = await db.query(pendingQuery, [stylistId, tenant_id]);
        const pendingApproval = parseInt(pendingRes.rows[0].count || 0, 10);

        // 3. Total del Mes (para KPI adicional)
        const monthQuery = `
      SELECT COUNT(id) as count
      FROM appointments
      WHERE stylist_id = $1
        AND tenant_id = $2
        AND status IN ('completed', 'checked_out')
        AND date_trunc('month', start_time AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota') = date_trunc('month', NOW() AT TIME ZONE 'America/Bogota')
    `;
        const monthRes = await db.query(monthQuery, [stylistId, tenant_id]);
        const totalServicesMonth = parseInt(monthRes.rows[0].count || 0, 10);

        return res.status(200).json({
            stylist_id: stylistId,
            services_today: servicesToday,
            earnings_today: earningsToday, // Ganancia estimada del estilista
            pending_approval: pendingApproval,
            total_services_month: totalServicesMonth
        });

    } catch (error) {
        console.error('Error getting stylist dashboard stats:', error);
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
};

/* ============================================================
   2) Update Location
   POST /api/stylists/location
   Body: { lat, lng, is_inside_geofence }
============================================================ */
exports.updateLocation = async (req, res) => {
    const { id: stylistId, tenant_id } = req.user;
    const { lat, lng, is_inside_geofence } = req.body;

    if (lat === undefined || lng === undefined) {
        return res.status(400).json({ error: 'lat y lng son requeridos' });
    }

    try {
        await db.query(
            `UPDATE users
       SET current_lat = $1,
           current_lng = $2,
           is_inside_geofence = $3,
           last_location_update = NOW()
       WHERE id = $4 AND tenant_id = $5`,
            [lat, lng, !!is_inside_geofence, stylistId, tenant_id]
        );

        return res.status(200).json({ success: true, message: 'Ubicación actualizada' });

    } catch (error) {
        console.error('Error updating stylist location:', error);
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
};
