// src/routes/paymentRoutes.js
// Contenido EXACTO y FINAL para: src/routes/paymentRoutes.js

const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');
const authMiddleware = require('../middleware/authMiddleware');

// POST /api/payments - Registrar un nuevo pago
// Esta línea ASEGURA que 'authMiddleware' se ejecute ANTES que 'createPayment'
router.post('/', authMiddleware, paymentController.createPayment);

// GET /api/payments/tenant/:tenantId - Obtener todos los pagos de una peluquería
router.get('/tenant/:tenantId', authMiddleware, paymentController.getPaymentsByTenant);

module.exports = router;