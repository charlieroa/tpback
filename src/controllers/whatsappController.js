'use strict';

const db = require('../config/db');
const wahaService = require('../services/wahaService');
const { formatInTimeZone, zonedTimeToUtc } = require('date-fns-tz');
const { getIO } = require('../socket');

const TIME_ZONE = 'America/Bogota';

// Cache para historial de conversación por número de teléfono
const conversationCache = new Map();

// Cache para rastrear cuando estamos esperando el nombre del cliente
const awaitingNameCache = new Map();

// Cache para rastrear cuando estamos esperando el apellido del cliente
const awaitingLastNameCache = new Map();
// Cache para guardar temporalmente el nombre mientras esperamos el apellido
const tempFirstNameCache = new Map();

// Cache para confirmar si el nombre guardado está bien
const awaitingNameConfirmCache = new Map();
// Cache para guardar el nombre que estamos confirmando
const savedNameToConfirmCache = new Map();

function isAwaitingName(chatId) {
    return awaitingNameCache.get(chatId) === true;
}

function setAwaitingName(chatId, value) {
    if (value) {
        awaitingNameCache.set(chatId, true);
    } else {
        awaitingNameCache.delete(chatId);
    }
}

function isAwaitingLastName(chatId) {
    return awaitingLastNameCache.get(chatId) === true;
}

function setAwaitingLastName(chatId, value, firstName = null) {
    if (value) {
        awaitingLastNameCache.set(chatId, true);
        if (firstName) tempFirstNameCache.set(chatId, firstName);
    } else {
        awaitingLastNameCache.delete(chatId);
        tempFirstNameCache.delete(chatId);
    }
}

function getTempFirstName(chatId) {
    return tempFirstNameCache.get(chatId);
}

function isAwaitingNameConfirm(chatId) {
    return awaitingNameConfirmCache.get(chatId) === true;
}

function setAwaitingNameConfirm(chatId, value, savedName = null) {
    if (value) {
        awaitingNameConfirmCache.set(chatId, true);
        if (savedName) savedNameToConfirmCache.set(chatId, savedName);
    } else {
        awaitingNameConfirmCache.delete(chatId);
        savedNameToConfirmCache.delete(chatId);
    }
}

function getSavedNameToConfirm(chatId) {
    return savedNameToConfirmCache.get(chatId);
}

/* =================================================================== */
/* ==============   1. GET STATUS / QR IMAGE (GET)   ================= */
/* =================================================================== */

exports.getStatus = async (req, res) => {
    const { tenantId } = req.params;

    if (!tenantId) return res.status(400).json({ error: 'Falta tenantId en la URL' });

    try {
        // 1. Consultar estado actual a WAHA
        let sessionStatus = await wahaService.getSessionStatus(tenantId);

        // 2. AUTO-CREACIÓN: Si la sesión NO existe, la creamos
        if (!sessionStatus) {
            console.log(`🆕 Sesión ${tenantId} no existe. Creando...`);
            await wahaService.startSession(tenantId);
            return res.json({ status: 'LOADING' });
        }

        const status = String(sessionStatus.status).toLowerCase();

        // A. CONECTADO
        if (status === 'working' || status === 'authenticated') {
            return res.json({ status: 'CONNECTED' });
        }

        // B. REQUIERE ESCANEO
        if (status === 'scan_qr_code') {
            const qrImageBase64 = await wahaService.getQrRawData(tenantId);
            if (qrImageBase64) {
                return res.json({ status: 'QR_READY', qr: qrImageBase64 });
            }
            return res.json({ status: 'LOADING' });
        }

        // C. FALLIDO -> Auto-reparación
        if (status === 'failed') {
            await wahaService.deleteSession(tenantId);
            return res.json({ status: 'LOADING', message: 'Reparando sesión...' });
        }

        // D. DETENIDO -> Auto-arranque
        if (status === 'stopped') {
            await wahaService.startSession(tenantId);
            return res.json({ status: 'LOADING' });
        }

        return res.json({ status: 'LOADING' });

    } catch (error) {
        console.error('❌ Error en getStatus:', error.message);
        return res.json({ status: 'ERROR', message: error.message });
    }
};

/* =================================================================== */
/* ==============   2. WEBHOOK (LISTEN TO WAHA)   ==================== */
/* =================================================================== */

