const db = require('../config/db');
const bcrypt = require('bcryptjs');

// Crear un nuevo Usuario
exports.createUser = async (req, res) => {
    const { tenant_id, role_id, first_name, last_name, email, password, phone, payment_type, base_salary, commission_rate } = req.body;

    if (!tenant_id || !role_id || !first_name || !email || !password) {
        return res.status(400).json({ error: 'Faltan campos obligatorios.' });
    }

    try {
        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(password, salt);

        const result = await db.query(
            `INSERT INTO users (tenant_id, role_id, first_name, last_name, email, password_hash, phone, payment_type, base_salary, commission_rate)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING id, tenant_id, role_id, email, first_name, last_name, payment_type`,
            [tenant_id, role_id, first_name, last_name, email, password_hash, phone, payment_type, base_salary, commission_rate]
        );

        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Error al crear usuario:', error);
        if (error.code === '23505') {
            return res.status(409).json({ error: 'El correo electrónico ya está registrado.' });
        }
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// Obtener todos los Usuarios (de un tenant específico) - ¡CON FILTRO POR ROL!
exports.getAllUsersByTenant = async (req, res) => {
    const { tenantId } = req.params;
    const { role_id } = req.query; // Leemos el 'role_id' de los parámetros de la URL

    let baseQuery = 'SELECT id, role_id, first_name, last_name, email, phone, created_at, status, last_service_at, payment_type, base_salary, commission_rate FROM users WHERE tenant_id = $1';
    const queryParams = [tenantId];

    // Si se proporciona un 'role_id' en la URL, lo añadimos como filtro a la consulta
    if (role_id) {
        baseQuery += ' AND role_id = $2';
        // ✅ Convertimos el role_id de texto a número. ¡Esta es la corrección!
        queryParams.push(parseInt(role_id, 10));
    }
    
    baseQuery += ' ORDER BY first_name';

    try {
        const result = await db.query(baseQuery, queryParams);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error al obtener usuarios:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// Obtener un Usuario por su ID
exports.getUserById = async (req, res) => {
    const { id } = req.params;
    try {
        const result = await db.query(
            'SELECT id, tenant_id, role_id, first_name, last_name, email, phone, created_at, payment_type, base_salary, commission_rate, status, last_service_at FROM users WHERE id = $1',
            [id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Usuario no encontrado' });
        }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error al obtener usuario por ID:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// Actualizar un Usuario
exports.updateUser = async (req, res) => {
    const { id } = req.params;
    const { first_name, last_name, phone, role_id, payment_type, base_salary, commission_rate, status } = req.body;
    try {
        const result = await db.query(
            `UPDATE users SET
                first_name = $1, last_name = $2, phone = $3, role_id = $4,
                payment_type = $5, base_salary = $6, commission_rate = $7, status = $8, updated_at = NOW()
             WHERE id = $9
             RETURNING id, tenant_id, role_id, first_name, last_name, email, phone, payment_type, base_salary, commission_rate, status`,
            [first_name, last_name, phone, role_id, payment_type, base_salary, commission_rate, status, id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Usuario no encontrado para actualizar' });
        }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error al actualizar usuario:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// Eliminar un Usuario
exports.deleteUser = async (req, res) => {
    const { id } = req.params;
    try {
        const result = await db.query('DELETE FROM users WHERE id = $1', [id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Usuario no encontrado para eliminar' });
        }
        res.status(204).send();
    } catch (error) {
        console.error('Error al eliminar usuario:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

exports.getNextAvailableStylist = async (req, res) => {
    // Asumimos que tu authMiddleware añade los datos del usuario (incluyendo tenant_id) a req.user
    const { tenant_id } = req.user; 

    if (!tenant_id) {
        return res.status(400).json({ error: 'No se pudo identificar el tenant del usuario.' });
    }

    const query = `
        SELECT id, first_name, last_name, last_service_at
        FROM users
        WHERE tenant_id = $1
          AND role_id = 3           -- Solo estilistas
          AND status = 'active'     -- Solo los que están trabajando
        ORDER BY last_service_at ASC NULLS FIRST
        LIMIT 1;
    `;
    
    try {
        const result = await db.query(query, [tenant_id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'No hay estilistas disponibles en este momento.' });
        }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error al obtener el siguiente estilista disponible:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

exports.getUserByPhone = async (req, res) => {
    const { phoneNumber } = req.params;
    // El tenant_id lo podemos obtener del token del usuario que hace la búsqueda (el bot)
    const { tenant_id } = req.user;

    // Podríamos quitar el prefijo del país si siempre es el mismo,
    // pero por ahora lo buscamos tal cual.
    if (!phoneNumber) {
        return res.status(400).json({ error: "Número de teléfono no proporcionado." });
    }

    try {
        const result = await db.query(
            // Buscamos un usuario que coincida con el teléfono Y que pertenezca al mismo tenant
            'SELECT id, tenant_id, role_id, first_name, last_name, email FROM users WHERE phone = $1 AND tenant_id = $2',
            [phoneNumber, tenant_id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Usuario no encontrado con ese número de teléfono.' });
        }

        // Devolvemos el primer usuario encontrado
        res.status(200).json(result.rows[0]);

    } catch (error) {
        console.error('Error al buscar usuario por teléfono:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};