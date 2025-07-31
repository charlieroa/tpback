// Contenido completo para: src/routes/userRoutes.js
const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const authMiddleware = require('../middleware/authMiddleware'); // Asumimos que también quieres proteger estas rutas

// --- NUEVA RUTA DEL TURNERO ---
// Se coloca aquí para que no entre en conflicto con la ruta /:id
router.get('/next-available', authMiddleware, userController.getNextAvailableStylist);
// --- FIN DE LA NUEVA RUTA ---

// Rutas existentes del CRUD de Usuarios
router.post('/', authMiddleware, userController.createUser);
router.get('/tenant/:tenantId', authMiddleware, userController.getAllUsersByTenant);
router.get('/:id', authMiddleware, userController.getUserById);
router.put('/:id', authMiddleware, userController.updateUser);
router.delete('/:id', authMiddleware, userController.deleteUser);

module.exports = router;