exports.handleWahaWebhook = async (req, res) => {
    try {
        const event = req.body;
        const eventType = event.event;
        const tenantId = event.session;

        console.log(`\n📥 [WEBHOOK] Evento recibido: ${eventType} | Sesión: ${tenantId}`);

        // ==========================================
        // A) EVENTO: CAMBIO DE ESTADO DE SESIÓN
        // ==========================================
        if (eventType === 'session.status' && event.payload?.status === 'authenticated') {
            console.log('🔔 [WEBHOOK] ¡Conexión Exitosa Detectada!');

            const me = event.me || event.payload.me;
            if (tenantId && me) {
                const rawNumber = me.id;
                const cleanNumber = rawNumber.split('@')[0];
                const displayNumber = '+' + cleanNumber.replace(/(\d{2})(\d{3})(\d{3})(\d{4})/, '$1 $2 $3 $4');

                // Limpiar conflictos
                await db.query(
                    `UPDATE tenant_numbers 
                     SET provider = 'disconnected', phone_number_id = 'disconnected', display_phone_number = '' 
                     WHERE phone_number_id = $1 AND tenant_id != $2`,
                    [cleanNumber, tenantId]
                );

                // Conectar nuevo tenant
                await db.query(
                    `UPDATE tenant_numbers 
                     SET provider = 'waha', phone_number_id = $1, display_phone_number = $2, updated_at = NOW() 
                     WHERE tenant_id = $3`,
                    [cleanNumber, displayNumber, tenantId]
                );

                console.log(`   ✅ Tenant ${tenantId} conectado con número ${displayNumber}`);
            }
        }

        // ==========================================
        // B) EVENTO: MENSAJE ENTRANTE
        // ==========================================
        if (eventType === 'message' && event.payload) {
            const payload = event.payload;

            // Ignorar mensajes propios (enviados por el bot)
            if (payload.fromMe) {
                return res.status(200).send('OK');
            }

            const messageType = payload.type || payload._data?.type;
            const chatId = payload.from;
            let userMessage = payload.body;
            let isVoiceMessage = false;

            // Extraer número de teléfono
            const phoneNumber = chatId.split('@')[0];

            // Extraer el nombre de display de WhatsApp (notifyName) - buscar en múltiples ubicaciones
            let notifyName = payload.notifyName
                || payload._data?.notifyName
                || payload.pushName
                || payload._data?.pushName
                || '';

            // Log para diagnóstico
            console.log(`   📋 [PAYLOAD DEBUG] notifyName: "${notifyName}" | payload.notifyName: "${payload.notifyName}" | pushName: "${payload.pushName}"`);

            // ==========================================
            // FLUJO DE NOMBRE: Pedir nombre si no existe uno válido
            // ==========================================
            let clientId = null;
            let senderName = notifyName || 'Cliente';
            let hasValidSavedName = false;

            try {
                // Buscar si ya existe el cliente
                const existingClient = await db.query(
                    `SELECT id, first_name, last_name FROM users 
                     WHERE tenant_id = $1 AND phone = $2 AND role_id = 4`,
                    [tenantId, phoneNumber]
                );

                if (existingClient.rows.length > 0) {
                    clientId = existingClient.rows[0].id;
                    const savedFirstName = existingClient.rows[0].first_name;
                    const savedLastName = existingClient.rows[0].last_name;

                    // Verificar si el nombre guardado es válido (solo first_name requerido)
                    const invalidNames = ['cliente', 'hola', 'buenos días', 'buenas tardes', 'buenas noches', 'hi', 'hello'];
                    if (savedFirstName &&
                        savedFirstName.length >= 2 &&
                        !/^\d+$/.test(savedFirstName) &&
                        !invalidNames.includes(savedFirstName.toLowerCase())) {
                        // Tiene nombre válido - apellido es opcional
                        senderName = savedLastName && savedLastName.length >= 2
                            ? `${savedFirstName} ${savedLastName}`.trim()
                            : savedFirstName;
                        hasValidSavedName = true;
                        console.log(`   ✅ [NOMBRE] Usando nombre guardado: ${senderName}`);
                    }
                } else {
                    // Crear cliente nuevo con nombre temporal (notifyName)
                    try {
                        const newClient = await db.query(
                            `INSERT INTO users (tenant_id, role_id, first_name, phone, email, password_hash)
                             VALUES ($1, 4, $2, $3, $4, 'whatsapp')
                             RETURNING id`,
                            [tenantId, senderName, phoneNumber, `${phoneNumber}@whatsapp.temp`]
                        );
                        if (newClient.rows.length > 0) {
                            clientId = newClient.rows[0].id;
                            console.log(`   🆕 [CLIENTE] Nuevo cliente: ${senderName} (${phoneNumber})`);
                        }
                    } catch (insertError) {
                        if (insertError.code === '23505') {
                            const existing = await db.query(
                                `SELECT id FROM users WHERE tenant_id = $1 AND phone = $2 AND role_id = 4`,
                                [tenantId, phoneNumber]
                            );
                            if (existing.rows.length > 0) {
                                clientId = existing.rows[0].id;
                            }
                        } else {
                            throw insertError;
                        }
                    }
                }

                // === SIMPLIFICADO: Solo usar notifyName de WhatsApp ===
                // Si el cliente existe pero tiene nombre inválido, actualizar con notifyName
                if (clientId && !hasValidSavedName && notifyName && notifyName.length >= 2) {
                    const invalidNames = ['cliente', 'hola', 'hi', 'hello'];
                    if (!invalidNames.includes(notifyName.toLowerCase())) {
                        await db.query(
                            `UPDATE users SET first_name = $1, updated_at = NOW() WHERE id = $2`,
                            [notifyName, clientId]
                        );
                        senderName = notifyName;
                        console.log(`   🔄 [NOMBRE] Actualizado desde WhatsApp: ${senderName}`);
                    }
                }

                console.log(`   👤 Cliente: ${senderName} | ID: ${clientId || 'nuevo'}`);

            } catch (clientError) {
                console.error('   ⚠️ [CLIENTE] Error:', clientError.message);
            }

            // Manejar notas de voz (ptt = push-to-talk)
            if (messageType === 'ptt' || messageType === 'audio') {
                console.log(`\n🎤 [AUDIO] De: ${senderName} (${chatId})`);
                isVoiceMessage = true;

                try {
                    // Obtener API Key para Whisper
                    const apiKeyResult = await db.query(
                        'SELECT openai_api_key FROM tenants WHERE id = $1',
                        [tenantId]
                    );
                    const apiKey = apiKeyResult.rows[0]?.openai_api_key;

                    if (apiKey) {
                        // Log estructura del media para debug
                        console.log(`   📦 Media payload:`, JSON.stringify(payload.media || payload._data?.media || 'NO_MEDIA', null, 2));

                        // Obtener URL o descargar desde WAHA
                        const axios = require('axios');
                        let audioBuffer = null;

                        // Intentar múltiples métodos para obtener el audio
                        const WAHA_URL = process.env.WAHA_URL || 'http://212.28.189.253:3002';
                        const WAHA_API_KEY = process.env.WAHA_API_KEY || '';

                        // Método 1: URL directa del media (reemplazar localhost con URL real de WAHA)
                        if (payload.media?.url) {
                            try {
                                // WAHA devuelve localhost:3000 o 0.0.0.0:3000 pero corre en WAHA_URL
                                let mediaUrl = payload.media.url;
                                if (mediaUrl.includes('localhost:3000')) {
                                    mediaUrl = mediaUrl.replace('http://localhost:3000', WAHA_URL);
                                }
                                if (mediaUrl.includes('0.0.0.0:3000')) {
                                    mediaUrl = mediaUrl.replace('http://0.0.0.0:3000', WAHA_URL);
                                }
                                console.log(`   📥 Intentando URL: ${mediaUrl}`);
                                const audioResponse = await axios.get(mediaUrl, {
                                    responseType: 'arraybuffer',
                                    headers: { 'X-Api-Key': WAHA_API_KEY },
                                    timeout: 10000
                                });
                                audioBuffer = Buffer.from(audioResponse.data);
                            } catch (urlError) {
                                console.log(`   ⚠️ URL directa falló: ${urlError.message}`);
                            }
                        }

                        // Método 2: Descargar desde WAHA usando el ID del mensaje
                        if (!audioBuffer && payload.id) {
                            try {
                                console.log(`   📥 Intentando descarga via WAHA API...`);
                                const downloadUrl = `${WAHA_URL}/api/${tenantId}/messages/${payload.id}/download`;
                                const audioResponse = await axios.get(downloadUrl, {
                                    responseType: 'arraybuffer',
                                    headers: { 'X-Api-Key': WAHA_API_KEY },
                                    timeout: 10000
                                });
                                audioBuffer = Buffer.from(audioResponse.data);
                            } catch (wahaError) {
                                console.log(`   ⚠️ WAHA API falló: ${wahaError.message}`);
                            }
                        }

                        // Método 3: Obtener el base64 del _data si existe
                        if (!audioBuffer && payload._data?.body) {
                            try {
                                console.log(`   📥 Usando base64 del payload...`);
                                audioBuffer = Buffer.from(payload._data.body, 'base64');
                            } catch (b64Error) {
                                console.log(`   ⚠️ Base64 falló: ${b64Error.message}`);
                            }
                        }

                        if (!audioBuffer) {
                            console.log('   ❌ No se pudo obtener el audio por ningún método');
                            await wahaService.sendMessage(tenantId, chatId, '🎤 Lo siento, no pude acceder a tu nota de voz. ¿Puedes escribir tu mensaje?');
                            return res.status(200).send('OK');
                        }

                        // Transcribir con Whisper usando axios
                        const FormData = require('form-data');
                        const formData = new FormData();
                        formData.append('file', audioBuffer, { filename: 'audio.ogg', contentType: 'audio/ogg' });
                        formData.append('model', 'whisper-1');
                        formData.append('language', 'es');

                        try {
                            const whisperResponse = await axios.post(
                                'https://api.openai.com/v1/audio/transcriptions',
                                formData,
                                {
                                    headers: {
                                        'Authorization': `Bearer ${apiKey}`,
                                        ...formData.getHeaders()
                                    }
                                }
                            );
                            userMessage = whisperResponse.data.text;
                            console.log(`   📝 Transcripción: "${userMessage}"`);
                        } catch (whisperError) {
                            console.error('❌ Error en Whisper:', whisperError.response?.data || whisperError.message);
                            await wahaService.sendMessage(tenantId, chatId, '😅 No pude entender tu mensaje de voz. ¿Puedes escribirlo?');
                            return res.status(200).send('OK');
                        }
                    } else {
                        await wahaService.sendMessage(tenantId, chatId, '🎤 Lo siento, no puedo procesar notas de voz en este momento.');
                        return res.status(200).send('OK');
                    }
                } catch (voiceError) {
                    console.error('❌ Error procesando audio:', voiceError.message);
                    await wahaService.sendMessage(tenantId, chatId, '😅 Hubo un problema con tu nota de voz. ¿Puedes escribir tu mensaje?');
                    return res.status(200).send('OK');
                }
            } else if (messageType !== 'chat' || !payload.body) {
                // Ignorar otros tipos de mensajes (imágenes, etc)
                return res.status(200).send('OK');
            }

            console.log(`\n💬 [MENSAJE] De: ${senderName} (${chatId})`);
            console.log(`   Texto: "${userMessage}"`);

            // Obtener API Key del tenant
            const tenantResult = await db.query(
                'SELECT openai_api_key, name FROM tenants WHERE id = $1',
                [tenantId]
            );

            if (tenantResult.rows.length === 0 || !tenantResult.rows[0].openai_api_key) {
                console.log('⚠️ [WEBHOOK] No hay API Key configurada para este tenant');
                await wahaService.sendMessage(
                    tenantId,
                    chatId,
                    '⚠️ Lo siento, el asistente no está configurado aún. Por favor contacta al administrador.'
                );
                return res.status(200).send('OK');
            }

            const apiKey = tenantResult.rows[0].openai_api_key;
            const tenantName = tenantResult.rows[0].name || 'nuestra peluquería';

            // Obtener o crear historial de conversación
            const cacheKey = `${tenantId}:${chatId}`;
            let conversationHistory = conversationCache.get(cacheKey) || [];

            // 🔄 REINICIO DE CONVERSACIÓN: Limpiar historial solo si es un saludo simple o comando explícito
            const simpleGreetings = /^(hola|buenos días|buenas tardes|buenas noches|hi|hey|hello)[\s!.]*$/i;
            const resetCommands = /(empezar de nuevo|cancelar|se me olvid[oó]|reset|reiniciar)/i;

            const isSimpleGreeting = simpleGreetings.test(userMessage.trim());
            const isResetCommand = resetCommands.test(userMessage.trim());

            if ((isSimpleGreeting || isResetCommand) && conversationHistory.length > 0) {
                console.log(`🔄 [REINICIO] Limpiando historial de conversación para ${senderName}`);
                conversationHistory = [];
                conversationCache.set(cacheKey, conversationHistory);
            }

            // clientId ya está definido arriba en el flujo simplificado

            try {
                // Procesar con IA (pasamos nombre y teléfono del cliente de WAHA)
                const aiResponse = await processWithAI(
                    apiKey,
                    tenantId,
                    clientId,
                    userMessage,
                    conversationHistory,
                    senderName,
                    phoneNumber,
                    tenantName
                );

                // Actualizar historial
                conversationHistory.push({ role: 'user', content: userMessage });
                conversationHistory.push({ role: 'assistant', content: aiResponse });

                // Mantener solo últimos 10 mensajes
                if (conversationHistory.length > 20) {
                    conversationHistory = conversationHistory.slice(-20);
                }
                conversationCache.set(cacheKey, conversationHistory);

                // Responder por WhatsApp (texto o voz)
                if (isVoiceMessage && apiKey) {
                    // Responder con audio si el mensaje original fue de voz
                    try {
                        let audioBase64 = null;

                        // Intentar obtener ElevenLabs API key del tenant
                        const tenantResult = await db.query(
                            'SELECT elevenlabs_api_key, elevenlabs_voice_id FROM tenants WHERE id = $1',
                            [tenantId]
                        );
                        const elevenLabsKey = tenantResult.rows[0]?.elevenlabs_api_key;
                        const voiceId = tenantResult.rows[0]?.elevenlabs_voice_id || 'pNInz6obpgDQGcFmaJgB';  // Adam - voz clara en español

                        // Usar ElevenLabs si está configurado
                        if (elevenLabsKey) {
                            console.log('   🎙️ Usando ElevenLabs TTS...');
                            const elevenLabsResponse = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
                                method: 'POST',
                                headers: {
                                    'xi-api-key': elevenLabsKey,
                                    'Content-Type': 'application/json'
                                },
                                body: JSON.stringify({
                                    text: aiResponse,
                                    model_id: 'eleven_multilingual_v2',
                                    voice_settings: {
                                        stability: 0.5,
                                        similarity_boost: 0.75
                                    }
                                })
                            });

                            if (elevenLabsResponse.ok) {
                                const audioBuffer = Buffer.from(await elevenLabsResponse.arrayBuffer());
                                audioBase64 = audioBuffer.toString('base64');
                                console.log('   ✅ Audio generado con ElevenLabs');
                            } else {
                                console.error('   ⚠️ Error ElevenLabs:', await elevenLabsResponse.text());
                            }
                        }

                        // Fallback a OpenAI TTS si ElevenLabs no está disponible
                        if (!audioBase64) {
                            console.log('   🔊 Usando OpenAI TTS (fallback)...');
                            const ttsResponse = await fetch('https://api.openai.com/v1/audio/speech', {
                                method: 'POST',
                                headers: {
                                    'Authorization': `Bearer ${apiKey}`,
                                    'Content-Type': 'application/json'
                                },
                                body: JSON.stringify({
                                    model: 'tts-1-hd',
                                    voice: 'alloy',
                                    input: aiResponse,
                                    response_format: 'opus'
                                })
                            });

                            if (ttsResponse.ok) {
                                const audioBuffer = Buffer.from(await ttsResponse.arrayBuffer());
                                audioBase64 = audioBuffer.toString('base64');
                            }
                        }

                        // Enviar audio o texto
                        if (audioBase64) {
                            await wahaService.sendVoice(tenantId, chatId, audioBase64);
                            console.log(`   🔊 Respuesta de voz enviada`);
                        } else {
                            await wahaService.sendMessage(tenantId, chatId, aiResponse);
                            console.log(`   ✅ Respuesta enviada (fallback texto)`);
                        }
                    } catch (ttsError) {
                        console.error('⚠️ Error en TTS, enviando texto:', ttsError.message);
                        await wahaService.sendMessage(tenantId, chatId, aiResponse);
                    }
                } else {
                    await wahaService.sendMessage(tenantId, chatId, aiResponse);
                    console.log(`   ✅ Respuesta enviada`);
                }

            } catch (aiError) {
                console.error('❌ [WEBHOOK] Error procesando con IA:', aiError.message);
                await wahaService.sendMessage(
                    tenantId,
                    chatId,
                    '😅 Ups, tuve un problema procesando tu mensaje. ¿Puedes intentar de nuevo?'
                );
            }
        }

        res.status(200).send('OK');

    } catch (error) {
        console.error('❌ [WEBHOOK ERROR]:', error);
        res.status(500).send('Error procesando webhook');
    }
};

