// =========================================================
// File: src/routes/productRoutes.js (Versión Final)
// =========================================================
const express = require('express');
const router = express.Router();
const productController = require('../controllers/productController');
const authMiddleware = require('../middleware/authMiddleware');

// 1. Importamos nuestro middleware de subida. Lo llamamos 'upload'
//    para que coincida con lo que exportamos en 'uploadMiddleware.js'.
const upload = require('../middleware/uploadMiddleware'); 

// 2. Usamos el middleware de autenticación para proteger TODAS las rutas de productos.
router.use(authMiddleware);

// --- Rutas del CRUD de Productos (Estilo RESTful) ---
router.post('/', productController.createProduct);
router.get('/', productController.getProductsByTenant);
router.get('/:id', productController.getProductById);
router.put('/:id', productController.updateProduct);
router.delete('/:id', productController.deleteProduct);

// --- Rutas de Gestión Específica ---
router.post('/:productId/stock', productController.manageStock);

// --- RUTA PARA SUBIR IMAGEN DE PRODUCTO ---
// Este es el flujo cuando una petición llega a esta ruta:
// a). Se verifica que el usuario esté autenticado (por el router.use de arriba).
// b). 'upload.single("image")' se ejecuta: Multer procesa el archivo, lo guarda y añade req.file.
// c). Si todo va bien, 'productController.uploadProductImage' se ejecuta para guardar la URL en la BD.
router.post(
    '/:productId/image', 
    upload.single('image'), 
    productController.uploadProductImage 
);


module.exports = router;