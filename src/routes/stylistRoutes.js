// src/routes/stylistRoutes.js
const express = require('express');
const router = express.Router();

const authMiddleware = require('../middleware/authMiddleware');
const stylistController = require('../controllers/stylistController');

/**
 * GET /api/stylists/next-available
 * Siguiente estilista en la cola global (sin filtrar por servicio/horario)
 */
router.get('/next-available', authMiddleware, stylistController.getNextAvailable);

/**
 * GET /api/stylists/suggest-by-turn
 * Query: date=YYYY-MM-DD&start_time=HH:mm[:ss]&service_id=<id>
 * Sugiere estilista calificado y disponible y actualiza last_turn_at
 */
router.get('/suggest-by-turn', authMiddleware, stylistController.suggestStylistByTurn);

module.exports = router;
