// Contenido COMPLETO para: src/index.js (Backend)

const express = require('express');
const cors = require('cors'); // <-- IMPORTAMOS CORS
const db = require('./config/db');

// Importar enrutadores
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

// --- CONFIGURACIÓN DE MIDDLEWARES ---

// 1. Configuración de CORS
// Le decimos al backend que acepte peticiones desde nuestro frontend en localhost:3001
app.use(cors({
    origin: 'http://localhost:3001' 
}));

// 2. Middleware para parsear JSON (este ya lo teníamos)
app.use(express.json());

// ------------------------------------


app.get('/', (req, res) => {
  res.send('¡El servidor del sistema de peluquerías está funcionando!');
});

// Registrar rutas
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

app.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
});