// src/routes/productRoutes.js
const express = require('express');
const router = express.Router();
const productController = require('../controllers/productController');

// Rutas del CRUD de productos
router.post('/', productController.createProduct);
router.get('/tenant/:tenantId', productController.getProductsByTenant);
router.put('/:id', productController.updateProduct);
// Podríamos añadir un DELETE si quisiéramos

// Ruta específica para gestionar el stock de un producto
router.post('/:productId/stock', productController.manageStock);

module.exports = router;