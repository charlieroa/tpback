const express = require('express');
const router = express.Router();
const staffPurchaseController = require('../controllers/staffPurchaseController');
const authMiddleware = require('../middleware/authMiddleware');

// Aplicamos el middleware de autenticación a todas las rutas de este archivo.
// Nadie que no haya iniciado sesión podrá acceder a estas funciones.
router.use(authMiddleware);


// --- Rutas para la Gestión de Compras del Personal ---

// CREAR una nueva compra de productos para un estilista
// POST /api/staff-purchases
router.post('/', staffPurchaseController.createPurchase);

// OBTENER todas las compras de un estilista específico
// GET /api/staff-purchases/stylist/:stylistId
router.get('/stylist/:stylistId', staffPurchaseController.getPurchasesByStylist);

// ACTUALIZAR el estado de una compra (ej. 'pendiente' -> 'deducido')
// PUT /api/staff-purchases/:purchaseId/status
router.put('/:purchaseId/status', staffPurchaseController.updatePurchaseStatus);


module.exports = router;