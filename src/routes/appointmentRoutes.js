// src/routes/appointmentRoutes.js

const express = require('express');
const router = express.Router();

const appointmentController = require('../controllers/appointmentController');
const authMiddleware = require('../middleware/authMiddleware');

// ---------------------------------------------------
// Rutas con path fijo primero
// ---------------------------------------------------

// Disponibilidad (acepta opcionalmente service_id o duration_minutes)
router.get('/availability', authMiddleware, appointmentController.getAvailability);

// Crear múltiples citas (batch)
router.post('/batch', authMiddleware, appointmentController.createAppointmentsBatch);

// ---------------------------------------------------
// Rutas generales y con parámetros
// ---------------------------------------------------

// Crear una cita
router.post('/', authMiddleware, appointmentController.createAppointment);

// Listar citas por tenant y rango de fechas
router.get('/tenant/:tenantId', authMiddleware, appointmentController.getAppointmentsByTenant);

// **Actualizar una cita completa (service_id, stylist_id, start_time, etc.)**
// Asegúrate de tener appointmentController.updateAppointment implementado.
router.put('/:id', authMiddleware, appointmentController.updateAppointment);

// Check-in / Check-out
router.patch('/:id/checkin', authMiddleware, appointmentController.handleCheckIn);
router.patch('/:id/checkout', authMiddleware, appointmentController.handleCheckout);

// Actualizar solo el estado
router.patch('/:id/status', authMiddleware, appointmentController.updateAppointmentStatus);

// Eliminar cita
router.delete('/:id', authMiddleware, appointmentController.deleteAppointment);

module.exports = router;
