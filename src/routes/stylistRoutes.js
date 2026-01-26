// src/routes/stylistRoutes.js
const express = require('express');
const router = express.Router();

const authMiddleware = require('../middleware/authMiddleware');
const stylistController = require('../controllers/stylistController');
const stylistAppController = require('../controllers/stylistAppController'); // ✅ Nuevo controlador para la App
// Importamos el userController para reutilizar su handler searchStylists
const userController = require('../controllers/userController');

/**
 * IMPORTANTE: las rutas más específicas primero para evitar colisiones con `/:id`
 */

// 🔎 Público: buscar estilistas por nombre dentro de un tenant
// GET /api/stylists/tenant/:tenantId/search?query=carlos
router.get('/tenant/:tenantId/search', userController.searchStylists);

// ⏭️ Existentes (con auth)
router.get('/next-available', authMiddleware, stylistController.getNextAvailable);
router.get('/suggest-by-turn', authMiddleware, stylistController.suggestStylistByTurn);

// 📋 Lista general para el tenant del usuario autenticado
// GET /api/stylists
router.get('/', authMiddleware, (req, res, next) => {
  // Inyectamos tenantId desde el token del usuario
  req.params.tenantId = req.user.tenant_id;
  return stylistController.listStylistsByTenant(req, res, next);
});

// 📊 App Móvil: Dashboard & Ubicación
router.get('/stats', authMiddleware, stylistAppController.getDashboardStats);
router.post('/location', authMiddleware, stylistAppController.updateLocation);

// 📅 App Móvil: Bookings (Aceptar/Rechazar)
router.get('/bookings/pending', authMiddleware, stylistAppController.getPendingBookings);
router.get('/bookings/all', authMiddleware, stylistAppController.getAllBookings);
router.post('/bookings/:bookingId/approve', authMiddleware, stylistAppController.approveBooking);
router.post('/bookings/:bookingId/reject', authMiddleware, stylistAppController.rejectBooking);

// 📋 App Móvil: Historial de Servicios
router.get('/services/attended', authMiddleware, stylistAppController.getServicesAttended);

// 💰 App Móvil: Ventas de Productos
router.get('/products/sales', authMiddleware, stylistAppController.getProductSales);

// 📍 App Móvil: Geolocalización y Tracking
router.get('/geofence-config', authMiddleware, stylistAppController.getGeofenceConfig);
router.get('/geofence-logs', authMiddleware, stylistAppController.getGeofenceLogs);
router.get('/tracking', authMiddleware, stylistAppController.getStylistsTracking);

// 📋 App Móvil: Fichero Digital (Posición en cola)
router.get('/queue-position', authMiddleware, stylistAppController.getQueuePosition);
router.get('/smart-queue', authMiddleware, stylistAppController.getSmartQueue);

// 💇‍♀️ Servicios por estilista (después de las rutas específicas)
router.get('/:id/services', authMiddleware, stylistController.getStylistServices);
router.post('/:id/services', authMiddleware, stylistController.setStylistServices);

module.exports = router;
