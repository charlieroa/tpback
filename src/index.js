const express = require('express');
const cors = require('cors');
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

const app = express();
const PORT = process.env.PORT || 3000;

// =======================================
// 🛡️ CONFIGURACIÓN DE CORS PARA LOCAL Y PRODUCCIÓN
// =======================================

const allowedOrigins = [
  'http://localhost:3001',           // desarrollo local
  'https://tpia.tupelukeria.com'     // producción
];

app.use(cors({
  origin: function (origin, callback) {
    // Permitir requests sin origin (como Postman)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    } else {
      return callback(new Error('No permitido por CORS: ' + origin));
    }
  },
  credentials: true // ⚠️ Necesario para cookies o headers de auth (e.g., JWT)
}));

// =======================================
// 🚀 MIDDLEWARES
// =======================================
app.use(express.json());

// =======================================
// 📡 ENDPOINT DE PRUEBA
// =======================================
app.get('/', (req, res) => {
  res.send('¡El servidor del sistema de peluquerías está funcionando!');
});

// =======================================
// 📦 RUTAS
// =======================================
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

// =======================================
// ▶️ INICIAR SERVIDOR
// =======================================
app.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
});
