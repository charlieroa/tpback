// src/routes/payrollRoutes.js
const express = require('express');
const router = express.Router();
const payrollController = require('../controllers/payrollController');
// Si usas middleware de autenticación, descomenta esta línea:
// const authMiddleware = require('../middleware/authMiddleware');

// POST /api/payroll - Generar un pago de nómina
// router.post('/', authMiddleware, payrollController.createPayroll);
router.post('/', payrollController.createPayroll);

// GET /api/payroll/tenant/:tenantId - Obtener todos los registros de nómina
// router.get('/tenant/:tenantId', authMiddleware, payrollController.getPayrollsByTenant);
router.get('/tenant/:tenantId', payrollController.getPayrollsByTenant);

module.exports = router;
