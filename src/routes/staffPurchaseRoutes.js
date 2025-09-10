// =============================================
// File: src/routes/staffPurchaseRoutes.js
// (Versión completa para tu controlador)
// =============================================
const express = require('express');
const router = express.Router();
const staffPurchaseController = require('../controllers/staffPurchaseController');
const authMiddleware = require('../middleware/authMiddleware');

// Proteger todas las rutas del módulo
router.use(authMiddleware);

// POST   /api/staff-purchases -> Crear una nueva compra de personal
router.post('/', staffPurchaseController.createPurchase);

// GET    /api/staff-purchases/stylist/:stylistId -> Listar compras de un estilista
router.get('/stylist/:stylistId', staffPurchaseController.getPurchasesByStylist);

// GET    /api/staff-purchases/:purchaseId -> Ver el detalle de una compra
router.get('/:purchaseId', staffPurchaseController.getPurchaseWithItems);

// PATCH  /api/staff-purchases/:purchaseId/status -> Actualizar el estado de una compra
router.patch('/:purchaseId/status', staffPurchaseController.updatePurchaseStatus);

module.exports = router;