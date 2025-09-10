// =============================================
// File: src/app.js (Confirmado como Completo)
// =============================================
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const db = require('./config/db');

// Rutas
const tenantRoutes = require('./routes/tenantRoutes');
const userRoutes = require('./routes/userRoutes');
const serviceRoutes = require('./routes/serviceRoutes');
const appointmentRoutes = require('./routes/appointmentRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const productRoutes = require('./routes/productRoutes');
const payrollRoutes = require('./routes/payrollRoutes');
const stylistRoutes = require('./routes/stylistRoutes');
const categoryRoutes = require('./routes/categoryRoutes');
const authRoutes = require('./routes/authRoutes');
const cashRoutes = require('./routes/cashRoutes');
const productCategoryRoutes = require('./routes/productCategoryRoutes');
const staffPurchaseRoutes = require('./routes/staffPurchaseRoutes');

// Controller para subir logo
const { uploadTenantLogo } = require('./controllers/tenantController');

const app = express();
const PORT = process.env.PORT || 3000;

/* =======================================
    🛡️ CORS (local + producción)
======================================= */
const allowedOrigins = [
  'http://localhost:3001',
  'https://tpia.tupelukeria.com',
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('No permitido por CORS: ' + origin));
    },
    credentials: true,
  })
);

/* =======================================
    🚀 Middlewares base
======================================= */
app.use(express.json());

/* =======================================
    🗂️ Archivos estáticos (logos, etc.)
======================================= */
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');
const LOGOS_DIR = path.join(UPLOADS_DIR, 'logos');

// Esta línea también crea la carpeta `products` si no existe,
// gracias al `mkdirSync` que pusimos en `uploadMiddleware.js`.
fs.mkdirSync(LOGOS_DIR, { recursive: true });

app.use(express.static(PUBLIC_DIR));
// ESTA LÍNEA ES LA MAGIA: hace que todo dentro de /uploads sea público.
// Servirá para /uploads/logos/ y para /uploads/products/ automáticamente.
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/api/uploads', express.static(UPLOADS_DIR));

/* =======================================
    ⬆️ Subida de archivos (Multer) para logos
======================================= */
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, LOGOS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '');
    cb(null, `logo-${req.params.tenantId}-${Date.now()}${ext}`);
  },
});
const upload = multer({ storage });

/* =======================================
    📡 Endpoint de prueba
======================================= */
app.get('/', (_req, res) => {
  res.send('¡El servidor del sistema de peluquerías está funcionando!');
});

/* =======================================
    📦 Rutas API
======================================= */
app.use('/api/auth', authRoutes);
app.use('/api/tenants', tenantRoutes);
app.use('/api/users', userRoutes);
app.use('/api/services', serviceRoutes);
app.use('/api/appointments', appointmentRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/products', productRoutes);
app.use('/api/payrolls', payrollRoutes);
app.use('/api/stylists', stylistRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/product-categories', productCategoryRoutes);
app.use('/api/cash', cashRoutes);
app.use('/api/staff-purchases', staffPurchaseRoutes);
// Subida de logo del tenant (usa tu controller existente)
app.post('/api/tenants/:tenantId/logo', upload.single('logo'), uploadTenantLogo);

/* =======================================
    🧯 Manejo sencillo de errores CORS
======================================= */
app.use((err, _req, res, next) => {
  if (err && typeof err.message === 'string' && err.message.startsWith('No permitido por CORS:')) {
    return res.status(403).json({ error: err.message });
  }
  return next(err);
});

/* =======================================
    ▶️ Iniciar servidor
======================================= */
app.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
});