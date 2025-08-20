// Contenido COMPLETO y FINAL para: src/routes/appointmentRoutes.js

const express = require('express');
const router = express.Router();
const appointmentController = require('../controllers/appointmentController');
const authMiddleware = require('../middleware/authMiddleware');

// --- Rutas Específicas ---
// Estas rutas tienen texto fijo, por lo que van antes de las que tienen parámetros como /:id

router.get('/availability', authMiddleware, appointmentController.getAvailability);

// ✅ NUEVA RUTA PARA AGENDAMIENTO MÚLTIPLE
router.post('/batch', authMiddleware, appointmentController.createAppointmentsBatch);


// --- Rutas Generales y con Parámetros ---

router.post('/', authMiddleware, appointmentController.createAppointment);

router.get('/tenant/:tenantId', authMiddleware, appointmentController.getAppointmentsByTenant);

router.patch('/:id/checkin', authMiddleware, appointmentController.handleCheckIn);

router.patch('/:id/checkout', authMiddleware, appointmentController.handleCheckout);

router.patch('/:id/status', authMiddleware, appointmentController.updateAppointmentStatus);

router.delete('/:id', authMiddleware, appointmentController.deleteAppointment);


module.exports = router;