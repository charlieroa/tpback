// Contenido completo para: src/routes/authRoutes.js

const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');

// Ruta para iniciar sesión (ya la teníamos)
router.post('/login', authController.login);

// NUEVA RUTA para que un dueño de peluquería se registre
router.post('/register-tenant', authController.registerTenantAndAdmin);

module.exports = router;