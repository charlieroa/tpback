// =============================================
// File: src/app.js (Versión Limpia y Profesional)
// =============================================
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// --- Rutas ---
const authRoutes = require('./routes/authRoutes');
const tenantRoutes = require('./routes/tenantRoutes');
const userRoutes = require('./routes/userRoutes');
const serviceRoutes = require('./routes/serviceRoutes');
const categoryRoutes = require('./routes/categoryRoutes'); // Categorías de Servicios
const productCategoryRoutes = require('./routes/productCategoryRoutes'); // Categorías de Productos
const appointmentRoutes = require('./routes/appointmentRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const productRoutes = require('./routes/productRoutes');
const payrollRoutes = require('./routes/payrollRoutes');
const stylistRoutes = require('./routes/stylistRoutes');
const cashRoutes = require('./routes/cashRoutes');
const staffPurchaseRoutes = require('./routes/staffPurchaseRoutes'); // <-- 1. IMPORTAMOS NUESTRAS NUEVAS RUTAS

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
     🗂️ Archivos estáticos (imágenes, etc.)
======================================= */
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
fs.mkdirSync(path.join(PUBLIC_DIR, 'uploads'), { recursive: true });

// Esta línea sirve todo lo que esté en la carpeta /public/uploads
// bajo la URL /uploads. Funciona para logos, fotos de productos, etc.
app.use('/uploads', express.static(path.join(PUBLIC_DIR, 'uploads')));


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
app.use('/api/tenants', tenantRoutes); // Esta ruta ahora maneja la subida de logos internamente
app.use('/api/users', userRoutes);
app.use('/api/services', serviceRoutes);
app.use('/api/appointments', appointmentRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/products', productRoutes); // Esta ruta ya maneja la subida de imágenes de producto
app.use('/api/payrolls', payrollRoutes);
app.use('/api/stylists', stylistRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/product-categories', productCategoryRoutes);
app.use('/api/cash', cashRoutes);
app.use('/api/staff-purchases', staffPurchaseRoutes); // <-- 2. REGISTRAMOS LAS NUEVAS RUTAS

/* =======================================
     🧯 Manejo sencillo de errores
======================================= */
app.use((err, _req, res, next) => {
  if (err && typeof err.message === 'string' && err.message.startsWith('No permitido por CORS:')) {
    return res.status(403).json({ error: err.message });
  }
  // Podríamos añadir más manejadores de errores aquí en el futuro
  return next(err);
});

/* =======================================
     ▶️ Iniciar servidor
======================================= */
app.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
});