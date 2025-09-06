// =============================================
// File: src/routes/cashRoutes.js
// =============================================
const express = require('express');
const router = express.Router();

const cashController = require('../controllers/cashController');
const authMiddleware = require('../middleware/authMiddleware');
const { authorize } = require('../middleware/permissionsMiddleware');

// Aplicamos autenticación a todas las rutas de este archivo
router.use(authMiddleware);

// --- Rutas para GESTIÓN DE SESIONES de Caja ---
router.post('/open', authorize([2]), cashController.openCashSession);
router.post('/close', authorize([2]), cashController.closeCashSession);
router.get('/current', authorize([2]), cashController.getCurrentSession);
router.get('/history', authorize([]), cashController.getSessionHistory);

// --- Rutas para GESTIÓN DE MOVIMIENTOS de Caja (Anticipos, Facturas, etc.) ---
router.post('/movements', authorize([2]), cashController.createCashMovement);
router.get('/movements', authorize([2]), cashController.getCashMovements); // Asumiendo que tendrás una función para ver movimientos

module.exports = router;