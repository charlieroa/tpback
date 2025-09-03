// src/routes/tenantRoutes.js
const express = require('express');
const router = express.Router();
const tenantController = require('../controllers/tenantController');
const authMiddleware = require('../middleware/authMiddleware');
const multer = require('multer'); // <--- NUEVO: Importa multer

// Configuración de multer para la subida de archivos
// NOTA: Esta es una configuración básica. Para producción, se recomienda
// guardar los archivos en un servicio como AWS S3 o similar.
const upload = multer({ dest: 'public/uploads/logos/' }); // <--- NUEVO: Define la carpeta de destino

// POST /api/tenants - Crear un nuevo tenant (protegido)
router.post('/', authMiddleware, tenantController.createTenant);

// GET /api/tenants?slug=mi-peluqueria - Listar todos o uno por slug
router.get('/', tenantController.getAllTenants);

// GET /api/tenants/:id - Obtener un tenant por ID
router.get('/:id', tenantController.getTenantById);

// PUT /api/tenants/:id - Actualizar un tenant por ID (protegido)
router.put('/:id', authMiddleware, tenantController.updateTenant);

// POST /api/tenants/:tenantId/logo - Subir y asociar un logo a un tenant
// 'logo' es el nombre del campo en el formulario (form-data)
router.post('/:tenantId/logo', authMiddleware, upload.single('logo'), tenantController.uploadTenantLogo); // <--- NUEVA RUTA

// DELETE /api/tenants/:id - Eliminar un tenant por ID (protegido)
router.delete('/:id', authMiddleware, tenantController.deleteTenant);

module.exports = router;