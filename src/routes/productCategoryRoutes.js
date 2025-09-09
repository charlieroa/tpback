// En: src/routes/productCategoryRoutes.js
const express = require('express');
const router = express.Router();
const productCategoryController = require('../controllers/productCategoryController');
const authMiddleware = require('../middleware/authMiddleware');

// Middleware de Autenticación
// Aplica seguridad a TODAS las rutas definidas en este archivo.
router.use(authMiddleware);

// --- Definición de Rutas RESTful para Categorías de Productos ---

// CREAR una nueva categoría
// POST /api/product-categories
router.post('/', productCategoryController.createCategory);

// LEER todas las categorías
// GET /api/product-categories
router.get('/', productCategoryController.getAllCategories);

// ACTUALIZAR una categoría por su ID
// PUT /api/product-categories/:id
router.put('/:id', productCategoryController.updateCategory);

// ELIMINAR una categoría por su ID
// DELETE /api/product-categories/:id
router.delete('/:id', productCategoryController.deleteCategory);


module.exports = router;