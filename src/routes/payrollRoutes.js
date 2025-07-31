// src/routes/payrollRoutes.js
const express = require('express');
const router = express.Router();
const payrollController = require('../controllers/payrollController');

// POST /api/payroll - Generar un pago de nómina
router.post('/', payrollController.createPayroll);

// GET /api/payroll/tenant/:tenantId - Obtener todos los registros de nómina
router.get('/tenant/:tenantId', payrollController.getPayrollsByTenant);

module.exports = router;