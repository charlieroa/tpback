// src/controllers/payrollController.js
const db = require('../config/db');

exports.createPayroll = async (req, res) => {
    // El body de la petición ahora es más simple
    const { tenant_id, stylist_id, start_date, end_date } = req.body;

    if (!tenant_id || !stylist_id || !start_date || !end_date) {
        return res.status(400).json({ error: 'Faltan campos obligatorios: tenant_id, stylist_id, start_date, end_date.' });
    }

    try {
        // --- Paso 1: Obtener la configuración de pago del estilista desde la tabla 'users' ---
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

        // --- Paso 2: Aplicar la lógica de pago según el tipo ---
        if (stylist.payment_type === 'salary') {
            // Modelo de Salario Fijo: Simplemente tomamos el salario base del perfil del usuario.
            calculated_base_salary = parseFloat(stylist.base_salary);

        } else if (stylist.payment_type === 'commission') {
            // Modelo de Comisión: Calculamos la comisión basada en los servicios completados.
            const servicesData = await db.query(
                `SELECT SUM(s.price) as total_services_value
                 FROM appointments a
                 JOIN services s ON a.service_id = s.id
                 WHERE a.stylist_id = $1
                   AND a.status = 'completed'
                   AND a.start_time BETWEEN $2 AND $3`,
                [stylist_id, start_date, end_date]
            );

            const totalServicesValue = servicesData.rows[0].total_services_value;
            if (totalServicesValue) {
                calculated_commissions = parseFloat(totalServicesValue) * parseFloat(stylist.commission_rate);
            }

        } else {
            // Si el estilista no tiene un método de pago, no podemos calcular.
            return res.status(400).json({ error: 'El estilista no tiene un método de pago configurado (salary/commission).' });
        }

        const total_paid = calculated_base_salary + calculated_commissions;

        // --- Paso 3: Guardar el registro de nómina con los valores calculados ---
        const payrollResult = await db.query(
            `INSERT INTO payroll (tenant_id, stylist_id, start_date, end_date, base_salary, commissions, total_paid, payment_date)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW()) RETURNING *`,
            [tenant_id, stylist_id, start_date, end_date, calculated_base_salary.toFixed(2), calculated_commissions.toFixed(2), total_paid.toFixed(2)]
        );

        res.status(201).json(payrollResult.rows[0]);

    } catch (error) {
        console.error('Error al crear la nómina:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// La función para obtener las nóminas no necesita cambios.
exports.getPayrollsByTenant = async (req, res) => {
    const { tenantId } = req.params;
    try {
        const result = await db.query('SELECT p.*, u.first_name, u.last_name FROM payroll p JOIN users u ON p.stylist_id = u.id WHERE p.tenant_id = $1 ORDER BY p.payment_date DESC', [tenantId]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error al obtener nóminas:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};