// Archivo: src/routes/paymentRoutes.js

const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');
const authMiddleware = require('../middleware/authMiddleware');

// Usamos el middleware de autenticación para proteger TODAS las rutas de pagos.
router.use(authMiddleware);

// --- Rutas de Pagos y Facturación ---

// RUTA PRINCIPAL PARA CREAR UNA FACTURA Y SUS PAGOS
// Ahora apunta a nuestra nueva función que maneja servicios, productos y múltiples métodos de pago.
// POST /api/payments
router.post('/', paymentController.createInvoiceAndPayments);

// RUTA LEGACY para obtener pagos antiguos. La mantenemos para no romper nada,
// pero en el futuro crearemos una nueva ruta para obtener facturas.
// GET /api/payments/tenant/:tenantId
router.get('/tenant/:tenantId', paymentController.getPaymentsByTenant);

module.exports = router;