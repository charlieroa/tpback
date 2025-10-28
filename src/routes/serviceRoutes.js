// src/routes/serviceRoutes.js
const express = require('express');
const router = express.Router();
const serviceController = require('../controllers/serviceController');
const authMiddleware = require('../middleware/authMiddleware');

// ---------------------------------------------------
// Rutas PÚBLICAS (sin autenticación) - van PRIMERO
// ---------------------------------------------------
router.get('/search/:tenantId', serviceController.searchServices);

// ---------------------------------------------------
// A partir de aquí, TODO requiere auth
// ---------------------------------------------------
router.use(authMiddleware);

// Crear servicio
router.post('/', serviceController.createService);

// Listar servicios del tenant (el :tenantId en la ruta se ignora; el controller usa tenant_id del token)
router.get('/tenant/:tenantId', serviceController.getServicesByTenant);

// Estilistas cualificados para un servicio
router.get('/:id/stylists', serviceController.getStylistsForService);

// Operaciones por ID
router.get('/:id', serviceController.getServiceById);
router.put('/:id', serviceController.updateService);
router.delete('/:id', serviceController.deleteService);

module.exports = router;