/* =================================================================== */
/* ==============   HELPER: PROCESAR CON IA (OPENAI)   =============== */
/* =================================================================== */

async function processWithAI(apiKey, tenantId, clientId, userMessage, conversationHistory, senderName = 'Cliente', phoneNumber = '', tenantName = 'nuestra peluquería') {
    // Obtener la fecha actual en Colombia para contexto
    const hoyStr = formatInTimeZone(new Date(), TIME_ZONE, "EEEE d 'de' MMMM 'de' yyyy", { locale: require('date-fns/locale/es') });

    const SYSTEM_PROMPT = `Eres un asistente virtual amigable de "${tenantName}" que responde por WhatsApp.
El cliente se llama ${senderName}. Usa su nombre para ser más personal.

FECHA ACTUAL: Hoy es ${hoyStr}. Usa esta información para interpretar fechas correctamente.

BIENVENIDA:
- Si el cliente SOLO saluda (ejemplo: "hola", "buenos días", "hi") → responde: "¡Hola ${senderName}! 👋 Bienvenido/a a ${tenantName}. ¿En qué te puedo ayudar?"
- Si el saludo incluye una solicitud (ejemplo: "Hola quiero un corte", "Buenos días, necesito cita") → NO des bienvenida genérica, procesa la solicitud directamente

FLUJO DE CONVERSACIÓN PARA AGENDAR:
1. Si el cliente menciona estilista + servicio + fecha + hora de una vez → verifica disponibilidad directamente
2. Si solo mencionan estilista sin servicio → consulta qué servicios ofrece
3. Si mencionan servicio pero no estilista → verifica disponibilidad y sugiere estilistas disponibles
4. SIEMPRE pide confirmación antes de agendar: "¿Confirmo tu cita de [servicio] con [estilista] el [fecha] a las [hora]?"
5. Solo agenda cuando el cliente diga "sí", "confirma", "dale", etc.

⚠️ REGLAS CRÍTICAS SOBRE SERVICIOS (MUY IMPORTANTE):
- NUNCA menciones un servicio sin antes llamar a listar_servicios o verificar_disponibilidad
- Si el cliente pide "corte", primero verifica que "corte" existe como servicio
- NO inventes servicios como "corte moderno", "peinado especial", etc. - solo los que devuelven las funciones
- Si el servicio no existe, usa listar_servicios y muestra las opciones
- Si el cliente pide algo que NO existe, di: "Ese servicio no lo tenemos. Nuestros servicios son: [lista]"

⚠️ REGLAS CRÍTICAS SOBRE DISPONIBILIDAD:
- Si preguntan "¿quién me puede atender hoy/a las X?" → usa verificar_disponibilidad para ver quién TRABAJA ese día/hora
- NO sugieras estilistas sin verificar primero que trabajan en esa fecha/hora
- Si nadie está disponible a esa hora, sugiere otras horas o estilistas

REGLAS IMPORTANTES:
- Sé EXPLÍCITO: cuando listes servicios de un estilista, di claramente "Estos son los servicios de [nombre]"
- No asumas lo que el cliente quiere - pregunta si no está claro
- Si falta información (servicio, fecha u hora), pregunta por ella
- NO pidas nombre ni teléfono - ya los tienes
- Respuestas claras y paso a paso

ESTILO:
- Español colombiano natural: "¡Listo!", "¡Claro que sí!", "Con mucho gusto"
- Emojis con moderación 💇✂️📅
- Máximo 2-3 oraciones por respuesta`;

    const FUNCTIONS = [
        {
            type: "function",
            function: {
                name: "listar_servicios",
                description: "Lista los servicios disponibles",
                parameters: { type: "object", properties: {}, required: [] }
            }
        },
        {
            type: "function",
            function: {
                name: "listar_estilistas",
                description: "Lista los estilistas que pueden atender un servicio específico",
                parameters: {
                    type: "object",
                    properties: {
                        servicio: { type: "string", description: "Nombre del servicio para filtrar estilistas que lo ofrecen (opcional)" }
                    },
                    required: []
                }
            }
        },
        {
            type: "function",
            function: {
                name: "obtener_servicios_estilista",
                description: "Obtiene los servicios que ofrece un estilista",
                parameters: {
                    type: "object",
                    properties: {
                        estilista: { type: "string", description: "Nombre del estilista" }
                    },
                    required: ["estilista"]
                }
            }
        },
        {
            type: "function",
            function: {
                name: "verificar_disponibilidad",
                description: "Verifica disponibilidad para un servicio en una fecha y hora específica",
                parameters: {
                    type: "object",
                    properties: {
                        servicio: { type: "string", description: "Nombre del servicio" },
                        estilista: { type: "string", description: "Nombre del estilista (opcional)" },
                        fecha: {
                            type: "string",
                            description: "Fecha deseada. Usar EXACTAMENTE las palabras del cliente: 'hoy', 'mañana', 'sábado', 'lunes', '21 de diciembre', etc. NO convertir a formato ISO, pasar el texto tal cual."
                        },
                        hora: {
                            type: "string",
                            description: "Hora deseada. Usar texto del cliente: '3pm', '15:00', '3 de la tarde', etc."
                        }
                    },
                    required: ["servicio"]
                }
            }
        },
        {
            type: "function",
            function: {
                name: "agendar_cita",
                description: "Agenda una cita confirmada por el cliente",
                parameters: {
                    type: "object",
                    properties: {
                        servicio: { type: "string", description: "Nombre del servicio" },
                        estilista: { type: "string", description: "Nombre del estilista" },
                        fecha: {
                            type: "string",
                            description: "Fecha confirmada. Usar palabras del cliente: 'hoy', 'mañana', 'sábado', '21 de diciembre'. NO convertir a ISO."
                        },
                        hora: {
                            type: "string",
                            description: "Hora confirmada: '3pm', '15:00', etc."
                        }
                    },
                    required: ["servicio", "fecha", "hora"]
                }
            }
        },
        {
            type: "function",
            function: {
                name: "listar_horarios_disponibles",
                description: "Lista los horarios disponibles de un estilista para una fecha específica",
                parameters: {
                    type: "object",
                    properties: {
                        estilista: { type: "string", description: "Nombre del estilista" },
                        fecha: {
                            type: "string",
                            description: "Fecha deseada: 'hoy', 'mañana', 'sábado', etc. NO convertir a ISO."
                        },
                        servicio: { type: "string", description: "Nombre del servicio (opcional, para calcular duración)" }
                    },
                    required: ["estilista", "fecha"]
                }
            }
        }
    ];

    const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...conversationHistory.slice(-10),
        { role: 'user', content: userMessage }
    ];

    // Primera llamada a OpenAI
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages,
            tools: FUNCTIONS,
            tool_choice: 'auto',
            temperature: 0.7,
            max_tokens: 300
        })
    });

    if (!response.ok) {
        throw new Error('Error de OpenAI');
    }

    const data = await response.json();
    const assistantMessage = data.choices[0].message;

    // Si hay function call, ejecutarla
    if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
        const toolCall = assistantMessage.tool_calls[0];
        const functionName = toolCall.function.name;
        const functionArgs = JSON.parse(toolCall.function.arguments || '{}');

        console.log(`   🔧 Ejecutando función: ${functionName}`);

        // Ejecutar la función
        const functionResult = await executeWhatsAppFunction(functionName, functionArgs, tenantId, clientId, senderName, phoneNumber);

        // Segunda llamada para formatear respuesta
        const followUpMessages = [
            ...messages,
            assistantMessage,
            { role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(functionResult) }
        ];

        const finalResponse = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages: followUpMessages,
                temperature: 0.7,
                max_tokens: 300
            })
        });

        if (!finalResponse.ok) {
            return functionResult.message || 'Operación completada.';
        }

        const finalData = await finalResponse.json();
        return finalData.choices[0].message.content;
    }

    return assistantMessage.content;
}

