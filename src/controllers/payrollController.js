// src/controllers/payrollController.js
const db = require('../config/db');

// --- FUNCIÓN AJUSTADA Y MEJORADA ---
exports.createPayroll = async (req, res) => {
    const { tenant_id } = req.user; 
    const { stylist_id, start_date, end_date } = req.body;

    if (!stylist_id || !start_date || !end_date) {
        return res.status(400).json({ error: 'Faltan campos obligatorios: stylist_id, start_date, end_date.' });
    }

    const client = await db.getClient(); // Usaremos un cliente para la transacción
    try {
        await client.query('BEGIN');

        // MEJORA 1: Verificar si la nómina ya existe para este período
        const existingPayroll = await client.query(
            `SELECT id FROM payroll WHERE tenant_id = $1 AND stylist_id = $2 AND start_date = $3 AND end_date = $4`,
            [tenant_id, stylist_id, start_date, end_date]
        );

        if (existingPayroll.rowCount > 0) {
            // Si ya existe, no hacemos nada y devolvemos un mensaje informativo.
            // Esto evita duplicados cuando se procesa en lote.
            await client.query('ROLLBACK'); // Anulamos la transacción iniciada
            return res.status(200).json({ message: `La nómina para el estilista ${stylist_id} en este período ya existe. Se omitió.` });
        }

        const userResult = await client.query(`SELECT payment_type, base_salary, commission_rate, first_name, last_name FROM users WHERE id = $1 AND tenant_id = $2`, [stylist_id, tenant_id]);
        if (userResult.rowCount === 0) { throw new Error('Estilista no encontrado en el tenant.'); }
        const stylist = userResult.rows[0];

        const tenantRes = await client.query(`SELECT admin_fee_enabled, admin_fee_rate FROM tenants WHERE id = $1`, [tenant_id]);
        const { admin_fee_enabled, admin_fee_rate } = tenantRes.rows[0] || {};
        
        // ... (Toda la lógica de cálculo se mantiene igual)
        const svcRes = await client.query(`WITH params AS (SELECT $1::uuid AS tenant_id, $2::timestamptz AS start_ts, $3::timestamptz AS end_ts) SELECT COALESCE(SUM(ii.commission_value), 0) AS service_commissions, COALESCE(SUM(ii.total_price), 0) AS service_sales_amount FROM invoice_items ii JOIN invoices inv ON inv.id = ii.invoice_id JOIN appointments ap ON ap.id = ii.related_id JOIN params p ON p.tenant_id = inv.tenant_id WHERE ii.item_type = 'service' AND inv.tenant_id = p.tenant_id AND ap.stylist_id = $4 AND inv.created_at >= p.start_ts AND inv.created_at < p.end_ts AND inv.status IN ('paid','closed','completed')`, [tenant_id, start_date, end_date, stylist_id]);
        const { service_commissions, service_sales_amount } = svcRes.rows[0];
        
        const prodRes = await client.query(`WITH params AS (SELECT $1::uuid AS tenant_id, $2::timestamptz AS start_ts, $3::timestamptz AS end_ts) SELECT COALESCE(SUM(ii.commission_value), 0) AS product_commissions FROM invoice_items ii JOIN invoices inv ON inv.id = ii.invoice_id JOIN params p ON p.tenant_id = inv.tenant_id WHERE ii.item_type = 'product' AND inv.tenant_id = p.tenant_id AND ii.seller_id = $4 AND inv.created_at >= p.start_ts AND inv.created_at < p.end_ts AND inv.status IN ('paid','closed','completed')`, [tenant_id, start_date, end_date, stylist_id]);
        const { product_commissions } = prodRes.rows[0];

        const calculated_base_salary = stylist.payment_type === 'salary' ? Number(stylist.base_salary || 0) : 0;
        
        const advRes = await client.query(`SELECT COALESCE(SUM(amount), 0) AS advances_sum FROM cash_movements WHERE tenant_id = $1 AND type = 'payroll_advance' AND related_entity_type = 'stylist' AND related_entity_id = $2 AND created_at >= $3::timestamptz AND created_at < $4::timestamptz`, [tenant_id, stylist_id, start_date, end_date]);
        const advances_deducted = Math.abs(Number(advRes.rows[0].advances_sum || 0));

        let admin_fee_value = 0;
        const salon_share_services = Math.max(0, Number(service_sales_amount) - Number(service_commissions));
        if (admin_fee_enabled && admin_fee_rate != null) {
            admin_fee_value = Math.round(salon_share_services * Number(admin_fee_rate) * 100) / 100;
        }

        const commissions_total = Number(service_commissions) + Number(product_commissions);
        const gross_total = calculated_base_salary + commissions_total;
        const net_paid = gross_total - advances_deducted - admin_fee_value;

        // MEJORA 2: Guardamos el % de comisión del estilista
        const payrollResult = await client.query(
            `INSERT INTO payroll (tenant_id, stylist_id, start_date, end_date, base_salary, commissions, total_paid, payment_date, commission_rate_snapshot)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8) RETURNING *;`,
            [tenant_id, stylist_id, start_date, end_date, calculated_base_salary, commissions_total, gross_total, stylist.commission_rate]
        );
        
        await client.query('COMMIT');
        return res.status(201).json({ ...payrollResult.rows[0] }); // Devolvemos solo el resultado del guardado

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error al crear la nómina:', error);
        return res.status(500).json({ error: error.message || 'Error interno del servidor' });
    } finally {
        client.release();
    }
};


