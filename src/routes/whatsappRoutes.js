'use strict';

const express = require('express');
const router = express.Router();
const whatsappController = require('../controllers/whatsappController');

/* =================================================================== */
/* ========================   RUTAS WHATSAPP   ======================= */
/* =================================================================== */

/**
 * GET /api/whatsapp/status/:tenantId
 * ------------------------------------------------------
 * Endpoint principal para el Polling del Frontend.
 * * Flujo:
 * 1. El frontend llama a esto cada 3 segundos.
 * 2. El controlador verifica el estado en WAHA.
 * 3. Si requiere QR, el controlador obtiene la IMAGEN (Base64)
 * desde WAHA y la devuelve lista para mostrar en el frontend.
 */
router.get('/status/:tenantId', whatsappController.getStatus);

/**
 * POST /api/whatsapp/webhook
 * ------------------------------------------------------
 * Ruta PÚBLICA que Waha llama automáticamente.
 * Aquí recibimos la confirmación cuando el usuario escanea el QR
 * y actualizamos la base de datos con el número de teléfono.
 */
router.post('/webhook', whatsappController.handleWahaWebhook);

/**
 * POST /api/whatsapp/disconnect
 * ------------------------------------------------------
 * Cierra la sesión en Waha y limpia el número en tu BD.
 */
router.post('/disconnect', whatsappController.disconnect);

module.exports = router;