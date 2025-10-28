// src/routes/userRoutes.js
const express = require('express');
const router = express.Router();

const userController = require('../controllers/userController');
const authMiddleware = require('../middleware/authMiddleware');

/* =========================================================
   RUTAS PÚBLICAS (deben ir PRIMERO)
   IMPORTANTE: poner antes de cualquier "/:id" o similares
========================================================= */

// ✅ Búsqueda pública de estilistas
// GET /api/users/:tenantId/stylists/search?query=carlos
router.get('/tenant/:tenantId/stylists/search', userController.searchStylists);

// WhatsApp público
router.get('/whatsapp/client/:phoneNumber', userController.getClientByPhonePublic);
router.post('/whatsapp/register', userController.registerClientFromWhatsApp);

/* =========================================================
   RUTAS ESPECÍFICAS (con auth cuando aplique)
========================================================= */

// Lista de clientes del tenant (para CRM)
router.get('/tenant/:tenantId/clients', authMiddleware, userController.getTenantClientsWithRecentServices);

// Buscar usuario por teléfono (mismo tenant)
router.get('/by-phone/:phoneNumber', authMiddleware, userController.getUserByPhone);

// Siguiente estilista disponible
router.get('/stylists/next', authMiddleware, userController.getNextAvailableStylist);

/* =========================================================
   CRUD DE USUARIOS
========================================================= */

// Crear usuario (público)
router.post('/', userController.createUser);

// Obtener todos los usuarios por tenant (opcional ?role_id=3)
router.get('/tenant/:tenantId', authMiddleware, userController.getAllUsersByTenant);

/* =========================================================
   OPERACIONES SOBRE UN USUARIO ESPECÍFICO (al final)
========================================================= */

// Obtener por ID
router.get('/:id', authMiddleware, userController.getUserById);

// Actualizar por ID
router.put('/:id', authMiddleware, userController.updateUser);

// Eliminar por ID
router.delete('/:id', authMiddleware, userController.deleteUser);

/* =========================================================
   WORKING HOURS del usuario
========================================================= */

router.get('/:id/working-hours', authMiddleware, userController.getUserWorkingHours);
router.put('/:id/working-hours', authMiddleware, userController.updateUserWorkingHours);

module.exports = router;
