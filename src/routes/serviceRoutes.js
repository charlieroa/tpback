// Contenido COMPLETO y FINAL para: src/routes/serviceRoutes.js

const express = require('express');
const router = express.Router();
const serviceController = require('../controllers/serviceController');
const authMiddleware = require('../middleware/authMiddleware'); // <-- 1. IMPORTAMOS EL MIDDLEWARE

// --- Rutas Generales (Protegidas) ---
router.post('/', authMiddleware, serviceController.createService);
router.get('/tenant/:tenantId', authMiddleware, serviceController.getServicesByTenant);

// --- Nueva Ruta Específica (Debe ir antes de /:id para no generar conflictos) ---
// GET /api/services/:id/stylists - Obtener estilistas que pueden hacer este servicio
router.get('/:id/stylists', authMiddleware, serviceController.getStylistsForService); // <-- 2. AÑADIMOS LA NUEVA RUTA

// --- Rutas que operan sobre un servicio específico (Protegidas) ---
router.get('/:id', authMiddleware, serviceController.getServiceById);
router.put('/:id', authMiddleware, serviceController.updateService);
router.delete('/:id', authMiddleware, serviceController.deleteService);

module.exports = router;