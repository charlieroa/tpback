// Contenido COMPLETO y FINAL para: src/controllers/authController.js

const db = require('../config/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const slugify = require('slugify');

// --- Función para Iniciar Sesión ---
exports.login = async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Por favor, ingrese email y contraseña.' });
    }

    try {
        const userResult = await db.query('SELECT * FROM users WHERE email = $1', [email]);
        if (userResult.rows.length === 0) {
            return res.status(401).json({ error: 'Credenciales inválidas.' });
        }

        const user = userResult.rows[0];

        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            return res.status(401).json({ error: 'Credenciales inválidas.' });
        }

        // --- CORRECCIÓN CLAVE ---
        // El payload DEBE tener una clave 'user' que contenga los datos,
        // porque así lo espera nuestro authMiddleware.
        const payload = {
            user: {
                id: user.id,
                role_id: user.role_id,
                tenant_id: user.tenant_id
            }
        };
        // --- FIN DE LA CORRECCIÓN ---

        jwt.sign(
            payload,
            process.env.JWT_SECRET,
            { expiresIn: '8h' },
            (err, token) => {
                if (err) throw err;
                res.json({ token });
            }
        );

    } catch (error) {
        console.error('Error en el login:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};


// --- Función para Registrar Dueño y Peluquería ---
const createSlug = (text) => {
    return slugify(text, { lower: true, strict: true, remove: /[*+~.()'"!:@]/g });
};

exports.registerTenantAndAdmin = async (req, res) => {
    const { tenantName, adminFirstName, adminEmail, adminPassword } = req.body;

    if (!tenantName || !adminFirstName || !adminEmail || !adminPassword) {
        return res.status(400).json({ error: "Todos los campos son obligatorios." });
    }

    try {
        await db.query('BEGIN');

        const slug = createSlug(tenantName);
        const tenantResult = await db.query(
            'INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING id',
            [tenantName, slug]
        );
        const newTenantId = tenantResult.rows[0].id;

        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(adminPassword, salt);
        const adminResult = await db.query(
            `INSERT INTO users (tenant_id, role_id, first_name, last_name, email, password_hash)
             VALUES ($1, 1, $2, '(Admin)', $3, $4) RETURNING id, email`,
            [newTenantId, adminFirstName, adminEmail, password_hash]
        );
        
        await db.query('COMMIT');
        
        res.status(201).json(adminResult.rows[0]);

    } catch (error) {
        await db.query('ROLLBACK');
        console.error("Error en el registro de tenant y admin:", error);
        if (error.code === '23505') {
            return res.status(409).json({ error: 'Ya existe una peluquería o un usuario con ese nombre/email.' });
        }
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
};