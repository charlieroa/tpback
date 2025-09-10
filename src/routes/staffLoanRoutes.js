// =============================================
// File: src/routes/staffLoanRoutes.js (CORREGIDO)
// =============================================
const express = require('express');
const router = express.Router();
const staffLoanController = require('../controllers/staffLoanController');
const authMiddleware = require('../middleware/authMiddleware');

// Proteger todas las rutas de préstamos con autenticación
router.use(authMiddleware);

// --- Rutas CRUD para Préstamos a Staff ---

// POST /api/staff-loans -> Crear un nuevo préstamo
router.post('/', staffLoanController.createLoan);

// GET /api/staff-loans -> Listar todos los préstamos del tenant
router.get('/', staffLoanController.getLoansByTenant);

// GET /api/staff-loans/stylist/:stylistId -> Listar préstamos de un estilista específico
router.get('/stylist/:stylistId', staffLoanController.getLoansByStylist);

// GET /api/staff-loans/:loanId -> Obtener el detalle de un préstamo específico
router.get('/:loanId', staffLoanController.getLoanDetail);

// PATCH /api/staff-loans/:loanId/installments/:installmentNo -> Actualizar el estado de una cuota
// 👇 LA CORRECCIÓN ESTÁ AQUÍ 👇
router.patch('/:loanId/installments/:installmentNo', staffLoanController.updateInstallmentStatus);


module.exports = router;