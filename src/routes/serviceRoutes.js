// src/routes/serviceRoutes.js
const express = require('express');
const router = express.Router();
const serviceController = require('../controllers/serviceController');

// POST /api/services - Crear un nuevo servicio
router.post('/', serviceController.createService);

// GET /api/services/tenant/:tenantId - Obtener todos los servicios de una peluquería
router.get('/tenant/:tenantId', serviceController.getServicesByTenant);

// GET /api/services/:id - Obtener un servicio por ID
router.get('/:id', serviceController.getServiceById);

// PUT /api/services/:id - Actualizar un servicio por ID
router.put('/:id', serviceController.updateService);

// DELETE /api/services/:id - Eliminar un servicio por ID
router.delete('/:id', serviceController.deleteService);

module.exports = router;