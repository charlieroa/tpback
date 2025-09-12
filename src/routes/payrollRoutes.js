const express = require('express');
const router = express.Router();
const payrollController = require('../controllers/payrollController');
const authMiddleware = require('../middleware/authMiddleware');

// Usamos el middleware para proteger TODAS las rutas de este archivo.
router.use(authMiddleware);

// --- RUTA FALTANTE Y MÁS IMPORTANTE ---
// GET /api/payrolls/detailed-preview -> Para la vista previa con todos los detalles.
// La usa la página PayrollPreview.tsx para llenar las pestañas.
router.get('/detailed-preview', payrollController.getPayrollDetailedPreview);


// --- OTRAS RUTAS ---

// GET /api/payrolls/preview -> Para obtener el resumen de nómina simple (reutilizado por la detallada).
router.get('/preview', payrollController.getPayrollPreview);

// POST /api/payrolls -> Generar y guardar un pago de nómina para un estilista.
router.post('/', payrollController.createPayroll);

// GET /api/payrolls -> Obtener todos los registros de nómina ya guardados para el historial.
router.get('/', payrollController.getPayrollsByTenant);

module.exports = router;