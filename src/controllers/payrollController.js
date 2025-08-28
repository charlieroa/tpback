// src/controllers/payrollController.js
const db = require('../config/db');

exports.createPayroll = async (req, res) => {
    const { tenant_id, stylist_id, start_date, end_date } = req.body;

    if (!tenant_id || !stylist_id || !start_date || !end_date) {
        return res.status(400).json({ error: 'Faltan campos obligatorios: tenant_id, stylist_id, start_date, end_date.' });
    }

    try {
        // --- Paso 1: Configuración de pago del estilista ---
        const userResult = await db.query(
            'SELECT payment_type, base_salary, commission_rate FROM users WHERE id = $1',
            [stylist_id]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'Estilista no encontrado.' });
        }

        const stylist = userResult.rows[0];
        let calculated_base_salary = 0;
        let calculated_commissions = 0;

        // --- Paso 2: Cálculo de salario o comisión ---
        if (stylist.payment_type === 'salary') {
            calculated_base_salary = parseFloat(stylist.base_salary || 0);

        } else if (stylist.payment_type === 'commission') {
            const servicesData = await db.query(
                `SELECT SUM(s.price) as total_services_value
                 FROM appointments a
                 JOIN services s ON a.service_id = s.id
                 WHERE a.stylist_id = $1
                   AND a.tenant_id = $2
                   AND a.status = 'completed'
                   AND a.start_time BETWEEN $3 AND $4`,
                [stylist_id, tenant_id, start_date, end_date]
            );

            const totalServicesValue = parseFloat(servicesData.rows[0]?.total_services_value || 0);
            calculated_commissions = totalServicesValue * parseFloat(stylist.commission_rate || 0);
        } else {
            return res.status(400).json({ error: 'El estilista no tiene un método de pago configurado (salary/commission).' });
        }

        const gross_total = calculated_base_salary + calculated_commissions;

        // --- Paso 3: Consultar anticipos en cash_movements ---
        const advRes = await db.query(
            `SELECT COALESCE(SUM(amount),0) AS advances_sum
             FROM cash_movements
             WHERE tenant_id = $1
               AND type = 'payroll_advance'
               AND related_entity_type = 'stylist'
               AND related_entity_id = $2
               AND created_at BETWEEN $3 AND $4`,
            [tenant_id, stylist_id, start_date, end_date]
        );

        // Nota: en cash_movements los anticipos se guardan como monto negativo
        const advances_sum_raw = parseFloat(advRes.rows[0].advances_sum || 0);
        const advances_deducted = Math.abs(advances_sum_raw);

        const total_paid = gross_total;
        const net_paid = gross_total - advances_deducted;

        // --- Paso 4: Guardar registro en payroll (como hasta ahora) ---
        const payrollResult = await db.query(
            `INSERT INTO payroll (tenant_id, stylist_id, start_date, end_date, base_salary, commissions, total_paid, payment_date)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW()) RETURNING *`,
            [
                tenant_id,
                stylist_id,
                start_date,
                end_date,
                Number(calculated_base_salary).toFixed(2),
                Number(calculated_commissions).toFixed(2),
                Number(total_paid).toFixed(2)
            ]
        );

        // --- Paso 5: Devolver también el neto calculado ---
        res.status(201).json({
            ...payrollResult.rows[0],
            advances_deducted: Number(advances_deducted).toFixed(2),
            net_paid: Number(net_paid).toFixed(2)
        });

    } catch (error) {
        console.error('Error al crear la nómina:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

exports.getPayrollsByTenant = async (req, res) => {
    const { tenantId } = req.params;
    try {
        const result = await db.query(
            `SELECT p.*, u.first_name, u.last_name
             FROM payroll p
             JOIN users u ON p.stylist_id = u.id
             WHERE p.tenant_id = $1
             ORDER BY p.payment_date DESC`,
            [tenantId]
        );
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error al obtener nóminas:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};
