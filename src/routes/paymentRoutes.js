// src/routes/paymentRoutes.js
const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');

// POST /api/payments - Registrar un nuevo pago
router.post('/', paymentController.createPayment);

// GET /api/payments/tenant/:tenantId - Obtener todos los pagos de una peluquería
router.get('/tenant/:tenantId', paymentController.getPaymentsByTenant);

module.exports = router;