// Actualizamos la función que lee el historial para que también traiga la nueva columna
exports.getPayrollsByTenant = async (req, res) => {
    const { tenant_id } = req.user; 
    try {
        const result = await db.query(
            `SELECT p.*, u.first_name, u.last_name 
             FROM payroll p
             JOIN users u ON p.stylist_id = u.id
             WHERE p.tenant_id = $1 ORDER BY p.payment_date DESC`,
            [tenant_id]
        );
        return res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error al obtener nóminas:', error);
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// La función de PREVIEW no necesita cambios, ya que no guarda nada.
exports.getPayrollPreview = async (req, res) => {
    // ... (este código se queda como estaba)
    const { tenant_id } = req.user;
    const { start_date, end_date } = req.query;

    if (!start_date || !end_date) { return res.status(400).json({ error: 'Se requieren start_date y end_date.' });}

    const client = await db.getClient();
    try {
        const stylistsRes = await client.query(`SELECT id, first_name, last_name, base_salary FROM users WHERE tenant_id = $1 AND role_id = 3 AND is_active = true`,[tenant_id]);
        const stylists = stylistsRes.rows;
        const previewResults = [];
        for (const stylist of stylists) {
            const commissionsRes = await client.query(`SELECT COALESCE(SUM(ii.commission_value) FILTER (WHERE ii.item_type = 'service' AND ap.stylist_id = $4), 0) AS service_commissions, COALESCE(SUM(ii.commission_value) FILTER (WHERE ii.item_type = 'product' AND ii.seller_id = $4), 0) AS product_commissions FROM invoice_items ii JOIN invoices inv ON inv.id = ii.invoice_id LEFT JOIN appointments ap ON ap.id = ii.related_id AND ii.item_type = 'service' WHERE inv.tenant_id = $1 AND inv.status IN ('paid','closed','completed') AND inv.created_at >= $2 AND inv.created_at < $3 AND (ap.stylist_id = $4 OR ii.seller_id = $4)`, [tenant_id, start_date, end_date, stylist.id]);
            const advancesRes = await client.query(`SELECT COALESCE(SUM(amount), 0) AS total FROM cash_movements WHERE type = 'payroll_advance' AND tenant_id = $1 AND related_entity_id = $2 AND created_at >= $3 AND created_at < $4`, [tenant_id, stylist.id, start_date, end_date]);
            
            const total_deductions = Math.abs(Number(advancesRes.rows[0].total));
            const { service_commissions, product_commissions } = commissionsRes.rows[0];
            const base_salary = Number(stylist.base_salary || 0);
            const gross_total = Number(service_commissions) + Number(product_commissions) + base_salary;
            const net_paid = gross_total - total_deductions;

            if (gross_total > 0) {
                previewResults.push({ stylist_id: stylist.id, stylist_name: `${stylist.first_name} ${stylist.last_name || ''}`.trim(), gross_total, total_deductions, net_paid, service_commissions, product_commissions, base_salary });
            }
        }
        res.status(200).json(previewResults);
    } catch (error) {
        console.error("Error al generar la vista previa de la nómina:", error);
        res.status(500).json({ error: 'Error interno del servidor' });
    } finally {
        client.release();
    }
};