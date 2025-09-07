// Contenido COMPLETO y CORREGIDO para: src/routes/userRoutes.js

const express = require('express');
const router = express.Router();

const userController = require('../controllers/userController');
const authMiddleware = require('../middleware/authMiddleware');

// =========================================================
// Rutas ESPECÍFICAS (van primero para evitar colisiones)
// =========================================================

// ----> RUTA NUEVA AÑADIDA AQUÍ <----
// GET /api/users/tenant/:tenantId/clients - Para la lista del CRM
router.get('/tenant/:tenantId/clients', authMiddleware, userController.getTenantClientsWithRecentServices);

// GET /api/users/by-phone/:phoneNumber - Para que el bot identifique clientes
router.get('/by-phone/:phoneNumber', authMiddleware, userController.getUserByPhone);

// GET /api/users/stylists/next - Siguiente estilista disponible (turnero + horario)
router.get('/stylists/next', authMiddleware, userController.getNextAvailableStylist);

// =========================================================
/** CRUD de Usuarios */
// =========================================================

// POST /api/users - Crear un nuevo usuario (público para clientes, o por un admin)
router.post('/', userController.createUser);

// GET /api/users/tenant/:tenantId - Obtener todos los usuarios de un tenant (filtro opcional ?role_id=3)
router.get('/tenant/:tenantId', authMiddleware, userController.getAllUsersByTenant);

// =========================================================
/** Operaciones sobre un usuario específico (deben ir al final) */
// =========================================================

// GET /api/users/:id - Obtener un usuario por su ID
router.get('/:id', authMiddleware, userController.getUserById);

// PUT /api/users/:id - Actualizar un usuario por su ID (incluye working_hours si lo envías)
router.put('/:id', authMiddleware, userController.updateUser);

// DELETE /api/users/:id - Eliminar un usuario por su ID
router.delete('/:id', authMiddleware, userController.deleteUser);

// =========================================================
/** Working Hours individuales del usuario (horario propio del estilista) */
// =========================================================
// GET /api/users/:id/working-hours - Traer el JSON de horario del usuario (o null si hereda del tenant)
router.get('/:id/working-hours', authMiddleware, userController.getUserWorkingHours);

// PUT /api/users/:id/working-hours - Actualizar el JSON de horario del usuario (enviar { week: {...} } o null)
router.put('/:id/working-hours', authMiddleware, userController.updateUserWorkingHours);

module.exports = router;