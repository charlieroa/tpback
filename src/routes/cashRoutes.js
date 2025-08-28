// =============================================
// File: src/routes/cashRoutes.js
// =============================================
const express = require('express');
const router = express.Router();
const cashController = require('../controllers/cashController'); // ojo: C mayúscula
const authMiddleware = require('../middleware/authMiddleware');

// Todas las rutas de caja requieren autenticación
router.use(authMiddleware);

// Crear un nuevo movimiento de caja
// POST /api/cash-movements
router.post('/', cashController.createCashMovement);

// Obtener la lista de movimientos de caja (con filtros opcionales)
// GET /api/cash-movements?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
router.get('/', cashController.getCashMovements);

module.exports = router;
