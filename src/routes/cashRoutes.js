const express = require('express');
const router = express.Router();
const cashController = require('../controllers/cashcontroller');
const authMiddleware = require('../middleware/authMiddleware');

// Todas las rutas de caja requieren autenticación

// POST /api/cash-movements -> Crear un nuevo movimiento de caja
router.post('/', authMiddleware, cashController.createCashMovement);

// GET /api/cash-movements -> Obtener la lista de movimientos de caja
router.get('/', authMiddleware, cashController.getCashMovements);

module.exports = router;