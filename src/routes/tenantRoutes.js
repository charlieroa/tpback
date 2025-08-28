// src/routes/tenantRoutes.js
const express = require('express');
const router = express.Router();
const tenantController = require('../controllers/tenantController');
const authMiddleware = require('../middleware/authMiddleware'); // opcional pero recomendado

// POST /api/tenants - Crear un nuevo tenant (protegido)
router.post('/', authMiddleware, tenantController.createTenant);

// GET /api/tenants?slug=mi-peluqueria - Listar todos o uno por slug
router.get('/', tenantController.getAllTenants);

// GET /api/tenants/:id - Obtener un tenant por ID
router.get('/:id', tenantController.getTenantById);

// PUT /api/tenants/:id - Actualizar un tenant por ID (protegido)
router.put('/:id', authMiddleware, tenantController.updateTenant);

// DELETE /api/tenants/:id - Eliminar un tenant por ID (protegido)
router.delete('/:id', authMiddleware, tenantController.deleteTenant);

module.exports = router;
