// src/routes/payrollRoutes.js
const express = require('express');
const router = express.Router();
const payrollController = require('../controllers/payrollController');
const authMiddleware = require('../middleware/authMiddleware');

// Usamos el middleware para proteger TODAS las rutas de este archivo.
router.use(authMiddleware);

// --- RUTA NUEVA ---
// GET /api/payrolls/preview -> Para obtener el resumen de nómina sin guardarlo.
// Lo usa el botón "Cargar Resumen".
router.get('/preview', payrollController.getPayrollPreview);

// POST /api/payrolls -> Generar y guardar un pago de nómina para un estilista.
// Lo usa el botón "Generar Nómina".
router.post('/', payrollController.createPayroll);

// GET /api/payrolls -> Obtener todos los registros de nómina ya guardados.
// Lo usa la tabla de "Historial".
router.get('/', payrollController.getPayrollsByTenant);

module.exports = router;