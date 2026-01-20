// src/routes/whatsappBookingRoutes.js
'use strict';

const express = require('express');
const router = express.Router();
const whatsappBookingController = require('../controllers/Whatsappbookingcontroller');

console.log('📍 [ROUTES] whatsappBookingRoutes.js cargado');

/**
 * Paso 1: Buscar servicio y obtener estilistas que lo ofrecen
 * POST /api/whatsapp-booking/search-service
 * Body: { tenantId, service }
 */
router.post('/search-service', whatsappBookingController.searchService);

/**
 * Paso 2: Verificar disponibilidad de horarios
 * POST /api/whatsapp-booking/check-availability
 * Body: { tenantId, serviceId, stylistId (opcional), date, time (opcional) }
 */
router.post('/check-availability', whatsappBookingController.checkAvailability);

/**
 * Paso 3: Agendar cita
 * POST /api/whatsapp-booking/book
 * Body: { tenantId, clientId, serviceId, stylistId, date, time }
 */
router.post('/book', whatsappBookingController.bookAppointment);

module.exports = router;