// Contenido COMPLETO y CORREGIDO para: src/controllers/authController.js

const db = require('../config/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const slugify = require('slugify');

// --- Función para Iniciar Sesión (VERSIÓN MEJORADA Y COMPLETA) ---
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

        // --- INICIO DE LA LÓGICA DE VERIFICACIÓN AVANZADA ---
        let isSetupComplete = false;
        if (user.tenant_id) {
            // 1. Obtenemos los datos del Tenant (básicos y horarios)
            const tenantResult = await db.query(
                'SELECT name, address, phone, working_hours FROM tenants WHERE id = $1',
                [user.tenant_id]
            );
            
            // 2. Obtenemos el conteo de servicios y de personal (estilistas)
            const servicesCountResult = await db.query('SELECT COUNT(id) FROM services WHERE tenant_id = $1', [user.tenant_id]);
            const staffCountResult = await db.query("SELECT COUNT(id) FROM users WHERE tenant_id = $1 AND role_id = 3", [user.tenant_id]);

            if (tenantResult.rows.length > 0) {
                const tenant = tenantResult.rows[0];
                const servicesCount = parseInt(servicesCountResult.rows[0].count, 10);
                const staffCount = parseInt(staffCountResult.rows[0].count, 10);

                // Verificación de datos básicos (ignorando espacios en blanco)
                const hasBasicInfo = !!(tenant.name?.trim() && tenant.address?.trim() && tenant.phone?.trim());
                
                // Verificación de horarios (al menos un día debe estar activo y no ser 'cerrado')
                const hours = tenant.working_hours || {};
                const hasActiveHours = Object.values(hours).some(daySchedule => daySchedule !== 'cerrado');
                
                // Verificación de servicios
                const hasServices = servicesCount > 0;
                
                // Verificación de personal
                const hasStaff = staffCount > 0;
                
                // 3. La configuración solo está completa si los 4 checks son verdaderos
                if (hasBasicInfo && hasActiveHours && hasServices && hasStaff) {
                    isSetupComplete = true;
                }
            }
        }
        // --- FIN DE LA LÓGICA DE VERIFICACIÓN ---

        const payload = {
            user: {
                id: user.id,
                role_id: user.role_id,
                tenant_id: user.tenant_id
            }
        };

        jwt.sign(
            payload,
            process.env.JWT_SECRET,
            { expiresIn: '8h' },
            (err, token) => {
                if (err) throw err;

                const userForResponse = {
                    id: user.id,
                    first_name: user.first_name,
                    last_name: user.last_name,
                    email: user.email,
                    role_id: user.role_id,
                    tenant_id: user.tenant_id
                };

                res.json({
                    token,
                    user: userForResponse,
                    setup_complete: isSetupComplete
                });
            }
        );

    } catch (error) {
        console.error('Error en el login:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// --- Función para Registrar Dueño y Peluquería (SIN CAMBIOS) ---
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
            'INSERT INTO tenants (name, email, slug) VALUES ($1, $2, $3) RETURNING id',
            [tenantName, adminEmail, slug]
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