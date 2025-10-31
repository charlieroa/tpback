// src/routes/appointmentRoutes.js

const express = require('express');
const router = express.Router();

const appointmentController = require('../controllers/appointmentController');
const authMiddleware = require('../middleware/authMiddleware');

// =====================================================================
// RUTAS PÚBLICAS (sin autenticación) - VAN PRIMERO
// =====================================================================

// ✅ AI ORCHESTRATOR PÚBLICO - Principal endpoint para n8n/ChatGPT
// Maneja búsqueda difusa de servicios/estilistas, normalización de fechas/horas,
// desambiguación, validación, y agendamiento conversacional completo
router.get('/ai/orchestrator', appointmentController.aiOrchestratorPublic);
router.post('/ai/orchestrator', appointmentController.aiOrchestratorPublic);

// ✅ AI Orchestrator Legacy (opcional, para compatibilidad con implementaciones anteriores)
router.get('/ai/orchestrator-legacy', appointmentController.aiOrchestrator);
router.post('/ai/orchestrator-legacy', appointmentController.aiOrchestrator);

// ✅ Smart Availability - Consulta disponibilidad de estilista específico para un servicio
// Devuelve slots disponibles y sugerencias cercanas si no hay disponibilidad exacta
router.get(
  '/public/smart-availability',
  appointmentController.smartAvailabilityPublic
);

// ✅ Smart Availability (POST) - Espejo del GET para herramientas que prefieren POST
router.post(
  '/public/smart-availability',
  appointmentController.smartAvailabilityPublicJSON
);

// ✅ Verificar disponibilidad específica (servicio + estilista + fecha/hora exacta)
// Devuelve si está disponible + sugerencias alternativas + estilistas alternos
router.get(
  '/public/verify',
  appointmentController.verifyStylistServiceAndAvailabilityPublic
);

// ✅ Verificar (POST) - Espejo del GET
router.post('/public/verify', (req, res, next) => {
  req.query = { ...req.query, ...req.body };
  return appointmentController.verifyStylistServiceAndAvailabilityPublic(req, res, next);
});

// ✅ Check Availability - Busca estilistas disponibles para servicio/fecha/hora
// Útil para AI agents que necesitan encontrar cualquier estilista disponible
router.get(
  '/:tenantId/check-availability',
  appointmentController.checkAvailability
);

// ✅ Agendamiento conversacional desde n8n (endpoint simple para flujos de WhatsApp/etc)
router.post(
  '/agendar-cita',
  appointmentController.agendarCitaConversacional
);

// ✅ Slots del tenant (horarios disponibles del salón para una fecha)
router.get(
  '/public/tenant/:tenantId/slots',
  appointmentController.getTenantSlotsPublic
);

// =====================================================================
// RUTAS CON AUTENTICACIÓN - Requieren token JWT válido
// =====================================================================

// 1) Slots del tenant autenticados (usa tenant_id del token)
router.get(
  '/tenant/slots',
  authMiddleware,
  appointmentController.getTenantSlots
);

// 2) Estilistas disponibles por fecha, hora y servicio
// Ordenados por sistema de turnos (last_turn_at, last_service_at, last_completed_at)
router.get(
  '/stylists/available',
  authMiddleware,
  appointmentController.getAvailableStylistsByTime
);

// 3) Validar una cita sin crearla (dry run - no persiste en DB)
router.post(
  '/validate',
  authMiddleware,
  appointmentController.validateAppointment
);

// 4) Disponibilidad por estilista específico
// Intersección de horarios Tenant ∩ Estilista, filtrando citas existentes
router.get(
  '/availability',
  authMiddleware,
  appointmentController.getAvailability
);

// 5) Crear múltiples citas en una sola transacción (batch)
// Útil para servicios combinados o agendamientos masivos
router.post(
  '/batch',
  authMiddleware,
  appointmentController.createAppointmentsBatch
);

// 6) Agendar con fallback inteligente
// Si no se puede agendar, devuelve sugerencias de horarios y estilistas alternos
router.post(
  '/schedule-with-fallback',
  authMiddleware,
  appointmentController.scheduleWithFallback
);

// 7) Crear una cita individual
// Soporta ?dryRun=true para simular sin persistir (útil para validaciones previas)
router.post(
  '/',
  authMiddleware,
  appointmentController.createAppointment
);

// 8) Listar citas por tenant y rango de fechas
// Incluye joins con servicios, clientes y estilistas
router.get(
  '/tenant/:tenantId',
  authMiddleware,
  appointmentController.getAppointmentsByTenant
);

// 9) Actualizar una cita existente
// Permite cambiar service_id, stylist_id, start_time
// Valida que no haya conflictos con otras citas
router.put(
  '/:id',
  authMiddleware,
  appointmentController.updateAppointment
);

// 10) Check-in (marcar llegada del cliente)
// Cambia status de 'scheduled' → 'checked_in'
router.patch(
  '/:id/checkin',
  authMiddleware,
  appointmentController.handleCheckIn
);

// 11) Check-out (finalizar servicio)
// Cambia status de 'checked_in' → 'checked_out'
// Actualiza last_service_at del estilista y last_completed_at de stylist_services
router.patch(
  '/:id/checkout',
  authMiddleware,
  appointmentController.handleCheckout
);

// 12) Actualizar solo el estado de una cita
// Para cambios manuales de estado (ej: cancelar, reagendar, etc.)
router.patch(
  '/:id/status',
  authMiddleware,
  appointmentController.updateAppointmentStatus
);

// 13) Eliminar una cita permanentemente
router.delete(
  '/:id',
  authMiddleware,
  appointmentController.deleteAppointment
);

module.exports = router;
