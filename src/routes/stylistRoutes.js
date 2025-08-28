// src/routes/stylistRoutes.js
const express = require('express');
const router = express.Router();

const authMiddleware = require('../middleware/authMiddleware');
const stylistController = require('../controllers/stylistController');

/**
 * IMPORTANTE: las rutas más específicas primero.
 */

// EXISTENTES
router.get('/next-available', authMiddleware, stylistController.getNextAvailable);
router.get('/suggest-by-turn', authMiddleware, stylistController.suggestStylistByTurn);

// NUEVA: lista general para el tenant actual (soluciona GET /api/stylists del front)
router.get('/', authMiddleware, (req, res, next) => {
  // Reutilizamos listStylistsByTenant del controller
  // inyectándole el tenantId esperado desde el token del usuario.
  req.params.tenantId = req.user.tenant_id;
  return stylistController.listStylistsByTenant(req, res, next);
});

// NUEVAS: servicios por estilista
router.get('/:id/services', authMiddleware, stylistController.getStylistServices);
router.post('/:id/services', authMiddleware, stylistController.setStylistServices);

module.exports = router;
