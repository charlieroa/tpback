// src/routes/tenantRoutes.js
const express = require('express');
const router = express.Router();
const tenantController = require('../controllers/tenantController');

// Rutas para el CRUD de Tenants

// POST /api/tenants - Crear un nuevo tenant
router.post('/', tenantController.createTenant);

// GET /api/tenants - Obtener todos los tenants
router.get('/', tenantController.getAllTenants);

// GET /api/tenants/:id - Obtener un tenant por ID
router.get('/:id', tenantController.getTenantById);

// PUT /api/tenants/:id - Actualizar un tenant por ID
router.put('/:id', tenantController.updateTenant);

// DELETE /api/tenants/:id - Eliminar un tenant por ID
router.delete('/:id', tenantController.deleteTenant);

module.exports = router;