/* =================================================================== */
/* ==============   HELPER: EJECUTAR FUNCIONES   ===================== */
/* =================================================================== */

async function executeWhatsAppFunction(functionName, args, tenantId, clientId, senderName = 'Cliente', phoneNumber = '') {
    // Helpers
    const normalizeDateKeyword = (dateStr) => {
        if (!dateStr) return formatInTimeZone(new Date(), TIME_ZONE, 'yyyy-MM-dd');
        const s = String(dateStr).toLowerCase().trim();
        const now = new Date();
        const currentYear = now.getFullYear();
        const today = formatInTimeZone(now, TIME_ZONE, 'yyyy-MM-dd');
        const tomorrow = formatInTimeZone(new Date(now.getTime() + 86400000), TIME_ZONE, 'yyyy-MM-dd');

        if (s.includes('mañana')) return tomorrow;
        if (s.includes('hoy')) return today;

        // Días de la semana: "sábado", "lunes", etc.
        const diasSemana = {
            'domingo': 0, 'lunes': 1, 'martes': 2, 'miercoles': 3, 'miércoles': 3,
            'jueves': 4, 'viernes': 5, 'sabado': 6, 'sábado': 6
        };

        // Verificar si dice "próximo" o "proximo" - significa la semana que viene
        const isProximo = s.includes('próximo') || s.includes('proximo') || s.includes('siguiente');

        for (const [diaName, diaNum] of Object.entries(diasSemana)) {
            if (s.includes(diaName)) {
                const todayNum = now.getDay();
                let daysToAdd = diaNum - todayNum;

                if (isProximo) {
                    // "próximo martes" = siempre la semana que viene
                    if (daysToAdd <= 0) daysToAdd += 7;
                    daysToAdd += 7; // Agregar una semana más para "próximo"
                    // Pero si ya es mayor a 7, no agregar (ej: hoy lunes, próximo viernes = viernes de esta semana + 7)
                    if (daysToAdd > 13) daysToAdd -= 7;
                } else {
                    // Sin "próximo": si hoy es el día o ya pasó, ir al próximo
                    if (daysToAdd <= 0) daysToAdd += 7;
                }

                const targetDate = new Date(now.getTime() + daysToAdd * 86400000);
                console.log(`📅 [DATE] "${dateStr}" -> ${diaName} (${isProximo ? 'próximo' : 'este'}) = ${formatInTimeZone(targetDate, TIME_ZONE, 'yyyy-MM-dd')}`);
                return formatInTimeZone(targetDate, TIME_ZONE, 'yyyy-MM-dd');
            }
        }

        // Si ya es formato YYYY-MM-DD, verificar que no sea pasado
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
            if (s < today) {
                // Si la fecha es pasada, agregar un año
                const parts = s.split('-');
                return `${parseInt(parts[0]) + 1}-${parts[1]}-${parts[2]}`;
            }
            return s;
        }

        // Parsear fechas en español: "3 de enero", "15 de marzo", etc.
        const meses = {
            'enero': 1, 'febrero': 2, 'marzo': 3, 'abril': 4, 'mayo': 5, 'junio': 6,
            'julio': 7, 'agosto': 8, 'septiembre': 9, 'octubre': 10, 'noviembre': 11, 'diciembre': 12
        };

        // Buscar patrón: "3 de enero", "15 marzo", "enero 3"
        let day = null, month = null;

        for (const [mesName, mesNum] of Object.entries(meses)) {
            if (s.includes(mesName)) {
                month = mesNum;
                // Buscar el día
                const dayMatch = s.match(/(\d{1,2})/);
                if (dayMatch) {
                    day = parseInt(dayMatch[1], 10);
                }
                break;
            }
        }

        if (day && month) {
            let year = currentYear;
            // Crear la fecha propuesta
            const proposedDate = new Date(year, month - 1, day);
            // Si la fecha ya pasó, usar el próximo año
            if (proposedDate < now) {
                year = currentYear + 1;
            }
            const mm = String(month).padStart(2, '0');
            const dd = String(day).padStart(2, '0');
            return `${year}-${mm}-${dd}`;
        }

        // Si no se pudo parsear, devolver hoy
        console.log(`⚠️ normalizeDateKeyword: No pude parsear "${dateStr}", usando hoy: ${today}`);
        return today;
    };

    const normalizeHumanTime = (t) => {
        if (!t) return '10:00';
        let s = String(t).toLowerCase().replace(/\s+/g, '');
        // Corregir typos comunes: "pom" -> "pm", "a.m" -> "am", etc.
        s = s.replace(/pom/g, 'pm').replace(/aom/g, 'am').replace(/\./g, '');
        const m = s.match(/^(\d{1,2})(?::?(\d{2}))?(am|pm)?$/);
        if (!m) {
            console.log(`⚠️ [normalizeHumanTime] No pude parsear: "${t}" -> usando 10:00`);
            return '10:00';
        }
        let h = parseInt(m[1], 10);
        let mm = m[2] ? parseInt(m[2], 10) : 0;

        // 🕐 LÓGICA INTELIGENTE: Si no especifica am/pm
        // - Horas 1-7 sin am/pm → asumir PM (horario comercial peluquería)
        // - Horas 8-11 sin am/pm → asumir AM (apertura típica)
        // - Hora 12 sin am/pm → asumir PM (mediodía)
        if (!m[3]) {
            if (h >= 1 && h <= 7) {
                console.log(`   💡 [normalizeHumanTime] "${t}" sin am/pm, hora ${h} → asumiendo PM`);
                h += 12;
            } else if (h === 12) {
                // 12 sin am/pm = mediodía (12 PM)
                console.log(`   💡 [normalizeHumanTime] "${t}" sin am/pm, hora 12 → asumiendo PM (mediodía)`);
            }
            // Si es 8, 9, 10, 11 → se queda como AM (apertura)
        } else {
            if (m[3] === 'pm' && h < 12) h += 12;
            if (m[3] === 'am' && h === 12) h = 0;
        }

        const result = `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
        console.log(`   🕐 [normalizeHumanTime] "${t}" -> "${result}"`);
        return result;
    };

    // Helper: Verificar si un estilista trabaja en una fecha/hora específica
    const checkStylistWorksAtTime = (stylistWorkingHours, fecha, hora) => {
        if (!stylistWorkingHours) return true; // Si no tiene horario, asumir disponible

        try {
            const wh = typeof stylistWorkingHours === 'string'
                ? JSON.parse(stylistWorkingHours)
                : stylistWorkingHours;

            // Obtener día de la semana
            const [year, month, day] = fecha.split('-').map(Number);
            const fechaDate = new Date(year, month - 1, day);
            const dayNum = fechaDate.getDay();
            const dayNames = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
            const dayNamesEn = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
            const dayKey = dayNames[dayNum];
            const dayKeyEn = dayNamesEn[dayNum];

            // Buscar en español o inglés
            const schedule = wh[dayKey] || wh[dayKeyEn];
            if (!schedule) return false; // No trabaja ese día

            // Parsear horario
            let startWork, endWork;
            if (typeof schedule === 'object' && schedule.start) {
                startWork = schedule.start.replace(':', '');
                endWork = schedule.end.replace(':', '');
            } else if (typeof schedule === 'string' && schedule.includes('-')) {
                const [start, end] = schedule.split('-');
                startWork = start.replace(':', '');
                endWork = end.replace(':', '');
            } else {
                return true; // Formato no reconocido, asumir disponible
            }

            // Comparar hora solicitada
            if (hora) {
                const horaNum = hora.replace(':', '');
                if (horaNum < startWork || horaNum >= endWork) {
                    return false; // Fuera de horario
                }
            }

            return true;
        } catch (e) {
            console.warn('⚠️ Error verificando working_hours:', e.message);
            return true; // En caso de error, asumir disponible
        }
    };

    try {
        switch (functionName) {
            case 'listar_servicios': {
                const result = await db.query(
                    `SELECT name FROM services WHERE tenant_id = $1 ORDER BY name`,
                    [tenantId]
                );
                return {
                    success: true,
                    servicios: result.rows.map(s => s.name),
                    message: `Servicios disponibles: ${result.rows.map(s => s.name).join(', ')}`
                };
            }

            case 'listar_estilistas': {
                let result;
                if (args.servicio) {
                    // Buscar servicio primero
                    const svcResult = await db.query(
                        `SELECT id, name FROM services WHERE tenant_id = $1 AND LOWER(name) LIKE $2 LIMIT 1`,
                        [tenantId, `%${args.servicio.toLowerCase()}%`]
                    );

                    if (svcResult.rows.length === 0) {
                        return { success: false, message: `No encontré el servicio "${args.servicio}"` };
                    }

                    const servicioId = svcResult.rows[0].id;
                    const servicioName = svcResult.rows[0].name;

                    // Buscar estilistas que ofrecen este servicio
                    result = await db.query(
                        `SELECT u.first_name, u.last_name FROM users u
                         INNER JOIN stylist_services ss ON u.id = ss.user_id
                         WHERE u.tenant_id = $1 AND u.role_id = 3 
                         AND COALESCE(NULLIF(u.status,''),'active') = 'active'
                         AND ss.service_id = $2`,
                        [tenantId, servicioId]
                    );

                    if (result.rows.length === 0) {
                        return { success: false, message: `No hay estilistas que ofrezcan ${servicioName}` };
                    }

                    const nombres = result.rows.map(u => `${u.first_name} ${u.last_name || ''}`.trim());
                    return {
                        success: true,
                        estilistas: nombres,
                        servicio: servicioName,
                        message: `Estilistas que ofrecen ${servicioName}: ${nombres.join(', ')}`
                    };
                } else {
                    // Sin servicio, listar todos
                    result = await db.query(
                        `SELECT first_name, last_name FROM users 
                         WHERE tenant_id = $1 AND role_id = 3 AND COALESCE(NULLIF(status,''),'active') = 'active'`,
                        [tenantId]
                    );
                    const nombres = result.rows.map(u => `${u.first_name} ${u.last_name || ''}`.trim());
                    return { success: true, estilistas: nombres, message: `Estilistas: ${nombres.join(', ')}` };
                }
            }

            case 'obtener_servicios_estilista': {
                const stylistResult = await db.query(
                    `SELECT id, first_name, last_name FROM users 
                     WHERE tenant_id = $1 AND role_id = 3 
                     AND (LOWER(first_name) LIKE $2 OR LOWER(CONCAT(first_name, ' ', last_name)) LIKE $2)
                     LIMIT 1`,
                    [tenantId, `%${(args.estilista || '').toLowerCase()}%`]
                );

                if (stylistResult.rows.length === 0) {
                    return { success: false, message: `No encontré a ${args.estilista}` };
                }

                const stylist = stylistResult.rows[0];
                const servicesResult = await db.query(
                    `SELECT s.name FROM services s
                     INNER JOIN stylist_services ss ON s.id = ss.service_id
                     WHERE ss.user_id = $1`,
                    [stylist.id]
                );

                const nombre = `${stylist.first_name} ${stylist.last_name || ''}`.trim();
                const servicios = servicesResult.rows.map(s => s.name);
                return {
                    success: true,
                    estilista: nombre,
                    servicios,
                    message: `${nombre} ofrece: ${servicios.join(', ')}`
                };
            }

            case 'verificar_disponibilidad': {
                console.log(`   📅 [DEBUG] args.fecha recibido de GPT: "${args.fecha}"`);
                const fecha = normalizeDateKeyword(args.fecha);
                console.log(`   📅 [DEBUG] fecha normalizada: "${fecha}"`);
                const hora = args.hora ? normalizeHumanTime(args.hora) : null;
                console.log(`   📅 [DEBUG] args.hora: "${args.hora}" -> hora normalizada: "${hora}"`);

                const svcResult = await db.query(
                    `SELECT id, name, duration_minutes FROM services 
                     WHERE tenant_id = $1 AND LOWER(name) LIKE $2 LIMIT 1`,
                    [tenantId, `%${(args.servicio || '').toLowerCase()}%`]
                );

                if (svcResult.rows.length === 0) {
                    return { success: false, message: `No encontré el servicio "${args.servicio}"` };
                }

                const servicio = svcResult.rows[0];

                // Buscar TODOS los estilistas que ofrecen el servicio (con working_hours)
                let queryParams = [tenantId, servicio.id];
                let stylistCondition = '';
                if (args.estilista) {
                    stylistCondition = `AND (LOWER(u.first_name) LIKE $3 OR LOWER(CONCAT(u.first_name, ' ', u.last_name)) LIKE $3)`;
                    queryParams.push(`%${args.estilista.toLowerCase()}%`);
                }

                const stylistsResult = await db.query(
                    `SELECT u.id, u.first_name, u.last_name, u.working_hours FROM users u
                     INNER JOIN stylist_services ss ON u.id = ss.user_id
                     WHERE u.tenant_id = $1 AND ss.service_id = $2 AND u.role_id = 3
                     AND COALESCE(u.status, 'active') = 'active'
                     ${stylistCondition}`,
                    queryParams
                );

                if (stylistsResult.rows.length === 0) {
                    return { success: false, message: `No hay estilistas que ofrezcan ${servicio.name}` };
                }

                // Filtrar estilistas que trabajan en la fecha/hora solicitada
                const estilistasQueTrabajan = stylistsResult.rows.filter(s =>
                    checkStylistWorksAtTime(s.working_hours, fecha, hora)
                );

                console.log(`   👥 [DEBUG] Estilistas que trabajan el ${fecha}${hora ? ` a las ${hora}` : ''}: ${estilistasQueTrabajan.map(s => s.first_name).join(', ') || 'ninguno'}`);

                if (estilistasQueTrabajan.length === 0) {
                    const todosNombres = stylistsResult.rows.map(s => s.first_name).join(', ');
                    return {
                        success: false,
                        message: `❌ Ningún estilista trabaja a esa hora. Los que ofrecen ${servicio.name} son: ${todosNombres}. ¿Quieres consultar sus horarios?`
                    };
                }

                // Validar que la hora no sea en el pasado si es hoy
                if (hora) {
                    const nowInBogota = formatInTimeZone(new Date(), TIME_ZONE, 'yyyy-MM-dd HH:mm');
                    const [todayDate, nowTime] = nowInBogota.split(' ');

                    if (fecha === todayDate && hora < nowTime) {
                        return {
                            success: false,
                            message: `⏰ Las ${hora} ya pasaron. Son las ${nowTime.slice(0, 5)}. ¿A qué hora te gustaría?`
                        };
                    }

                    const startTime = zonedTimeToUtc(`${fecha} ${hora}:00`, TIME_ZONE);
                    const endTime = new Date(startTime.getTime() + servicio.duration_minutes * 60000);

                    // Buscar estilistas SIN conflicto de citas
                    const estilistasDisponibles = [];
                    for (const stylist of estilistasQueTrabajan) {
                        const conflict = await db.query(
                            `SELECT id FROM appointments 
                             WHERE tenant_id = $1 AND stylist_id = $2 
                             AND status IN ('scheduled','rescheduled','checked_in')
                             AND (start_time, end_time) OVERLAPS ($3::timestamptz, $4::timestamptz)`,
                            [tenantId, stylist.id, startTime, endTime]
                        );

                        if (conflict.rows.length === 0) {
                            estilistasDisponibles.push({
                                id: stylist.id,
                                nombre: `${stylist.first_name} ${stylist.last_name || ''}`.trim()
                            });
                        }
                    }

                    if (estilistasDisponibles.length === 0) {
                        const nombresQueTrabajan = estilistasQueTrabajan.map(s => s.first_name).join(', ');
                        return {
                            success: true,
                            available: false,
                            message: `❌ Todos los estilistas que trabajan a esa hora (${nombresQueTrabajan}) ya tienen citas. ¿Quieres otra hora?`
                        };
                    }

                    if (estilistasDisponibles.length === 1) {
                        return {
                            success: true,
                            available: true,
                            servicio: servicio.name,
                            estilista: estilistasDisponibles[0].nombre,
                            fecha,
                            hora,
                            message: `✅ ${estilistasDisponibles[0].nombre} está disponible el ${fecha} a las ${hora} para ${servicio.name}. ¿Confirmo la cita?`
                        };
                    }

                    // Múltiples disponibles - listar
                    const nombres = estilistasDisponibles.map(s => s.nombre).join(', ');
                    return {
                        success: true,
                        available: true,
                        servicio: servicio.name,
                        estilistas_disponibles: nombres,
                        fecha,
                        hora,
                        message: `✅ Para ${servicio.name} el ${fecha} a las ${hora} están disponibles: ${nombres}. ¿Con cuál prefieres?`
                    };
                }

                // Sin hora específica - listar estilistas que trabajan ese día
                const nombres = estilistasQueTrabajan.map(s => `${s.first_name} ${s.last_name || ''}`.trim()).join(', ');
                return {
                    success: true,
                    servicio: servicio.name,
                    estilistas_disponibles: nombres,
                    fecha,
                    message: `Para ${servicio.name} el ${fecha} pueden atenderte: ${nombres}. ¿A qué hora te gustaría?`
                };
            }

            case 'agendar_cita': {
                // Si no hay clientId, crear cliente automáticamente con datos de WAHA
                let finalClientId = clientId;
                if (!finalClientId && phoneNumber) {
                    console.log(`   👤 Creando cliente: ${senderName} (${phoneNumber})`);
                    try {
                        // Buscar si ya existe por teléfono
                        const existingClient = await db.query(
                            `SELECT id FROM users WHERE tenant_id = $1 AND role_id = 4 AND phone LIKE $2 LIMIT 1`,
                            [tenantId, `%${phoneNumber.slice(-10)}%`]
                        );
                        if (existingClient.rows.length > 0) {
                            finalClientId = existingClient.rows[0].id;
                        } else {
                            // Crear cliente nuevo
                            const newClient = await db.query(
                                `INSERT INTO users (tenant_id, role_id, first_name, last_name, email, password_hash, phone)
                                 VALUES ($1, 4, $2, '', $3, 'whatsapp', $4)
                                 RETURNING id`,
                                [tenantId, senderName, `${phoneNumber}@whatsapp.temp`, phoneNumber]
                            );
                            finalClientId = newClient.rows[0].id;
                            console.log(`   ✅ Cliente creado: ID ${finalClientId}`);
                        }
                    } catch (createErr) {
                        console.error('   ❌ Error creando cliente:', createErr.message);
                        return { success: false, message: 'Hubo un problema registrando tus datos. Por favor intenta de nuevo.' };
                    }
                }

                if (!finalClientId) {
                    return { success: false, message: 'No pude obtener tus datos. Por favor intenta de nuevo.' };
                }

                console.log(`   📅 [DEBUG agendar] args.fecha: "${args.fecha}", args.hora: "${args.hora}"`);
                const fecha = normalizeDateKeyword(args.fecha);
                const hora = normalizeHumanTime(args.hora);
                console.log(`   📅 [DEBUG agendar] fecha normalizada: "${fecha}", hora: "${hora}"`);

                const svcResult = await db.query(
                    `SELECT id, name, duration_minutes FROM services WHERE tenant_id = $1 AND LOWER(name) LIKE $2 LIMIT 1`,
                    [tenantId, `%${(args.servicio || '').toLowerCase()}%`]
                );

                if (svcResult.rows.length === 0) {
                    return { success: false, message: `No encontré el servicio` };
                }

                const servicio = svcResult.rows[0];

                let queryParams = [tenantId, servicio.id];
                let stylistCondition = '';
                if (args.estilista) {
                    // Buscar por nombre O nombre completo (igual que verificar_disponibilidad)
                    stylistCondition = `AND (LOWER(u.first_name) LIKE $3 OR LOWER(CONCAT(u.first_name, ' ', u.last_name)) LIKE $3)`;
                    queryParams.push(`%${args.estilista.toLowerCase()}%`);
                }

                const stylistResult = await db.query(
                    `SELECT u.id, u.first_name, u.last_name FROM users u
                     INNER JOIN stylist_services ss ON u.id = ss.user_id
                     WHERE u.tenant_id = $1 AND ss.service_id = $2 AND u.role_id = 3
                     AND COALESCE(u.status, 'active') = 'active'
                     ${stylistCondition} LIMIT 1`,
                    queryParams
                );

                if (stylistResult.rows.length === 0) {
                    const estilistaNombre = args.estilista || 'ninguno especificado';
                    return { success: false, message: `No hay estilistas disponibles para este servicio${args.estilista ? ` (${estilistaNombre})` : ''}. ¿Quieres ver los estilistas disponibles?` };
                }

                const estilista = stylistResult.rows[0];
                const nombreEstilista = `${estilista.first_name} ${estilista.last_name || ''}`.trim();

                // Validar que la hora no sea en el pasado si es hoy
                const nowInBogota = formatInTimeZone(new Date(), TIME_ZONE, 'yyyy-MM-dd HH:mm');
                const [todayDate, nowTime] = nowInBogota.split(' ');

                if (fecha === todayDate && hora < nowTime) {
                    return {
                        success: false,
                        message: `⏰ Las ${hora} ya pasaron. Son las ${nowTime.slice(0, 5)}. ¿A qué hora te gustaría agendar?`
                    };
                }

                const startTime = zonedTimeToUtc(`${fecha} ${hora}:00`, TIME_ZONE);
                const endTime = new Date(startTime.getTime() + servicio.duration_minutes * 60000);

                // Verificar conflictos de horario antes de agendar
                const conflict = await db.query(
                    `SELECT id FROM appointments 
                     WHERE tenant_id = $1 AND stylist_id = $2 
                     AND status IN ('scheduled','rescheduled','checked_in')
                     AND (start_time, end_time) OVERLAPS ($3::timestamptz, $4::timestamptz)`,
                    [tenantId, estilista.id, startTime, endTime]
                );

                if (conflict.rows.length > 0) {
                    return {
                        success: false,
                        message: `❌ ${nombreEstilista} ya tiene una cita a esa hora. ¿Quieres otra hora o probar con otro estilista?`
                    };
                }

                const appointmentResult = await db.query(
                    `INSERT INTO appointments (tenant_id, client_id, stylist_id, service_id, start_time, end_time, status)
                     VALUES ($1, $2, $3, $4, $5, $6, 'scheduled')
                     RETURNING id`,
                    [tenantId, finalClientId, estilista.id, servicio.id, startTime, endTime]
                );

                // 📡 Emitir evento WebSocket para actualizar calendario en tiempo real
                try {
                    const io = getIO();
                    io.to(`tenant:${tenantId}`).emit('appointment:created', {
                        id: appointmentResult.rows[0].id,
                        clientId: finalClientId,
                        clientName: senderName,
                        stylistId: estilista.id,
                        stylistName: nombreEstilista,
                        serviceId: servicio.id,
                        serviceName: servicio.name,
                        startTime: startTime.toISOString(),
                        endTime: endTime.toISOString(),
                        status: 'scheduled',
                        createdVia: 'whatsapp'
                    });
                    console.log(`   📡 [SOCKET] Evento appointment:created emitido para tenant ${tenantId}`);
                } catch (socketErr) {
                    console.log(`   ⚠️ [SOCKET] No se pudo emitir evento:`, socketErr.message);
                }

                return {
                    success: true,
                    message: `🎉 ¡Cita agendada!\n📅 ${fecha} a las ${hora}\n💇 ${servicio.name}\n👤 ${nombreEstilista}\n\n¡Te esperamos!`
                };
            }

            case 'listar_horarios_disponibles': {
                const fecha = normalizeDateKeyword(args.fecha);
                console.log(`   📅 [DEBUG horarios] fecha: "${args.fecha}" -> "${fecha}"`);

                // Buscar estilista
                const stylistResult = await db.query(
                    `SELECT id, first_name, last_name, working_hours FROM users 
                     WHERE tenant_id = $1 AND role_id = 3 
                     AND (LOWER(first_name) LIKE $2 OR LOWER(CONCAT(first_name, ' ', last_name)) LIKE $2)
                     LIMIT 1`,
                    [tenantId, `%${(args.estilista || '').toLowerCase()}%`]
                );

                if (stylistResult.rows.length === 0) {
                    return { success: false, message: `No encontré al estilista "${args.estilista}"` };
                }

                const stylist = stylistResult.rows[0];
                const nombreEstilista = `${stylist.first_name} ${stylist.last_name || ''}`.trim();

                // Obtener duración del servicio (si se proporciona) o usar 60 min por defecto
                let duracion = 60;
                if (args.servicio) {
                    const svcResult = await db.query(
                        `SELECT duration_minutes FROM services WHERE tenant_id = $1 AND LOWER(name) LIKE $2 LIMIT 1`,
                        [tenantId, `%${args.servicio.toLowerCase()}%`]
                    );
                    if (svcResult.rows.length > 0) {
                        duracion = svcResult.rows[0].duration_minutes || 60;
                    }
                }

                // Obtener horarios del tenant
                const tenantResult = await db.query('SELECT working_hours FROM tenants WHERE id = $1', [tenantId]);
                const tenantWH = tenantResult.rows[0]?.working_hours || {};

                // Calcular día de la semana (añadiendo T00:00:00 para evitar problemas de timezone)
                const [year, month, day] = fecha.split('-').map(Number);
                const fechaDate = new Date(year, month - 1, day);
                const diasSemana = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
                const dayName = diasSemana[fechaDate.getDay()];
                console.log(`   📅 [DEBUG horarios] fecha=${fecha}, dayName=${dayName}`);

                // Helper para parsear horarios en diferentes formatos
                const parseSchedule = (schedule) => {
                    if (!schedule) return null;
                    // Formato objeto: { start: '07:00', end: '20:00' }
                    if (typeof schedule === 'object' && schedule.start) {
                        return schedule;
                    }
                    // Formato string: '07:00-20:00'
                    if (typeof schedule === 'string' && schedule.includes('-')) {
                        const [start, end] = schedule.split('-');
                        return { start, end };
                    }
                    return null;
                };

                // Obtener rango de horas: primero del estilista, luego del tenant
                let daySchedule = null;
                const stylistWH = stylist.working_hours;

                if (stylistWH && stylistWH[dayName]) {
                    daySchedule = parseSchedule(stylistWH[dayName]);
                }
                if (!daySchedule && tenantWH && tenantWH[dayName]) {
                    daySchedule = parseSchedule(tenantWH[dayName]);
                }

                if (!daySchedule || !daySchedule.start) {
                    console.log(`   ⚠️ [DEBUG horarios] No hay horario para ${dayName}. stylistWH:`, stylistWH, 'tenantWH:', tenantWH);
                    return { success: false, message: `${nombreEstilista} no trabaja el ${dayName === 'saturday' ? 'sábado' : dayName === 'sunday' ? 'domingo' : dayName}. ¿Quieres otro día?` };
                }

                console.log(`   ✅ [DEBUG horarios] Horario encontrado: ${daySchedule.start} - ${daySchedule.end}`);

                // Obtener citas existentes para ese día
                const existingAppts = await db.query(
                    `SELECT start_time, end_time FROM appointments 
                     WHERE stylist_id = $1 
                     AND DATE(start_time AT TIME ZONE 'America/Bogota') = $2
                     AND status IN ('scheduled','rescheduled','checked_in')`,
                    [stylist.id, fecha]
                );

                // Generar slots disponibles
                const [startHour, startMin] = daySchedule.start.split(':').map(Number);
                const [endHour, endMin] = daySchedule.end.split(':').map(Number);
                const slots = [];

                for (let h = startHour; h < endHour || (h === endHour && 0 < endMin); h++) {
                    for (let m = 0; m < 60; m += 30) {
                        if (h === startHour && m < startMin) continue;
                        if (h === endHour && m >= endMin) break;

                        const slotTime = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
                        const slotStart = new Date(`${fecha}T${slotTime}:00`);
                        const slotEnd = new Date(slotStart.getTime() + duracion * 60000);

                        // 🛑 FILTRO DE HORA PASADA (fix)
                        // Si la fecha es hoy, verificar que la hora del slot sea mayor a la hora actual + buffer
                        const nowInBogota = formatInTimeZone(new Date(), TIME_ZONE, 'yyyy-MM-dd HH:mm');
                        const [todayDate, nowTimeStr] = nowInBogota.split(' ');

                        if (fecha === todayDate) {
                            // Comparar strings "HH:MM" es seguro porque son formato 24h paddeado
                            if (slotTime < nowTimeStr) {
                                continue; // Saltar hora pasada
                            }
                        }

                        // Verificar si el slot está ocupado
                        const isOccupied = existingAppts.rows.some(a => {
                            const aStart = new Date(a.start_time);
                            const aEnd = new Date(a.end_time);
                            //                            return (slotStart < aEnd && slotEnd > aStart) || 
                            //                                   (slotStart.getTime() === aStart.getTime()); 
                            return slotStart < aEnd && slotEnd > aStart;
                        });

                        if (!isOccupied) {
                            slots.push(slotTime);
                        }
                    }
                }

                if (slots.length === 0) {
                    return { success: false, message: `${nombreEstilista} no tiene horarios disponibles para el ${fecha}` };
                }

                // Formatear horarios para mostrar
                const horariosFormateados = slots.slice(0, 10).map(s => {
                    const [h, m] = s.split(':').map(Number);
                    const ampm = h >= 12 ? 'pm' : 'am';
                    const h12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
                    return `${h12}:${String(m).padStart(2, '0')}${ampm}`;
                });

                return {
                    success: true,
                    estilista: nombreEstilista,
                    fecha,
                    horarios: slots,
                    message: `Horarios disponibles de ${nombreEstilista} para el ${fecha}:\n${horariosFormateados.join(', ')}${slots.length > 10 ? ' (y más)' : ''}`
                };
            }

            default:
                return { success: false, message: 'Función no reconocida' };
        }
    } catch (error) {
        console.error(`❌ Error en función ${functionName}:`, error);
        return { success: false, message: 'Error procesando la solicitud' };
    }
}

/* =================================================================== */
/* ==============   3. DISCONNECT / CLOSE SESSION   ================== */
/* =================================================================== */

exports.disconnect = async (req, res) => {
    const { tenantId } = req.body;

    if (!tenantId) return res.status(400).json({ error: 'Falta tenantId' });

    console.log(`🔌 [WHATSAPP] Desconectando tenant: ${tenantId}`);

    try {
        await wahaService.deleteSession(tenantId);

        await db.query(
            `UPDATE tenant_numbers 
             SET provider = 'disconnected', phone_number_id = 'disconnected', display_phone_number = '', updated_at = NOW()
             WHERE tenant_id = $1`,
            [tenantId]
        );

        // Limpiar cache de conversación
        for (const key of conversationCache.keys()) {
            if (key.startsWith(tenantId)) {
                conversationCache.delete(key);
            }
        }

        return res.json({ success: true, message: 'Desconectado correctamente.' });

    } catch (error) {
        console.error('Error al desconectar:', error);
        res.status(200).json({ success: true, message: 'Desconexión forzada.' });
    }
};