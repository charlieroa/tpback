// src/routes/tenantRoutes.js
const express = require('express');
const router = express.Router();

const requireAuth = require('../middleware/authMiddleware'); // 👈 default export: es una función
const tenantController = require('../controllers/tenantController'); // objeto con handlers

// 🧪 Debug en caliente: confirma que ambos son funciones
console.log('[tenantRoutes] typeof requireAuth =', typeof requireAuth);
console.log('[tenantRoutes] typeof tenantController.createTenant =', typeof tenantController.createTenant);

// Pequeño helper para evitar que el server se caiga si algo no es función
const ensureFn = (fn, name) =>
  typeof fn === 'function'
    ? fn
    : (req, res, next) => {
        console.error(`[tenantRoutes] ${name} NO es función`, fn);
        return res.status(500).json({ error: `${name} no es función` });
      };

// POST /api/tenants - Crear un nuevo tenant (protegido)
router.post('/', ensureFn(requireAuth, 'requireAuth'), ensureFn(tenantController.createTenant, 'createTenant'));

// GET /api/tenants?slug=... - Listar todos o uno por slug
router.get('/', ensureFn(tenantController.getAllTenants, 'getAllTenants'));

// GET /api/tenants/:id - Obtener un tenant por ID
router.get('/:id', ensureFn(tenantController.getTenantById, 'getTenantById'));

// PUT /api/tenants/:id - Actualizar un tenant por ID (protegido)
router.put('/:id', ensureFn(requireAuth, 'requireAuth'), ensureFn(tenantController.updateTenant, 'updateTenant'));

// DELETE /api/tenants/:id - Eliminar un tenant por ID (protegido)
router.delete('/:id', ensureFn(requireAuth, 'requireAuth'), ensureFn(tenantController.deleteTenant, 'deleteTenant'));

module.exports = router;
