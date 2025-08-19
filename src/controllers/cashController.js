// Contenido para: src/controllers/cashController.js

const db = require('../config/db');

/**
 * Crea un nuevo movimiento de caja (adelanto, gasto, ingreso).
 */
exports.createCashMovement = async (req, res) => {
    // Datos que vienen del frontend
    const { type, description, amount, related_user_id = null } = req.body;
    
    // Datos que vienen del token del usuario que realiza la acción
    const { tenant_id, id: user_id } = req.user;

    // --- Validaciones ---
    if (!type || !description || !amount) {
        return res.status(400).json({ error: 'Los campos type, description y amount son obligatorios.' });
    }

    let numericAmount = Number(amount);
    if (isNaN(numericAmount)) {
        return res.status(400).json({ error: 'El monto (amount) debe ser un número.' });
    }

    // Regla de negocio: los adelantos y gastos deben ser negativos
    if ((type === 'payroll_advance' || type === 'expense') && numericAmount > 0) {
        // Si el usuario envía un número positivo, lo convertimos a negativo.
        numericAmount = -Math.abs(numericAmount);
    }
    
    // Regla de negocio: los adelantos deben estar asociados a un empleado
    if (type === 'payroll_advance' && !related_user_id) {
        return res.status(400).json({ error: 'Un adelanto de nómina debe estar asociado a un empleado (related_user_id).' });
    }

    // --- Inserción en la Base de Datos ---
    try {
        const query = `
            INSERT INTO cash_movements (tenant_id, user_id, related_user_id, type, description, amount)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
        `;
        const result = await db.query(query, [tenant_id, user_id, related_user_id, type, description, numericAmount]);

        res.status(201).json(result.rows[0]);

    } catch (error) {
        console.error('Error al crear el movimiento de caja:', error);
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
};


/**
 * Obtiene los movimientos de caja de un tenant, con opción de filtrar por fecha.
 */
exports.getCashMovements = async (req, res) => {
    // El tenant_id lo obtenemos del token del usuario logueado
    const { tenant_id } = req.user;
    
    // Filtros opcionales desde la URL (ej: ?startDate=2025-10-01&endDate=2025-10-31)
    const { startDate, endDate } = req.query;

    try {
        let query = `
            SELECT 
                cm.id, 
                cm.type, 
                cm.description, 
                cm.amount, 
                cm.created_at,
                u.first_name as registered_by,
                ru.first_name as related_to
            FROM cash_movements cm
            LEFT JOIN users u ON cm.user_id = u.id
            LEFT JOIN users ru ON cm.related_user_id = ru.id
            WHERE cm.tenant_id = $1
        `;
        const queryParams = [tenant_id];

        if (startDate && endDate) {
            query += ' AND cm.created_at BETWEEN $2 AND $3';
            queryParams.push(startDate, endDate);
        }
        
        query += ' ORDER BY cm.created_at DESC';

        const result = await db.query(query, queryParams);
        res.status(200).json(result.rows);

    } catch (error) {
        console.error('Error al obtener movimientos de caja:', error);
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
};
