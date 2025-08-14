// Contenido para: src/routes/stylistRoutes.js

const express = require('express');
const router = express.Router();
const stylistController = require('../controllers/stylistController');
const authMiddleware = require('../middleware/authMiddleware'); // Asegúrate que la ruta a tu middleware sea correcta

// GET /api/stylists/next-available - (Se mantiene) Obtiene el siguiente estilista en la cola general.
router.get('/next-available', authMiddleware, stylistController.getNextAvailable);

// ✅ NUEVA RUTA AÑADIDA
// GET /api/stylists/suggest-by-turn - El corazón del turnero inteligente.
// Sugiere un estilista basado en el turno Y su disponibilidad para una fecha, hora y servicio específicos.
router.get('/suggest-by-turn', authMiddleware, stylistController.suggestStylistByTurn);


// Aquí podríamos añadir más rutas en el futuro, como para cambiar el estado de un estilista (activo/en descanso)
// router.patch('/:id/status', authMiddleware, stylistController.updateStatus);

module.exports = router;