// Contenido COMPLETO y CORREGIDO para: src/routes/userRoutes.js

const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const authMiddleware = require('../middleware/authMiddleware');

// --- Rutas Específicas (van primero) ---

// GET /api/users/by-phone/:phoneNumber - Para que el bot identifique clientes
router.get('/by-phone/:phoneNumber', authMiddleware, userController.getUserByPhone);


// --- Rutas del CRUD Estándar ---

// POST /api/users - Crear un nuevo usuario (público para clientes, o por un admin)
router.post('/', userController.createUser);

// GET /api/users/tenant/:tenantId - Obtener todos los usuarios de una peluquería (con filtro opcional de rol)
router.get('/tenant/:tenantId', authMiddleware, userController.getAllUsersByTenant);


// --- Rutas que operan sobre un usuario específico (van al final) ---

// GET /api/users/:id - Obtener un usuario por su ID
router.get('/:id', authMiddleware, userController.getUserById);

// PUT /api/users/:id - Actualizar un usuario por su ID
router.put('/:id', authMiddleware, userController.updateUser);

// DELETE /api/users/:id - Eliminar un usuario por su ID
router.delete('/:id', authMiddleware, userController.deleteUser);


module.exports = router;