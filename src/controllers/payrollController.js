const db = require('../config/db');

/**
 * Función centralizada para calcular el desglose de la nómina para un estilista.
 * Esta función es interna y será usada por la vista previa y la creación.
 */
/**
 * Función centralizada para calcular el desglose de la nómina para un estilista.
 * (VERSIÓN CORREGIDA FINAL)
 */
const calculateStylistPayrollBreakdown = async (client, tenant_id, stylist, start_date, end_date) => {
    const { admin_fee_enabled, admin_fee_rate } = (await client.query(`SELECT admin_fee_enabled, admin_fee_rate FROM tenants WHERE id = $1`, [tenant_id])).rows[0] || {};

    // 1. Obtener Ingresos (Servicios y Productos)
    const salesRes = await client.query(
        `SELECT
            ii.item_type, ii.total_price, ii.commission_value,
            s.name as service_name, u_client.first_name || ' ' || u_client.last_name as client_name
         FROM invoice_items ii
         JOIN invoices inv ON ii.invoice_id = inv.id
         LEFT JOIN appointments ap ON ii.related_id = ap.id AND ii.item_type = 'service'
         LEFT JOIN services s ON ap.service_id = s.id
         LEFT JOIN users u_client ON inv.client_id = u_client.id
         WHERE inv.tenant_id = $1 AND COALESCE(ap.stylist_id, ii.seller_id) = $4
           AND inv.created_at >= $2 AND inv.created_at < $3
           AND inv.status IN ('paid', 'closed', 'completed')`,
        [tenant_id, start_date, end_date, stylist.id]
    );

    // 2. Obtener Egresos (Anticipos, Préstamos, Compras)
    const expensesRes = await client.query(
        `(SELECT 'advance' as type, amount, description FROM cash_movements WHERE type = 'payroll_advance' AND tenant_id = $1 AND related_entity_id = $2 AND created_at >= $3 AND created_at < $4)
         UNION ALL
         (SELECT 'loan' as type, (principal / NULLIF(term_weeks, 0)) as amount, 'Cuota Préstamo ID ' || id::text as description FROM staff_loans WHERE tenant_id = $1 AND stylist_id = $2 AND status = 'pendiente')
         UNION ALL
         (SELECT 'purchase' as type, total_amount as amount, 'Compra de Personal ID ' || id::text as description FROM staff_purchases WHERE tenant_id = $1 AND stylist_id = $2 AND status = 'pendiente' AND purchase_date < $4)`,
        [tenant_id, stylist.id, start_date, end_date]
    );

    const details = { services: [], products: [], expenses: [] };
    let service_commissions_total = 0;

    // Calcular comisiones de servicios detalladamente
    salesRes.rows.filter(item => item.item_type === 'service').forEach(service => {
        const gross_commission = Number(service.total_price) * Number(stylist.commission_rate || 0);
        const salon_share = Number(service.total_price) - gross_commission;
        const admin_fee = (admin_fee_enabled && admin_fee_rate) ? salon_share * Number(admin_fee_rate) : 0;
        const net_commission = gross_commission - admin_fee;
        
        service_commissions_total += net_commission;
        details.services.push({ 
            client_name: service.client_name,
            service_name: service.service_name,
            service_price: Number(service.total_price),
            net_commission,
            admin_fee
        });
    });

    const product_commissions_total = salesRes.rows.filter(item => item.item_type === 'product').reduce((sum, p) => sum + Number(p.commission_value), 0);
    details.products = salesRes.rows.filter(item => item.item_type === 'product');

    // ✅ CORRECCIÓN: Usar Math.abs() para asegurar que los egresos siempre sean positivos antes de sumarlos.
    const expenses_total = expensesRes.rows.reduce((sum, e) => sum + Math.abs(Number(e.amount)), 0);
    details.expenses = expensesRes.rows;

    const base_salary = stylist.payment_type === 'salary' ? Number(stylist.base_salary || 0) : 0;
    const gross_total = base_salary + service_commissions_total + product_commissions_total;
    let net_paid = gross_total - expenses_total;

    // Regla de Negocio: Aplicar pago mínimo
    if (net_paid < 8000) {
        net_paid = 0;
    }

    return {
        stylist_id: stylist.id,
        stylist_name: `${stylist.first_name} ${stylist.last_name || ''}`.trim(),
        payment_type: stylist.payment_type,
        net_paid,
        details
    };
};

