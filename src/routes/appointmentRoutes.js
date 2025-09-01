// src/routes/appointmentRoutes.js

const express = require('express');
const router = express.Router();

const appointmentController = require('../controllers/appointmentController');
const authMiddleware = require('../middleware/authMiddleware');

// ---------------------------------------------------
// Rutas con path fijo primero (no destructivas)
// ---------------------------------------------------

// 1) Horas/slots del tenant para la fecha (step = duración del servicio o ?interval=)
//    Responde con una lista de slots para poblar el selector de "hora" del modal
router.get(
  '/tenant/slots',
  authMiddleware,
  appointmentController.getTenantSlots
);

// 2) Estilistas disponibles por fecha, hora y servicio (ordenados por turnero global)
//    Ideal para el paso "hora" → "estilista" del modal
router.get(
  '/stylists/available',
  authMiddleware,
  appointmentController.getAvailableStylistsByTime
);

// 3) Validar una cita sin crearla (no toca caja ni DB)
router.post(
  '/validate',
  authMiddleware,
  appointmentController.validateAppointment
);

// 4) Disponibilidad por estilista (intersección Tenant ∩ Estilista)
//    Útil si necesitas ver slots específicos de un estilista concreto
router.get(
  '/availability',
  authMiddleware,
  appointmentController.getAvailability
);

// 5) Crear múltiples citas (batch) en transacción
router.post(
  '/batch',
  authMiddleware,
  appointmentController.createAppointmentsBatch
);

// ---------------------------------------------------
// Rutas generales y con parámetros
// ---------------------------------------------------

// 6) Crear una cita (usar ?dryRun=true para simular sin persistir ni tocar turnero)
router.post(
  '/',
  authMiddleware,
  appointmentController.createAppointment
);

// 7) Listar citas por tenant y rango de fechas
router.get(
  '/tenant/:tenantId',
  authMiddleware,
  appointmentController.getAppointmentsByTenant
);

// 8) Actualizar una cita (service_id, stylist_id, start_time, etc.)
router.put(
  '/:id',
  authMiddleware,
  appointmentController.updateAppointment
);

// 9) Check-in / Check-out
router.patch(
  '/:id/checkin',
  authMiddleware,
  appointmentController.handleCheckIn
);
router.patch(
  '/:id/checkout',
  authMiddleware,
  appointmentController.handleCheckout
);

// 10) Actualizar solo el estado
router.patch(
  '/:id/status',
  authMiddleware,
  appointmentController.updateAppointmentStatus
);

// 11) Eliminar cita
router.delete(
  '/:id',
  authMiddleware,
  appointmentController.deleteAppointment
);

module.exports = router;
