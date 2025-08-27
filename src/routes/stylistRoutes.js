// src/routes/stylistRoutes.js
const express = require('express');
const router = express.Router();

const authMiddleware = require('../middleware/authMiddleware');
const stylistController = require('../controllers/stylistController');

/**
 * IMPORTANTE: el orden de rutas específicas va antes
 * de las rutas con parámetros para evitar colisiones.
 */

// EXISTENTES
router.get('/next-available', authMiddleware, stylistController.getNextAvailable);
router.get('/suggest-by-turn', authMiddleware, stylistController.suggestStylistByTurn);

// NUEVAS: servicios por estilista
router.get('/:id/services', authMiddleware, stylistController.getStylistServices);
router.post('/:id/services', authMiddleware, stylistController.setStylistServices);

module.exports = router;
