// src/routes/appointmentRoutes.js

const express = require('express');
const router = express.Router();

const appointmentController = require('../controllers/appointmentController');
const authMiddleware = require('../middleware/authMiddleware');

// ---------------------------------------------------
// Rutas PÚBLICAS (sin autenticación) - van primero
// ---------------------------------------------------

// ✅ Smart availability (servicio + estilista + sugerencias) — público (GET)
router.get(
  '/public/smart-availability',
  appointmentController.smartAvailabilityPublic
);

// ✅ Smart availability — público (POST espejo para n8n; usa body JSON)
router.post('/public/smart-availability', (req, res, next) => {
  req.query = { ...req.query, ...req.body };
  return appointmentController.smartAvailabilityPublic(req, res, next);
});

// ✅ Verificar (servicio + estilista + fecha/hora) con sugerencias — público (GET)
router.get(
  '/public/verify',
  appointmentController.verifyStylistServiceAndAvailabilityPublic
);

// ✅ Verificar (servicio + estilista + fecha/hora) — público (POST espejo para n8n)
router.post('/public/verify', (req, res, next) => {
  req.query = { ...req.query, ...req.body };
  return appointmentController.verifyStylistServiceAndAvailabilityPublic(req, res, next);
});

// ✅ Verificar disponibilidad para un servicio/fecha/hora (público, para AI Agent)
router.get(
  '/:tenantId/check-availability',
  appointmentController.checkAvailability
);

// ✅ Agendamiento conversacional desde n8n (sin autenticación)
router.post(
  '/agendar-cita',
  appointmentController.agendarCitaConversacional
);

// ✅ Slots del tenant públicos (sin autenticación)
router.get(
  '/public/tenant/:tenantId/slots',
  appointmentController.getTenantSlotsPublic
);

// ✅ AI Orchestrator (unificado GET/POST sin auth; versión "Public" con búsqueda difusa)
// ESTAS SON LAS LÍNEAS IMPORTANTES PARA TU HERRAMIENTA DE n8n:
router.get('/ai/orchestrator', appointmentController.aiOrchestratorPublic);
router.post('/ai/orchestrator', appointmentController.aiOrchestratorPublic); // <-- Usa POST /ai/orchestrator

// (Opcional) Orchestrator clásico en otro path para pruebas o compatibilidad
router.get('/ai/orchestrator-legacy', appointmentController.aiOrchestrator);
router.post('/ai/orchestrator-legacy', appointmentController.aiOrchestrator);

// ---------------------------------------------------
// Rutas con path fijo (con autenticación)
// ---------------------------------------------------

// 1) Horas/slots del tenant para la fecha (step = duración del servicio o ?interval=)
router.get(
  '/tenant/slots',
  authMiddleware,
  appointmentController.getTenantSlots
);

// 2) Estilistas disponibles por fecha, hora y servicio (ordenados por turnero global)
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

// 6) Agendar con fallback (si no se puede, devuelve sugerencias y/o estilistas alternos)
router.post(
  '/schedule-with-fallback',
  authMiddleware,
  appointmentController.scheduleWithFallback
);

// ---------------------------------------------------
// Rutas generales y con parámetros (con autenticación)
// ---------------------------------------------------

// 7) Crear una cita (usar ?dryRun=true para simular sin persistir ni tocar turnero)
router.post(
  '/',
  authMiddleware,
  appointmentController.createAppointment
);

// 8) Listar citas por tenant y rango de fechas
router.get(
  '/tenant/:tenantId',
  authMiddleware,
  appointmentController.getAppointmentsByTenant
);

// 9) Actualizar una cita (service_id, stylist_id, start_time, etc.)
router.put(
  '/:id',
  authMiddleware,
  appointmentController.updateAppointment
);

// 10) Check-in / Check-out
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

// 11) Actualizar solo el estado
router.patch(
  '/:id/status',
  authMiddleware,
  appointmentController.updateAppointmentStatus
);

// 12) Eliminar cita
router.delete(
  '/:id',
  authMiddleware,
  appointmentController.deleteAppointment
);

module.exports = router;