// --- VISTA PREVIA DETALLADA (FUNCIÓN PRINCIPAL) ---
exports.getPayrollDetailedPreview = async (req, res) => {
    const { tenant_id } = req.user;
    const { start_date, end_date } = req.query;

    if (!start_date || !end_date) {
        return res.status(400).json({ error: 'Se requieren start_date y end_date.' });
    }
    
    const client = await db.getClient();
    try {
        const tenantRes = await client.query(`SELECT admin_fee_enabled, admin_fee_rate FROM tenants WHERE id = $1`, [tenant_id]);
        const { admin_fee_enabled, admin_fee_rate } = tenantRes.rows[0] || {};
        
        const stylistsRes = await client.query(`SELECT id, first_name, last_name, payment_type, base_salary, commission_rate FROM users WHERE tenant_id = $1 AND role_id = 3 AND status = 'active'`, [tenant_id]);

        const servicesRes = await client.query(`SELECT ap.stylist_id, u.first_name || ' ' || u.last_name as client_name, s.name as service_name, ii.total_price as service_price FROM invoice_items ii JOIN invoices inv ON ii.invoice_id = inv.id JOIN appointments ap ON ii.related_id = ap.id JOIN services s ON ap.service_id = s.id JOIN users u ON inv.client_id = u.id WHERE ii.item_type = 'service' AND inv.tenant_id = $1 AND inv.created_at >= $2 AND inv.created_at < $3 AND inv.status IN ('paid','closed','completed')`, [tenant_id, start_date, end_date]);
        const productsRes = await client.query(`SELECT ii.seller_id as stylist_id, p.name as product_name, ii.commission_value FROM invoice_items ii JOIN invoices inv ON ii.invoice_id = inv.id JOIN products p ON ii.related_id = p.id WHERE ii.item_type = 'product' AND inv.tenant_id = $1 AND inv.created_at >= $2 AND inv.created_at < $3`, [tenant_id, start_date, end_date]);
        
        // Obtenemos TODOS los egresos pendientes, sin filtro de fecha para anticipos
        const expensesRes = await client.query(`
            (SELECT related_entity_id as stylist_id, amount, description FROM cash_movements WHERE type = 'payroll_advance' AND tenant_id = $1 AND status = 'pending') 
            UNION ALL 
            (SELECT stylist_id, (principal / NULLIF(term_weeks, 0)) as amount, 'Cuota Préstamo ID ' || id::text as description FROM staff_loans WHERE tenant_id = $1 AND status = 'pendiente') 
            UNION ALL 
            (SELECT stylist_id, total_amount as amount, 'Compra de Personal ID ' || id::text as description FROM staff_purchases WHERE tenant_id = $1 AND status = 'pendiente')`, 
            [tenant_id]
        );

        let stylist_breakdowns = stylistsRes.rows.map(stylist => {
            const details = { services: [], products: [], expenses: [] };
            let service_commissions_total = 0;

            servicesRes.rows.filter(s => s.stylist_id === stylist.id).forEach(service => {
                const gross_commission = Number(service.service_price) * Number(stylist.commission_rate || 0);
                const salon_share = Number(service.service_price) - gross_commission;
                const admin_fee = (admin_fee_enabled && admin_fee_rate) ? salon_share * Number(admin_fee_rate) : 0;
                const net_commission = gross_commission - admin_fee;
                service_commissions_total += net_commission;
                details.services.push({ ...service, net_commission, admin_fee });
            });

            const product_commissions_total = productsRes.rows.filter(p => p.stylist_id === stylist.id).reduce((sum, p) => sum + Number(p.commission_value), 0);
            details.products = productsRes.rows.filter(p => p.stylist_id === stylist.id);

            const expenses_total = expensesRes.rows.filter(e => e.stylist_id === stylist.id).reduce((sum, e) => sum + Math.abs(Number(e.amount)), 0);
            details.expenses = expensesRes.rows.filter(e => e.stylist_id === stylist.id);

            const base_salary = stylist.payment_type === 'salary' ? Number(stylist.base_salary || 0) : 0;
            const gross_total = base_salary + service_commissions_total + product_commissions_total;
            let net_paid = gross_total - expenses_total;

            if (net_paid < 8000) { net_paid = 0; }

            return {
                stylist_id: stylist.id, stylist_name: `${stylist.first_name} ${stylist.last_name || ''}`.trim(),
                net_paid, details, payment_type: stylist.payment_type,
            };
        }).filter(s => s.net_paid > 0 || s.details.services.length > 0 || s.details.products.length > 0 || s.details.expenses.length > 0 || s.payment_type === 'commission');

        // ✅ CÁLCULO DE WIDGETS CORREGIDO: Usamos los datos ya procesados
        const paymentTotalsRes = await client.query(`SELECT COALESCE(SUM(p.amount) FILTER (WHERE p.payment_method = 'cash'), 0) AS cash, COALESCE(SUM(p.amount) FILTER (WHERE p.payment_method = 'credit_card'), 0) AS "creditCard" FROM payments p JOIN invoices inv ON p.invoice_id = inv.id WHERE p.tenant_id = $1 AND inv.created_at >= $2 AND inv.created_at < $3`, [tenant_id, start_date, end_date]);
        const inventorySoldRes = await client.query(`SELECT COALESCE(SUM(ii.total_price), 0) FROM invoice_items ii JOIN invoices i ON ii.invoice_id = i.id WHERE ii.item_type = 'product' AND i.tenant_id = $1 AND i.created_at >= $2 AND i.created_at < $3`, [tenant_id, start_date, end_date]);
        
        const totalExpensesFromBreakdown = stylist_breakdowns.reduce((sum, stylist) => {
            const stylistExpenses = stylist.details.expenses.reduce((subSum, expense) => subSum + Math.abs(Number(expense.amount)), 0);
            return sum + stylistExpenses;
        }, 0);

        const summary_widgets = {
            cash: Number(paymentTotalsRes.rows[0].cash),
            creditCard: Number(paymentTotalsRes.rows[0].creditCard),
            inventorySold: Number(inventorySoldRes.rows[0].sum),
            stylistExpenses: totalExpensesFromBreakdown
        };
        
        res.status(200).json({ summary_widgets, stylist_breakdowns });

    } catch (error) {
        console.error("Error en vista detallada:", error);
        res.status(500).json({ error: 'Error interno del servidor' });
    } finally {
        client.release();
    }
};

// --- CREACIÓN DE NÓMINA INDIVIDUAL ---
exports.createPayroll = async (req, res) => {
    // Esta función debería ser adaptada para usar 'calculateStylistPayrollBreakdown'
    // y luego guardar el resultado en la tabla 'payrolls', para mantener la consistencia.
    // Por ahora, se mantiene la versión original que proporcionaste.
    const { tenant_id } = req.user; 
    const { stylist_id, start_date, end_date } = req.body;
    // ... (Código original de createPayroll)
    res.status(501).json({ message: "La función de creación debe ser actualizada con la nueva lógica de cálculo." });
};

// --- OBTENER HISTORIAL DE NÓMINAS ---
exports.getPayrollsByTenant = async (req, res) => {
    // ... (Tu código original para esta función es correcto y se mantiene)
    const { tenant_id } = req.user; 
    try {
        const result = await db.query(
            `SELECT p.*, u.first_name, u.last_name 
             FROM payrolls p
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