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
        // Obtener nombre del tenant
        const tenantResult = await db.query(
            'SELECT name FROM tenants WHERE id = $1',
            [tenant_id]
        );
        const tenantName = tenantResult.rows[0]?.name || 'Peluquería';

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
            tenant_name: tenantName,
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
   2) Update Location (Legacy - mantiene compatibilidad)
   POST /api/stylists/location
   Body: { lat, lng, is_inside_geofence }
   NOTA: Ahora usa updateLocationWithTracking internamente
   Esta función se define después de updateLocationWithTracking
============================================================ */

/* ============================================================
   3) Get Pending Bookings (Aceptar/Rechazar)
   GET /api/stylists/bookings/pending
   Retorna citas con status = 'pending_approval'
============================================================ */
exports.getPendingBookings = async (req, res) => {
    const { id: stylistId, tenant_id } = req.user;
    const { limit = 50, offset = 0 } = req.query;

    try {
        const result = await db.query(
            `SELECT 
                a.id,
                a.start_time,
                a.end_time,
                a.status,
                a.created_at,
                s.name as service_name,
                s.price as service_price,
                s.duration_minutes,
                c.id as client_id,
                c.first_name || ' ' || COALESCE(c.last_name, '') as client_name,
                c.phone as client_phone
            FROM appointments a
            JOIN services s ON a.service_id = s.id
            LEFT JOIN users c ON a.client_id = c.id
            WHERE a.stylist_id = $1
                AND a.tenant_id = $2
                AND a.status = 'pending_approval'
            ORDER BY a.start_time ASC
            LIMIT $3 OFFSET $4`,
            [stylistId, tenant_id, parseInt(limit), parseInt(offset)]
        );

        return res.status(200).json({
            bookings: result.rows,
            total: result.rows.length
        });
    } catch (error) {
        console.error('Error getting pending bookings:', error);
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
};

/* ============================================================
   3.5) Get All Bookings (Todas las citas del estilista)
   GET /api/stylists/bookings/all
   Retorna todas las citas del estilista (scheduled, completed, pending_approval, etc.)
============================================================ */
exports.getAllBookings = async (req, res) => {
    const { id: stylistId, tenant_id } = req.user;
    const { limit = 50, offset = 0, status, date } = req.query;

    try {
        // Obtener fecha de hoy en timezone de Bogotá para comparación
        const todayResult = await db.query(`
            SELECT DATE(NOW() AT TIME ZONE 'America/Bogota') as today
        `);
        const today = todayResult.rows[0].today.toISOString().split('T')[0];

        let query = `
            SELECT 
                a.id,
                a.start_time,
                a.end_time,
                a.status,
                a.created_at,
                s.name as service_name,
                s.price as service_price,
                s.duration_minutes,
                c.id as client_id,
                c.first_name || ' ' || COALESCE(c.last_name, '') as client_name,
                c.phone as client_phone,
                DATE(a.start_time AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota') as fecha_local
            FROM appointments a
            JOIN services s ON a.service_id = s.id
            LEFT JOIN users c ON a.client_id = c.id
            WHERE a.stylist_id = $1
                AND a.tenant_id = $2
        `;
        
        const params = [stylistId, tenant_id];
        let paramIndex = 3;

        // Filtrar solo citas de hoy y futuras (no pasadas)
        // Si se proporciona una fecha específica, filtrar por esa fecha
        if (date) {
            // Comparar la fecha sin importar la hora, usando el timezone de Bogotá
            query += ` AND DATE(a.start_time AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota') = CAST($${paramIndex} AS DATE)`;
            params.push(date);
            paramIndex++;
            console.log(`[getAllBookings] Filtrando por fecha: ${date} para estilista ${stylistId}`);
        } else {
            // Por defecto, solo mostrar citas de hoy y futuras (incluyendo las de hoy sin importar la hora)
            query += ` AND DATE(a.start_time AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota') >= CAST($${paramIndex} AS DATE)`;
            params.push(today);
            paramIndex++;
            console.log(`[getAllBookings] Filtrando desde hoy: ${today} para estilista ${stylistId}`);
        }

        if (status) {
            query += ` AND a.status = $${paramIndex}`;
            params.push(status);
            paramIndex++;
        }

        query += ` ORDER BY a.start_time ASC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(parseInt(limit), parseInt(offset));

        const result = await db.query(query, params);

        console.log(`[getAllBookings] Encontradas ${result.rows.length} citas para estilista ${stylistId}`);

        return res.status(200).json({
            bookings: result.rows,
            total: result.rows.length
        });
    } catch (error) {
        console.error('Error getting all bookings:', error);
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
};

/* ============================================================
   4) Accept/Reject Booking
   POST /api/stylists/bookings/:bookingId/approve
   POST /api/stylists/bookings/:bookingId/reject
   Body (reject): { reason? } (opcional)
============================================================ */
exports.approveBooking = async (req, res) => {
    const { id: stylistId, tenant_id } = req.user;
    const { bookingId } = req.params;

    try {
        // Verificar que la cita pertenece al estilista
        const check = await db.query(
            `SELECT id FROM appointments 
             WHERE id = $1 AND stylist_id = $2 AND tenant_id = $3 AND status = 'pending_approval'`,
            [bookingId, stylistId, tenant_id]
        );

        if (check.rowCount === 0) {
            return res.status(404).json({ error: 'Cita no encontrada o ya procesada' });
        }

        // Actualizar estado a 'confirmed'
        const result = await db.query(
            `UPDATE appointments 
             SET status = 'confirmed', updated_at = NOW()
             WHERE id = $1
             RETURNING *`,
            [bookingId]
        );

        return res.status(200).json({
            success: true,
            booking: result.rows[0],
            message: 'Cita aprobada exitosamente'
        });
    } catch (error) {
        console.error('Error approving booking:', error);
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
};

exports.rejectBooking = async (req, res) => {
    const { id: stylistId, tenant_id } = req.user;
    const { bookingId } = req.params;
    const { reason } = req.body;

    try {
        // Verificar que la cita pertenece al estilista
        const check = await db.query(
            `SELECT id FROM appointments 
             WHERE id = $1 AND stylist_id = $2 AND tenant_id = $3 AND status = 'pending_approval'`,
            [bookingId, stylistId, tenant_id]
        );

        if (check.rowCount === 0) {
            return res.status(404).json({ error: 'Cita no encontrada o ya procesada' });
        }

        // Actualizar estado a 'rejected'
        const result = await db.query(
            `UPDATE appointments 
             SET status = 'rejected', 
                 notes = COALESCE(notes || E'\\n', '') || 'Rechazada por estilista: ' || COALESCE($2, 'Sin razón especificada'),
                 updated_at = NOW()
             WHERE id = $1
             RETURNING *`,
            [bookingId, reason || null]
        );

        return res.status(200).json({
            success: true,
            booking: result.rows[0],
            message: 'Cita rechazada'
        });
    } catch (error) {
        console.error('Error rejecting booking:', error);
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
};

/* ============================================================
   5) Get Services Attended (Historial)
   GET /api/stylists/services/attended
   Query: ?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&limit=50&offset=0
============================================================ */
exports.getServicesAttended = async (req, res) => {
    const { id: stylistId, tenant_id } = req.user;
    const { start_date, end_date, limit = 50, offset = 0 } = req.query;

    try {
        let query = `
            SELECT 
                a.id,
                a.start_time,
                a.end_time,
                a.status,
                a.created_at,
                s.name as service_name,
                s.price as service_price,
                s.duration_minutes,
                c.id as client_id,
                c.first_name || ' ' || COALESCE(c.last_name, '') as client_name,
                c.phone as client_phone
            FROM appointments a
            JOIN services s ON a.service_id = s.id
            LEFT JOIN users c ON a.client_id = c.id
            WHERE a.stylist_id = $1
                AND a.tenant_id = $2
                AND a.status IN ('completed', 'checked_out')
        `;
        const params = [stylistId, tenant_id];
        let paramIndex = 3;

        if (start_date) {
            query += ` AND DATE(a.start_time AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota') >= $${paramIndex}`;
            params.push(start_date);
            paramIndex++;
        }

        if (end_date) {
            query += ` AND DATE(a.start_time AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota') <= $${paramIndex}`;
            params.push(end_date);
            paramIndex++;
        }

        query += ` ORDER BY a.start_time DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(parseInt(limit), parseInt(offset));

        const result = await db.query(query, params);

        return res.status(200).json({
            services: result.rows,
            total: result.rows.length
        });
    } catch (error) {
        console.error('Error getting services attended:', error);
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
};

/* ============================================================
   6) Get Product Sales
   GET /api/stylists/products/sales
   Query: ?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&limit=50&offset=0
============================================================ */
exports.getProductSales = async (req, res) => {
    const { id: stylistId, tenant_id } = req.user;
    const { start_date, end_date, limit = 50, offset = 0 } = req.query;

    try {
        let query = `
            SELECT 
                ii.id,
                ii.total_price,
                ii.commission_value,
                ii.quantity,
                ii.created_at,
                p.name as product_name,
                p.price as product_unit_price,
                inv.id as invoice_id,
                inv.invoice_number,
                c.id as client_id,
                c.first_name || ' ' || COALESCE(c.last_name, '') as client_name
            FROM invoice_items ii
            JOIN invoices inv ON ii.invoice_id = inv.id
            JOIN products p ON ii.related_id = p.id
            LEFT JOIN users c ON inv.client_id = c.id
            WHERE ii.seller_id = $1
                AND inv.tenant_id = $2
                AND ii.item_type = 'product'
                AND inv.status IN ('paid', 'closed', 'completed')
        `;
        const params = [stylistId, tenant_id];
        let paramIndex = 3;

        if (start_date) {
            query += ` AND DATE(inv.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota') >= $${paramIndex}`;
            params.push(start_date);
            paramIndex++;
        }

        if (end_date) {
            query += ` AND DATE(inv.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota') <= $${paramIndex}`;
            params.push(end_date);
            paramIndex++;
        }

        query += ` ORDER BY inv.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(parseInt(limit), parseInt(offset));

        const result = await db.query(query, params);

        return res.status(200).json({
            sales: result.rows,
            total: result.rows.length
        });
    } catch (error) {
        console.error('Error getting product sales:', error);
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
};

/* ============================================================
   7) Update Location with Geofence Tracking
   POST /api/stylists/location
   Body: { lat, lng, is_inside_geofence }
   Este endpoint ahora también registra entrada/salida de geocerca
============================================================ */
exports.updateLocationWithTracking = async (req, res) => {
    const { id: stylistId, tenant_id } = req.user;
    const { lat, lng, is_inside_geofence } = req.body;

    if (lat === undefined || lng === undefined) {
        return res.status(400).json({ error: 'lat y lng son requeridos' });
    }

    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        // Verificar si las columnas existen antes de usarlas
        const checkColumns = await client.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'users' 
            AND column_name IN ('is_inside_geofence', 'current_lat', 'current_lng', 'last_location_update')
        `);
        
        const existingColumns = checkColumns.rows.map(r => r.column_name);
        const hasGeofenceColumns = existingColumns.includes('is_inside_geofence');
        const hasLocationColumns = existingColumns.includes('current_lat') && existingColumns.includes('current_lng');

        let wasInside = false;
        if (hasGeofenceColumns) {
            // Obtener estado anterior solo si la columna existe
            const prevState = await client.query(
                `SELECT is_inside_geofence FROM users WHERE id = $1 AND tenant_id = $2`,
                [stylistId, tenant_id]
            );
            wasInside = prevState.rows[0]?.is_inside_geofence || false;
        }
        
        const nowInside = !!is_inside_geofence;

        // Construir query de actualización dinámicamente según las columnas disponibles
        const updateFields = [];
        const updateValues = [];
        let paramIndex = 1;

        if (hasLocationColumns) {
            updateFields.push(`current_lat = $${paramIndex++}`);
            updateValues.push(lat);
            updateFields.push(`current_lng = $${paramIndex++}`);
            updateValues.push(lng);
        }

        if (hasGeofenceColumns) {
            updateFields.push(`is_inside_geofence = $${paramIndex++}`);
            updateValues.push(nowInside);
        }

        if (existingColumns.includes('last_location_update')) {
            updateFields.push(`last_location_update = NOW()`);
        }

        if (updateFields.length > 0) {
            updateFields.push(`updated_at = NOW()`);
            updateValues.push(stylistId, tenant_id);
            
            await client.query(
                `UPDATE users
                 SET ${updateFields.join(', ')}
                 WHERE id = $${paramIndex} AND tenant_id = $${paramIndex + 1}`,
                updateValues
            );
        }

        // Registrar cambio de estado (entrada/salida) solo si las columnas existen
        if (hasGeofenceColumns && wasInside !== nowInside) {
            // Verificar si existe la tabla geofence_logs, si no, crearla dinámicamente
            // Por ahora, intentamos insertar y si falla, no es crítico
            try {
                await client.query(
                    `INSERT INTO geofence_logs (stylist_id, tenant_id, event_type, lat, lng, created_at)
                     VALUES ($1, $2, $3, $4, $5, NOW())`,
                    [
                        stylistId,
                        tenant_id,
                        nowInside ? 'entry' : 'exit',
                        lat,
                        lng
                    ]
                );
            } catch (logError) {
                // Si la tabla no existe, solo logueamos el error pero no fallamos
                console.warn('⚠️ Tabla geofence_logs no existe. Crear con: CREATE TABLE geofence_logs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), stylist_id UUID NOT NULL, tenant_id UUID NOT NULL, event_type VARCHAR(10) NOT NULL, lat DECIMAL(10,8), lng DECIMAL(11,8), created_at TIMESTAMP DEFAULT NOW());');
            }
        }

        await client.query('COMMIT');

        return res.status(200).json({
            success: true,
            message: 'Ubicación actualizada',
            geofence_event: wasInside !== nowInside ? (nowInside ? 'entry' : 'exit') : null
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating stylist location:', error);
        return res.status(500).json({ error: 'Error interno del servidor' });
    } finally {
        client.release();
    }
};

/* ============================================================
   8) Get Geofence Logs (Historial de entrada/salida)
   GET /api/stylists/geofence-logs
   Query: ?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&limit=50&offset=0
============================================================ */
exports.getGeofenceLogs = async (req, res) => {
    const { id: stylistId, tenant_id } = req.user;
    const { start_date, end_date, limit = 50, offset = 0 } = req.query;

    try {
        let query = `
            SELECT 
                id,
                event_type,
                lat,
                lng,
                created_at
            FROM geofence_logs
            WHERE stylist_id = $1 AND tenant_id = $2
        `;
        const params = [stylistId, tenant_id];
        let paramIndex = 3;

        if (start_date) {
            query += ` AND DATE(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota') >= $${paramIndex}`;
            params.push(start_date);
            paramIndex++;
        }

        if (end_date) {
            query += ` AND DATE(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota') <= $${paramIndex}`;
            params.push(end_date);
            paramIndex++;
        }

        query += ` ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(parseInt(limit), parseInt(offset));

        const result = await db.query(query, params);

        return res.status(200).json({
            logs: result.rows,
            total: result.rows.length
        });
    } catch (error) {
        // Si la tabla no existe, retornar array vacío
        if (error.message && error.message.includes('does not exist')) {
            return res.status(200).json({
                logs: [],
                total: 0,
                message: 'Tabla de logs de geocerca no configurada aún'
            });
        }
        console.error('Error getting geofence logs:', error);
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
};

/* ============================================================
   9) Get Tenant Geofence Configuration
   GET /api/stylists/geofence-config
   Retorna la configuración de geocerca del tenant (centro y radio)
   NOTA: Por ahora retorna valores por defecto. 
   En el futuro, esto debería almacenarse en la tabla tenants
============================================================ */
exports.getGeofenceConfig = async (req, res) => {
    const { tenant_id } = req.user;

    try {
        // Por ahora, retornamos valores por defecto
        // TODO: Agregar campos geofence_center_lat, geofence_center_lng, geofence_radius a la tabla tenants
        const result = await db.query(
            `SELECT 
                id,
                name,
                address
            FROM tenants
            WHERE id = $1`,
            [tenant_id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Tenant no encontrado' });
        }

        // Valores por defecto (Bogotá - Cedritos)
        // TODO: Cuando se agreguen los campos a la BD, usar esos valores
        const defaultConfig = {
            center: {
                lat: 4.726518,
                lng: -74.034619
            },
            radius: 200 // metros
        };

        return res.status(200).json({
            tenant_id: tenant_id,
            tenant_name: result.rows[0].name,
            geofence: {
                center: defaultConfig.center,
                radius: defaultConfig.radius,
                radius_km: (defaultConfig.radius / 1000).toFixed(2)
            },
            note: 'Estos son valores por defecto. La configuración real debe almacenarse en la tabla tenants.'
        });
    } catch (error) {
        console.error('Error getting geofence config:', error);
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
};

/* ============================================================
   10) Get All Stylists with Location Tracking (Para Dashboard Web)
   GET /api/stylists/tracking
   Retorna todos los estilistas del tenant con su ubicación actual
============================================================ */
exports.getStylistsTracking = async (req, res) => {
    const { tenant_id } = req.user;

    try {
        // Verificar qué columnas existen
        const checkColumns = await db.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'users' 
            AND column_name IN ('is_inside_geofence', 'current_lat', 'current_lng', 'last_location_update')
        `);
        
        const existingColumns = checkColumns.rows.map(r => r.column_name);
        const hasGeofenceColumns = existingColumns.includes('is_inside_geofence');
        const hasLocationColumns = existingColumns.includes('current_lat') && existingColumns.includes('current_lng');
        const hasLastUpdate = existingColumns.includes('last_location_update');

        // Construir SELECT dinámicamente
        let selectFields = [
            'u.id',
            'u.first_name',
            'u.last_name',
            'u.status'
        ];

        if (hasLocationColumns) {
            selectFields.push('u.current_lat', 'u.current_lng');
        } else {
            selectFields.push('NULL as current_lat', 'NULL as current_lng');
        }

        if (hasGeofenceColumns) {
            selectFields.push('u.is_inside_geofence');
        } else {
            selectFields.push('false as is_inside_geofence');
        }

        if (hasLastUpdate) {
            selectFields.push('u.last_location_update');
        } else {
            selectFields.push('NULL as last_location_update');
        }

        // Agregar subconsultas para geofence_logs (si la tabla existe)
        selectFields.push(`(
            SELECT event_type 
            FROM geofence_logs 
            WHERE stylist_id = u.id 
            ORDER BY created_at DESC 
            LIMIT 1
        ) as last_geofence_event`);
        selectFields.push(`(
            SELECT created_at 
            FROM geofence_logs 
            WHERE stylist_id = u.id 
            ORDER BY created_at DESC 
            LIMIT 1
        ) as last_geofence_event_time`);

        let orderBy = 'u.first_name ASC';
        if (hasGeofenceColumns) {
            orderBy = `CASE WHEN u.is_inside_geofence = true THEN 0 ELSE 1 END, ${orderBy}`;
        }

        const result = await db.query(
            `SELECT ${selectFields.join(', ')}
            FROM users u
            WHERE u.tenant_id = $1 
              AND u.role_id = 3
              AND u.status = 'active'
            ORDER BY ${orderBy}`,
            [tenant_id]
        );

        const stylists = result.rows.map(row => ({
            id: row.id,
            name: `${row.first_name} ${row.last_name || ''}`.trim(),
            lat: row.current_lat ? parseFloat(row.current_lat) : null,
            lng: row.current_lng ? parseFloat(row.current_lng) : null,
            status: row.is_inside_geofence ? 'connected' : 'disconnected',
            is_inside_geofence: row.is_inside_geofence || false,
            last_location_update: row.last_location_update,
            last_geofence_event: row.last_geofence_event,
            last_geofence_event_time: row.last_geofence_event_time,
            has_location: row.current_lat !== null && row.current_lng !== null
        }));

        return res.status(200).json({
            stylists: stylists,
            total: stylists.length,
            connected: stylists.filter(s => s.status === 'connected').length,
            disconnected: stylists.filter(s => s.status === 'disconnected').length
        });
    } catch (error) {
        console.error('Error getting stylists tracking:', error);
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
};

/* ============================================================
   11) Get Queue Position (Fichero Digital)
   GET /api/stylists/queue-position
   Retorna la posición del estilista en la fila virtual de citas pendientes
============================================================ */
exports.getQueuePosition = async (req, res) => {
    const { id: stylistId, tenant_id } = req.user;

    try {
        // Obtener todas las citas pendientes ordenadas por fecha/hora
        const queueQuery = `
            SELECT 
                a.id,
                a.stylist_id,
                a.start_time,
                ROW_NUMBER() OVER (ORDER BY a.start_time ASC) as position
            FROM appointments a
            WHERE a.tenant_id = $1
                AND a.status = 'pending_approval'
                AND a.start_time >= NOW() AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota'
            ORDER BY a.start_time ASC
        `;
        
        const queueResult = await db.query(queueQuery, [tenant_id]);
        
        // Encontrar la posición del estilista actual
        let position = null;
        let isNext = false;
        let totalInQueue = queueResult.rows.length;
        
        for (let i = 0; i < queueResult.rows.length; i++) {
            if (queueResult.rows[i].stylist_id === stylistId) {
                position = i + 1;
                isNext = (i === 0); // Es el próximo si está en la primera posición
                break;
            }
        }

        // Si no tiene citas pendientes, verificar si tiene citas programadas (scheduled)
        if (position === null) {
            const scheduledQuery = `
                SELECT COUNT(*) as count
                FROM appointments
                WHERE stylist_id = $1
                    AND tenant_id = $2
                    AND status = 'scheduled'
                    AND start_time >= NOW() AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota'
            `;
            const scheduledRes = await db.query(scheduledQuery, [stylistId, tenant_id]);
            const hasScheduled = parseInt(scheduledRes.rows[0].count || 0, 10) > 0;
            
            return res.status(200).json({
                has_pending: false,
                position: null,
                is_next: false,
                total_in_queue: totalInQueue,
                has_scheduled: hasScheduled,
                message: hasScheduled 
                    ? 'No tienes citas pendientes de aprobación' 
                    : 'No tienes citas en el fichero digital'
            });
        }

        return res.status(200).json({
            has_pending: true,
            position: position,
            is_next: isNext,
            total_in_queue: totalInQueue,
            message: isNext 
                ? 'Eres el próximo en el fichero digital' 
                : `Estás en la posición ${position} del fichero digital`
        });

    } catch (error) {
        console.error('Error getting queue position:', error);
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
};

/* ============================================================
   12) Get Smart Queue (Fichero Inteligente)
   GET /api/stylists/smart-queue
   Retorna información del fichero inteligente: posición del estilista, cola por servicio, siguiente estilista disponible
============================================================ */
exports.getSmartQueue = async (req, res) => {
    const { id: stylistId, tenant_id } = req.user;

    try {
        // 1. Obtener posición en cola de citas pendientes
        const queueQuery = `
            SELECT 
                a.id,
                a.stylist_id,
                a.start_time,
                ROW_NUMBER() OVER (ORDER BY a.start_time ASC) as position
            FROM appointments a
            WHERE a.tenant_id = $1
                AND a.status = 'pending_approval'
                AND a.start_time >= NOW() AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota'
            ORDER BY a.start_time ASC
        `;
        
        const queueResult = await db.query(queueQuery, [tenant_id]);
        
        let position = null;
        let isNext = false;
        let totalInQueue = queueResult.rows.length;
        
        for (let i = 0; i < queueResult.rows.length; i++) {
            if (queueResult.rows[i].stylist_id === stylistId) {
                position = i + 1;
                isNext = (i === 0);
                break;
            }
        }

        // 2. Obtener información del estilista actual (last_turn_at, last_service_at)
        const stylistInfo = await db.query(
            `SELECT 
                id,
                first_name,
                last_name,
                last_turn_at,
                last_service_at
            FROM users
            WHERE id = $1 AND tenant_id = $2`,
            [stylistId, tenant_id]
        );

        const currentStylist = stylistInfo.rows[0] || null;

        // 3. Obtener siguiente estilista disponible (global)
        const nextAvailable = await db.query(
            `SELECT id, first_name, last_name, last_turn_at, last_service_at
             FROM users
             WHERE tenant_id = $1
               AND role_id = 3
               AND status = 'active'
             ORDER BY COALESCE(last_turn_at, last_service_at) ASC NULLS FIRST
             LIMIT 1`,
            [tenant_id]
        );

        // 4. Obtener cola por servicio (digiturno)
        const servicesResult = await db.query(
            `SELECT id, name FROM services WHERE tenant_id = $1 ORDER BY name`,
            [tenant_id]
        );

        const queueByService = [];

        for (const service of servicesResult.rows) {
            const stylistsResult = await db.query(
                `SELECT 
                  u.id as stylist_id,
                  u.first_name,
                  u.last_name,
                  ss.last_completed_at,
                  ss.total_completed,
                  ROW_NUMBER() OVER (
                    ORDER BY 
                      ss.last_completed_at NULLS FIRST,
                      ss.total_completed ASC,
                      u.created_at ASC
                  ) as queue_position
                FROM users u
                INNER JOIN stylist_services ss ON u.id = ss.user_id
                WHERE u.tenant_id = $1
                  AND u.role_id = 3
                  AND COALESCE(NULLIF(u.status,''),'active') = 'active'
                  AND ss.service_id = $2
                ORDER BY 
                  ss.last_completed_at NULLS FIRST,
                  ss.total_completed ASC,
                  u.created_at ASC`,
                [tenant_id, service.id]
            );

            // Encontrar posición del estilista actual en este servicio
            let myPosition = null;
            for (let i = 0; i < stylistsResult.rows.length; i++) {
                if (stylistsResult.rows[i].stylist_id === stylistId) {
                    myPosition = i + 1;
                    break;
                }
            }

            queueByService.push({
                service_id: service.id,
                service_name: service.name,
                my_position: myPosition,
                total_stylists: stylistsResult.rows.length,
                queue: stylistsResult.rows.map((row, idx) => ({
                    stylist_id: row.stylist_id,
                    stylist_name: `${row.first_name} ${row.last_name || ''}`.trim(),
                    position: idx + 1,
                    is_me: row.stylist_id === stylistId,
                    last_completed_at: row.last_completed_at,
                    total_completed: row.total_completed || 0
                }))
            });
        }

        return res.status(200).json({
            stylist: currentStylist ? {
                id: currentStylist.id,
                name: `${currentStylist.first_name} ${currentStylist.last_name || ''}`.trim(),
                last_turn_at: currentStylist.last_turn_at,
                last_service_at: currentStylist.last_service_at
            } : null,
            pending_appointments: {
                has_pending: position !== null,
                position: position,
                is_next: isNext,
                total_in_queue: totalInQueue,
                message: isNext 
                    ? 'Eres el próximo en el fichero digital' 
                    : position !== null 
                        ? `Estás en la posición ${position} del fichero digital`
                        : 'No tienes citas pendientes de aprobación'
            },
            next_available_stylist: nextAvailable.rows.length > 0 ? {
                id: nextAvailable.rows[0].id,
                name: `${nextAvailable.rows[0].first_name} ${nextAvailable.rows[0].last_name || ''}`.trim(),
                is_me: nextAvailable.rows[0].id === stylistId
            } : null,
            queue_by_service: queueByService
        });

    } catch (error) {
        console.error('Error getting smart queue:', error);
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
};

/* ============================================================
   Alias para compatibilidad: updateLocation usa updateLocationWithTracking
============================================================ */
exports.updateLocation = exports.updateLocationWithTracking;