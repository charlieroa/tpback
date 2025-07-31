// Contenido para: src/routes/appointmentRoutes.js
const express = require('express');
const router = express.Router();
const appointmentController = require('../controllers/appointmentController');
const authMiddleware = require('../middleware/authMiddleware');

router.get('/availability', authMiddleware, appointmentController.getAvailability);
router.patch('/:id/checkin', authMiddleware, appointmentController.handleCheckIn);
router.patch('/:id/checkout', authMiddleware, appointmentController.handleCheckout);
router.post('/', authMiddleware, appointmentController.createAppointment);
router.get('/tenant/:tenantId', authMiddleware, appointmentController.getAppointmentsByTenant);
router.patch('/:id/status', authMiddleware, appointmentController.updateAppointmentStatus);
router.delete('/:id', authMiddleware, appointmentController.deleteAppointment);

module.exports = router;