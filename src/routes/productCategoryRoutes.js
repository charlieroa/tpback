// En: src/routes/productCategoryRoutes.js
const express = require('express');
const router = express.Router();
const productCategoryController = require('../controllers/productCategoryController');
const authMiddleware = require('../middleware/authMiddleware');

// Proteger todas las rutas de categorías de productos
router.use(authMiddleware);

// Rutas del CRUD completo
router.post('/', productCategoryController.createCategory); // Crear
router.get('/', productCategoryController.getAllCategories);  // Leer todas
router.put('/:id', productCategoryController.updateCategory); // <-- AÑADE ESTA LÍNEA para Actualizar
router.delete('/:id', productCategoryController.deleteCategory); // <-- AÑADE ESTA LÍNEA para Eliminar

module.exports = router;