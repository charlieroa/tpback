// =============================================
// Archivo Principal de la API: src/index.js
// =============================================

// Carga las variables de entorno del archivo .env al inicio de todo.
require('dotenv').config();

// Módulos principales
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

// Configuración de la base de datos (se importa después de dotenv)
const db = require('./config/db');

// Importación de todas las rutas
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
const staffLoanRoutes = require('./routes/staffLoanRoutes');
const { uploadTenantLogo } = require('./controllers/tenantController');

// Inicialización de la aplicación Express
const app = express();
const PORT = process.env.PORT || 3000;


/* =======================================
    🛡️ CONFIGURACIÓN DE CORS
======================================= */
// Lista de orígenes permitidos (clientes que pueden hacer peticiones a esta API)
const allowedOrigins = [
  'http://localhost:3001',          // Para desarrollo local
  'https://app.tupelukeria.com',  // ¡EL ORIGEN CORRECTO DE TU FRONTEND!
  'https://tpia.tupelukeria.com', // Lo mantengo por si lo usas para otra cosa
];

const corsOptions = {
  origin: function (origin, callback) {
    // Permitir peticiones sin origen (ej. Postman, apps móviles) o que estén en la lista blanca
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('No permitido por la política de CORS.'));
    }
  },
  credentials: true, // Permite que el frontend envíe cookies o cabeceras de autorización
};

app.use(cors(corsOptions));


/* =======================================
    🚀 MIDDLEWARES ESENCIALES
======================================= */
// Para poder entender JSON en el cuerpo de las peticiones
app.use(express.json());


/* =======================================
    🗂️ SERVICIO DE ARCHIVOS ESTÁTICOS
======================================= */
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');
const LOGOS_DIR = path.join(UPLOADS_DIR, 'logos');

// Asegurarse de que el directorio de logos exista
fs.mkdirSync(LOGOS_DIR, { recursive: true });

// Servir la carpeta 'public' para acceso general
app.use(express.static(PUBLIC_DIR));


/* =======================================
    ⬆️ CONFIGURACIÓN DE SUBIDA DE ARCHIVOS (MULTER)
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
    📡 RUTAS DE LA APLICACIÓN
======================================= */
app.get('/', (_req, res) => res.send('¡API de TuPelukeria.com funcionando!'));
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
app.use('/api/staff-loans', staffLoanRoutes);
// Ruta específica para la subida del logo
app.post('/api/tenants/:tenantId/logo', upload.single('logo'), uploadTenantLogo);


/* =======================================
    ❤️ HEALTHCHECK (VERIFICACIÓN DE ESTADO)
======================================= */
app.get(['/health', '/api/health'], async (_req, res) => {
  try {
    await db.healthCheck();
    res.status(200).json({ status: 'ok', app: 'up', db: 'up' });
  } catch (e) {
    res.status(503).json({ status: 'error', app: 'up', db: 'down', error: e.message });
  }
});


/* =======================================
    🧯 MANEJO DE ERRORES (DEBE IR AL FINAL)
======================================= */
app.use((err, req, res, next) => {
  // Loguear el error para depuración
  console.error(`[ERROR] ${req.method} ${req.url} - ${err.stack}`);

  // Manejo específico para errores de CORS
  if (err.message === 'No permitido por la política de CORS.') {
    return res.status(403).json({ error: 'Acceso denegado por CORS.' });
  }

  // Respuesta de error genérica para el cliente
  res.status(500).json({ error: 'Ocurrió un error inesperado en el servidor.' });
});


/* =======================================
    ▶️ INICIO DEL SERVIDOR
======================================= */
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en el puerto ${PORT}`);
});