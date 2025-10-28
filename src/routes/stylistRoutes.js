// src/routes/stylistRoutes.js
const express = require('express');
const router = express.Router();

const authMiddleware = require('../middleware/authMiddleware');
const stylistController = require('../controllers/stylistController');
// Importamos el userController para reutilizar su handler searchStylists
const userController = require('../controllers/userController');

/**
 * IMPORTANTE: las rutas más específicas primero para evitar colisiones con `/:id`
 */

// 🔎 Público: buscar estilistas por nombre dentro de un tenant
// GET /api/stylists/tenant/:tenantId/search?query=carlos
router.get('/tenant/:tenantId/search', userController.searchStylists);

// ⏭️ Existentes (con auth)
router.get('/next-available', authMiddleware, stylistController.getNextAvailable);
router.get('/suggest-by-turn', authMiddleware, stylistController.suggestStylistByTurn);

// 📋 Lista general para el tenant del usuario autenticado
// GET /api/stylists
router.get('/', authMiddleware, (req, res, next) => {
  // Inyectamos tenantId desde el token del usuario
  req.params.tenantId = req.user.tenant_id;
  return stylistController.listStylistsByTenant(req, res, next);
});

// 💇‍♀️ Servicios por estilista (después de las rutas específicas)
router.get('/:id/services', authMiddleware, stylistController.getStylistServices);
router.post('/:id/services', authMiddleware, stylistController.setStylistServices);

module.exports = router;
