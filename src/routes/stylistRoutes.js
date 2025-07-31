// Contenido para el NUEVO archivo: src/routes/stylistRoutes.js

const express = require('express');
const router = express.Router();
const stylistController = require('../controllers/stylistController');
const authMiddleware = require('../middleware/authMiddleware');

// GET /api/stylists/next-available - Obtiene el siguiente estilista en la cola
router.get('/next-available', authMiddleware, stylistController.getNextAvailable);

// Aquí podríamos añadir más rutas en el futuro, como para cambiar el estado de un estilista (activo/en descanso)
// router.patch('/:id/status', authMiddleware, stylistController.updateStatus);

module.exports = router;