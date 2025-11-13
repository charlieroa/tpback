// src/routes/appointmentRoutes.js

const express = require('express');
const router = express.Router();

const appointmentController = require('../controllers/appointmentController');
const authMiddleware = require('../middleware/authMiddleware');

// =====================================================================
// RUTAS PÚBLICAS (sin autenticación) - VAN PRIMERO
// =====================================================================

// ✅ NUEVOS ENDPOINTS PÚBLICOS PARA FLUJO CONVERSACIONAL
// 1) Buscar Estilista
router.get(
  '/stylists/search-public',
  appointmentController.searchStylistsPublic
);

// 2) Servicios del Estilista
router.get(
  '/stylists/:stylistId/services-public',
  appointmentController.getStylistServicesPublic
);

// 3) Buscar Servicio - YA EXISTE EN /api/services/search/:tenantId (serviceRoutes.js)

// 4) Verificar Disponibilidad
router.get(
  '/verify-public',
  appointmentController.verifyStylistServiceAndAvailabilityPublic
);

// =====================================================================
// EXISTENTES: AI Orchestrator Público
// =====================================================================

router.get('/ai/orchestrator', appointmentController.aiOrchestratorPublic);
router.post('/ai/orchestrator', appointmentController.aiOrchestratorPublic);

// Legacy (compat)
router.get('/ai/orchestrator-legacy', appointmentController.aiOrchestrator);
router.post('/ai/orchestrator-legacy', appointmentController.aiOrchestrator);

// Smart Availability (GET/POST)
router.get('/public/smart-availability', appointmentController.smartAvailabilityPublic);
router.post('/public/smart-availability', appointmentController.smartAvailabilityPublicJSON);

// Verificar disponibilidad (ruta legacy existente)
router.get('/public/verify', appointmentController.verifyStylistServiceAndAvailabilityPublic);
router.post('/public/verify', (req, res, next) => {
  req.query = { ...req.query, ...req.body };
  return appointmentController.verifyStylistServiceAndAvailabilityPublic(req, res, next);
});

// Check Availability por tenant
router.get('/:tenantId/check-availability', appointmentController.checkAvailability);

// Agendamiento conversacional
router.post('/agendar-cita', appointmentController.agendarCitaConversacional);

// Slots públicos por tenant
router.get('/public/tenant/:tenantId/slots', appointmentController.getTenantSlotsPublic);

// =====================================================================
// RUTAS CON AUTENTICACIÓN - Requieren token JWT válido
// =====================================================================

router.get('/tenant/slots', authMiddleware, appointmentController.getTenantSlots);

router.get('/stylists/available', authMiddleware, appointmentController.getAvailableStylistsByTime);

router.post('/validate', authMiddleware, appointmentController.validateAppointment);

router.get('/availability', authMiddleware, appointmentController.getAvailability);

router.post('/batch', authMiddleware, appointmentController.createAppointmentsBatch);

router.post('/schedule-with-fallback', authMiddleware, appointmentController.scheduleWithFallback);

router.post('/', authMiddleware, appointmentController.createAppointment);

router.get('/tenant/:tenantId', authMiddleware, appointmentController.getAppointmentsByTenant);

router.put('/:id', authMiddleware, appointmentController.updateAppointment);

router.patch('/:id/checkin', authMiddleware, appointmentController.handleCheckIn);

router.patch('/:id/checkout', authMiddleware, appointmentController.handleCheckout);

router.patch('/:id/status', authMiddleware, appointmentController.updateAppointmentStatus);

router.delete('/:id', authMiddleware, appointmentController.deleteAppointment);

module.exports = router;