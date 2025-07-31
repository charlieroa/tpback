// src/controllers/tenantController.js
const db = require('../config/db');
const slugify = require('slugify'); // <-- IMPORTANTE: Necesitamos esta librería

// Pequeña función de ayuda para crear el 'slug' de forma consistente
const createSlug = (text) => {
    return slugify(text, {
        lower: true,      // todo en minúsculas
        strict: true,     // elimina caracteres no permitidos
        remove: /[*+~.()'"!:@]/g
    });
};

// --- Funciones del Controlador ---

// Crear un nuevo Tenant (Peluquería)
exports.createTenant = async (req, res) => {
    const { name, address, phone, working_hours } = req.body;
    
    // CAMBIO: Generamos el slug a partir del nombre
    const slug = createSlug(name);

    try {
        // CAMBIO: Añadimos el campo 'slug' a la consulta SQL
        const result = await db.query(
            'INSERT INTO tenants (name, address, phone, working_hours, slug) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [name, address, phone, working_hours, slug]
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Error al crear tenant:', error);
        // CAMBIO: Mejoramos el error para avisar si el nombre/slug ya existe
        if (error.code === '23505') {
            return res.status(409).json({ error: 'Ya existe una peluquería con un nombre similar.' });
        }
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// Obtener todos los Tenants O buscar uno por su 'slug'
exports.getAllTenants = async (req, res) => {
    // CAMBIO: Revisamos si nos envían un 'slug' en la URL (ej: /api/tenants?slug=peluqueria-glamour)
    const { slug } = req.query;

    // Si nos pasan un 'slug', buscamos y devolvemos solo ese
    if (slug) {
        try {
            const result = await db.query('SELECT * FROM tenants WHERE slug = $1', [slug]);
            if (result.rows.length === 0) {
                return res.status(404).json({ message: 'Peluquería no encontrada con ese slug.' });
            }
            return res.status(200).json(result.rows[0]); // Devolvemos solo un objeto
        } catch (error) {
            console.error('Error al obtener tenant por slug:', error);
            return res.status(500).json({ error: 'Error interno del servidor' });
        }
    }

    // Si no nos pasan un 'slug', devolvemos la lista completa como antes
    try {
        const result = await db.query('SELECT * FROM tenants ORDER BY created_at DESC');
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error al obtener tenants:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// Obtener un Tenant por su ID (sin cambios)
exports.getTenantById = async (req, res) => {
    const { id } = req.params;
    try {
        const result = await db.query('SELECT * FROM tenants WHERE id = $1', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Tenant no encontrado' });
        }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error al obtener tenant por ID:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// Actualizar un Tenant
exports.updateTenant = async (req, res) => {
    const { id } = req.params;
    const { name, address, phone, working_hours } = req.body;

    // CAMBIO: Volvemos a generar el slug por si el nombre cambia
    const slug = createSlug(name);

    try {
        // CAMBIO: Añadimos la actualización del campo 'slug' en la consulta
        const result = await db.query(
            'UPDATE tenants SET name = $1, address = $2, phone = $3, working_hours = $4, slug = $5, updated_at = NOW() WHERE id = $6 RETURNING *',
            [name, address, phone, working_hours, slug, id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Tenant no encontrado para actualizar' });
        }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error al actualizar tenant:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// Eliminar un Tenant (sin cambios)
exports.deleteTenant = async (req, res) => {
    const { id } = req.params;
    try {
        const result = await db.query('DELETE FROM tenants WHERE id = $1 RETURNING *', [id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Tenant no encontrado para eliminar' });
        }
        res.status(204).send();
    } catch (error) {
        console.error('Error al eliminar tenant:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};