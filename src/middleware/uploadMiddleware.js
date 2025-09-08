// En: src/middleware/uploadMiddleware.js

const multer = require('multer');
const path = require('path');
const fs = require('fs');

// 1. Definimos la ruta donde se guardarán las imágenes de los productos
const PRODUCTS_UPLOADS_DIR = path.join(__dirname, '..', '..', 'public', 'uploads', 'products');

// 2. Nos aseguramos de que la carpeta exista. Si no, la creamos.
fs.mkdirSync(PRODUCTS_UPLOADS_DIR, { recursive: true });

// 3. Configuramos el almacenamiento de Multer (dónde y cómo guardar el archivo)
const storage = multer.diskStorage({
    destination: (_req, _file, cb) => {
        cb(null, PRODUCTS_UPLOADS_DIR);
    },
    filename: (req, file, cb) => {
        // Creamos un nombre de archivo único para evitar colisiones
        const productId = req.params.productId;
        const ext = path.extname(file.originalname || '');
        const fileName = `product-${productId}-${Date.now()}${ext}`;
        cb(null, fileName);
    },
});

// 4. Creamos y exportamos el middleware de Multer
const upload = multer({
    storage: storage,
    fileFilter: (_req, file, cb) => {
        // Aceptamos solo imágenes
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Solo se permiten archivos de imagen.'), false);
        }
    },
});

module.exports = upload;