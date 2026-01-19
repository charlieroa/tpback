'use strict';

const db = require('../config/db');
const wahaService = require('../services/wahaService');
const { formatInTimeZone } = require('date-fns-tz');
const { getIO } = require('../socket');

console.log('🚀 [DEBUG] whatsappController.js cargado v7 (Flujo Corregido: Servicio → Fecha → Estilista)');

const TIME_ZONE = 'America/Bogota';

// Cache para historial de conversación
const conversationCache = new Map();

// Cache para datos de reserva en progreso
const bookingContextCache = new Map();

/* =================================================================== */
/* ==============   1. GET STATUS / QR IMAGE (GET)   ================= */
/* =================================================================== */

exports.getStatus = async (req, res) => {
    const { tenantId } = req.params;

    if (!tenantId) return res.status(400).json({ error: 'Falta tenantId en la URL' });

    try {
        let sessionStatus = await wahaService.getSessionStatus(tenantId);

        if (!sessionStatus) {
            console.log(`🆕 Sesión ${tenantId} no existe. Creando...`);
            await wahaService.startSession(tenantId);
            return res.json({ status: 'LOADING' });
        }

        const status = String(sessionStatus.status).toLowerCase();

        if (status === 'working' || status === 'authenticated') {
            return res.json({ status: 'CONNECTED' });
        }

        if (status === 'scan_qr_code') {
            const qrImageBase64 = await wahaService.getQrRawData(tenantId);
            if (qrImageBase64) {
                return res.json({ status: 'QR_READY', qr: qrImageBase64 });
            }
            return res.json({ status: 'LOADING' });
        }

        if (status === 'failed') {
            await wahaService.deleteSession(tenantId);
            return res.json({ status: 'LOADING', message: 'Reparando sesión...' });
        }

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

                await db.query(
                    `UPDATE tenant_numbers
                     SET provider = 'disconnected', phone_number_id = 'disconnected', display_phone_number = ''
                     WHERE phone_number_id = $1 AND tenant_id != $2`,
                    [cleanNumber, tenantId]
                );

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

            if (payload.fromMe) {
                return res.status(200).send('OK');
            }

            const messageType = payload.type || payload._data?.type;
            const chatId = payload.from;
            let userMessage = payload.body;
            let isVoiceMessage = false;

            const phoneNumber = chatId.split('@')[0];

            let notifyName = payload.notifyName
                || payload._data?.notifyName
                || payload.pushName
                || payload._data?.pushName
                || '';

            console.log(`   📋 [PAYLOAD DEBUG] notifyName: "${notifyName}"`);

            // ==========================================
            // GESTIÓN DE CLIENTE
            // ==========================================
            let clientId = null;
            let senderName = notifyName || 'Cliente';

            try {
                const existingClient = await db.query(
                    `SELECT id, first_name, last_name FROM users
                     WHERE tenant_id = $1 AND phone = $2 AND role_id = 4`,
                    [tenantId, phoneNumber]
                );

                if (existingClient.rows.length > 0) {
                    clientId = existingClient.rows[0].id;
                    const savedFirstName = existingClient.rows[0].first_name;
                    const savedLastName = existingClient.rows[0].last_name;

                    const invalidNames = ['cliente', 'hola', 'buenos días', 'buenas tardes', 'buenas noches', 'hi', 'hello'];
                    if (savedFirstName &&
                        savedFirstName.length >= 2 &&
                        !/^\d+$/.test(savedFirstName) &&
                        !invalidNames.includes(savedFirstName.toLowerCase())) {
                        senderName = savedLastName && savedLastName.length >= 2
                            ? `${savedFirstName} ${savedLastName}`.trim()
                            : savedFirstName;
                        console.log(`   ✅ [NOMBRE] Usando nombre guardado: ${senderName}`);
                    }
                } else {
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

                if (clientId && notifyName && notifyName.length >= 2) {
                    const invalidNames = ['cliente', 'hola', 'hi', 'hello'];
                    if (!invalidNames.includes(notifyName.toLowerCase())) {
                        await db.query(
                            `UPDATE users SET first_name = $1, updated_at = NOW() WHERE id = $2 AND first_name IN ('Cliente', 'cliente', '')`,
                            [notifyName, clientId]
                        );
                    }
                }

                console.log(`   👤 Cliente: ${senderName} | ID: ${clientId || 'nuevo'}`);

            } catch (clientError) {
                console.error('   ⚠️ [CLIENTE] Error:', clientError.message);
            }

            // Manejar notas de voz
            if (messageType === 'ptt' || messageType === 'audio') {
                console.log(`\n🎤 [AUDIO] De: ${senderName} (${chatId})`);
                isVoiceMessage = true;

                try {
                    const apiKeyResult = await db.query(
                        'SELECT openai_api_key FROM tenants WHERE id = $1',
                        [tenantId]
                    );
                    const apiKey = apiKeyResult.rows[0]?.openai_api_key;

                    if (apiKey) {
                        const axios = require('axios');
                        let audioBuffer = null;

                        const WAHA_URL = process.env.WAHA_URL || 'http://212.28.189.253:3002';
                        const WAHA_API_KEY = process.env.WAHA_API_KEY || '';

                        if (payload.media?.url) {
                            try {
                                let mediaUrl = payload.media.url;
                                if (mediaUrl.includes('localhost:3000')) {
                                    mediaUrl = mediaUrl.replace('http://localhost:3000', WAHA_URL);
                                }
                                if (mediaUrl.includes('0.0.0.0:3000')) {
                                    mediaUrl = mediaUrl.replace('http://0.0.0.0:3000', WAHA_URL);
                                }
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

                        if (!audioBuffer && payload.id) {
                            try {
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

                        if (!audioBuffer && payload._data?.body) {
                            try {
                                audioBuffer = Buffer.from(payload._data.body, 'base64');
                            } catch (b64Error) {
                                console.log(`   ⚠️ Base64 falló: ${b64Error.message}`);
                            }
                        }

                        if (!audioBuffer) {
                            await wahaService.sendMessage(tenantId, chatId, '🎤 No pude acceder a tu nota de voz. ¿Puedes escribirme?');
                            return res.status(200).send('OK');
                        }

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
                        await wahaService.sendMessage(tenantId, chatId, '🎤 No puedo procesar notas de voz en este momento.');
                        return res.status(200).send('OK');
                    }
                } catch (voiceError) {
                    console.error('❌ Error procesando audio:', voiceError.message);
                    await wahaService.sendMessage(tenantId, chatId, '😅 Hubo un problema con tu nota de voz. ¿Puedes escribirme?');
                    return res.status(200).send('OK');
                }
            } else if (messageType !== 'chat' || !payload.body) {
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
                console.log('⚠️ [WEBHOOK] No hay API Key configurada');
                await wahaService.sendMessage(
                    tenantId,
                    chatId,
                    '⚠️ El asistente no está configurado. Contacta al administrador.'
                );
                return res.status(200).send('OK');
            }

            const apiKey = tenantResult.rows[0].openai_api_key;
            const tenantName = tenantResult.rows[0].name || 'nuestra peluquería';

            // Obtener historial y contexto de reserva
            const cacheKey = `${tenantId}:${chatId}`;
            let conversationHistory = conversationCache.get(cacheKey) || [];
            let bookingContext = bookingContextCache.get(cacheKey) || {};

            // Reinicio de conversación
            const simpleGreetings = /^(hola|buenos días|buenas tardes|buenas noches|hi|hey|hello|ola)[\s!.]*$/i;
            const resetCommands = /(empezar de nuevo|cancelar|reset|reiniciar|nueva cita|otro servicio)/i;

            if ((simpleGreetings.test(userMessage.trim()) || resetCommands.test(userMessage.trim())) && conversationHistory.length > 0) {
                console.log(`🔄 [REINICIO] Limpiando conversación para ${senderName}`);
                conversationHistory = [];
                bookingContext = {};
                conversationCache.set(cacheKey, conversationHistory);
                bookingContextCache.set(cacheKey, bookingContext);
            }

            try {
                const result = await processWithAI(
                    apiKey,
                    tenantId,
                    clientId,
                    userMessage,
                    conversationHistory,
                    bookingContext,
                    senderName,
                    tenantName
                );

                // Actualizar contexto
                if (result.updatedContext) {
                    bookingContext = { ...bookingContext, ...result.updatedContext };
                    bookingContextCache.set(cacheKey, bookingContext);
                    console.log(`   📝 [CONTEXTO]:`, JSON.stringify(bookingContext));
                }

                // Si se agendó, limpiar contexto
                if (result.updatedContext?.booked) {
                    bookingContextCache.set(cacheKey, {});
                }

                conversationHistory.push({ role: 'user', content: userMessage });
                conversationHistory.push({ role: 'assistant', content: result.response });

                if (conversationHistory.length > 20) {
                    conversationHistory = conversationHistory.slice(-20);
                }
                conversationCache.set(cacheKey, conversationHistory);

                // Responder
                if (isVoiceMessage && apiKey) {
                    try {
                        let audioBase64 = null;

                        const tenantVoice = await db.query(
                            'SELECT elevenlabs_api_key, elevenlabs_voice_id FROM tenants WHERE id = $1',
                            [tenantId]
                        );
                        const elevenLabsKey = tenantVoice.rows[0]?.elevenlabs_api_key;
                        const voiceId = tenantVoice.rows[0]?.elevenlabs_voice_id || 'pNInz6obpgDQGcFmaJgB';

                        if (elevenLabsKey) {
                            const elevenLabsResponse = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
                                method: 'POST',
                                headers: {
                                    'xi-api-key': elevenLabsKey,
                                    'Content-Type': 'application/json'
                                },
                                body: JSON.stringify({
                                    text: result.response,
                                    model_id: 'eleven_multilingual_v2',
                                    voice_settings: { stability: 0.5, similarity_boost: 0.75 }
                                })
                            });

                            if (elevenLabsResponse.ok) {
                                const audioBuffer = Buffer.from(await elevenLabsResponse.arrayBuffer());
                                audioBase64 = audioBuffer.toString('base64');
                            }
                        }

                        if (!audioBase64) {
                            const ttsResponse = await fetch('https://api.openai.com/v1/audio/speech', {
                                method: 'POST',
                                headers: {
                                    'Authorization': `Bearer ${apiKey}`,
                                    'Content-Type': 'application/json'
                                },
                                body: JSON.stringify({
                                    model: 'tts-1-hd',
                                    voice: 'alloy',
                                    input: result.response,
                                    response_format: 'opus'
                                })
                            });

                            if (ttsResponse.ok) {
                                const audioBuffer = Buffer.from(await ttsResponse.arrayBuffer());
                                audioBase64 = audioBuffer.toString('base64');
                            }
                        }

                        if (audioBase64) {
                            await wahaService.sendVoice(tenantId, chatId, audioBase64);
                            console.log(`   🔊 Respuesta de voz enviada`);
                        } else {
                            await wahaService.sendMessage(tenantId, chatId, result.response);
                        }
                    } catch (ttsError) {
                        console.error('⚠️ Error en TTS:', ttsError.message);
                        await wahaService.sendMessage(tenantId, chatId, result.response);
                    }
                } else {
                    await wahaService.sendMessage(tenantId, chatId, result.response);
                    console.log(`   ✅ Respuesta enviada`);
                }

            } catch (aiError) {
                console.error('❌ [WEBHOOK] Error IA:', aiError.message);
                await wahaService.sendMessage(
                    tenantId,
                    chatId,
                    '😅 Tuve un problema. ¿Puedes intentar de nuevo?'
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

async function processWithAI(apiKey, tenantId, clientId, userMessage, conversationHistory, bookingContext, senderName, tenantName) {
    const hoyStr = formatInTimeZone(new Date(), TIME_ZONE, "EEEE d 'de' MMMM 'de' yyyy", { locale: require('date-fns/locale/es') });

    // Contexto actual de la reserva - SOLO mostrar datos CONFIRMADOS
    let contextInfo = '';
    if (Object.keys(bookingContext).length > 0) {
        const parts = [];
        if (bookingContext.service_confirmed) parts.push(`✅ Servicio CONFIRMADO: ${bookingContext.service}`);
        if (bookingContext.date) parts.push(`- Fecha: ${bookingContext.date}`);
        if (bookingContext.time) parts.push(`- Hora: ${bookingContext.time}`);
        if (bookingContext.stylist) parts.push(`- Estilista: ${bookingContext.stylist}`);
        if (parts.length > 0) {
            contextInfo = `\n\n📋 DATOS DE LA RESERVA EN PROGRESO:\n${parts.join('\n')}`;
        }
    }

    // =====================================================
    // 🔴 SYSTEM PROMPT v7 - FLUJO ESTRICTO
    // =====================================================
    const SYSTEM_PROMPT = `Eres el asistente de "${tenantName}" en WhatsApp. Cliente: ${senderName}.
Hoy: ${hoyStr}.${contextInfo}

FUNCIÓN: "consultar_orquestador" - DEBES usarla para TODO sobre servicios y citas.

═══════════════════════════════════════════════════════════════
🔴 REGLA CRÍTICA #1: SIEMPRE VERIFICA EL SERVICIO PRIMERO
═══════════════════════════════════════════════════════════════
Cuando el usuario mencione CUALQUIER servicio (corte, manicure, etc.):
1. INMEDIATAMENTE llama al orquestador con solo el servicio
2. NO preguntes fecha/hora hasta que el servicio esté 100% confirmado
3. Si hay múltiples opciones → muéstralas y espera que elija
4. SOLO cuando el servicio sea único/confirmado → pregunta fecha

EJEMPLO CORRECTO:
- Usuario: "quiero un corte"
- Tú: [llamas orquestador con service="corte"]
- Orquestador: disambiguation_needed (Corte Caballero, Barba más corte)
- Tú: "Tenemos Corte Caballero y Barba más corte. ¿Cuál prefieres?"
- Usuario: "Corte caballero"
- Tú: [llamas orquestador con service="Corte Caballero"]
- Orquestador: need_date
- Tú: "¿Para qué fecha quieres el Corte Caballero?"

EJEMPLO INCORRECTO (NO HACER):
- Usuario: "quiero un corte"
- Tú: "Perfecto, ¿para qué fecha?" ❌ (NO preguntar fecha sin confirmar servicio)

═══════════════════════════════════════════════════════════════
🔴 REGLA CRÍTICA #2: FLUJO OBLIGATORIO
═══════════════════════════════════════════════════════════════
PASO 1: SERVICIO (obligatorio primero)
- Siempre verificar/confirmar servicio antes de todo
- Si hay múltiples opciones, el usuario DEBE elegir una

PASO 2: FECHA (solo después de servicio confirmado)
- Preguntar fecha solo cuando el servicio esté claro

PASO 3: HORA (solo después de fecha)
- Preguntar hora o usar la que el usuario dio

PASO 4: ESTILISTA (automático o elegir)
- Mostrar estilistas disponibles
- Usuario elige o se asigna el primero

PASO 5: CONFIRMAR Y AGENDAR
- Mostrar resumen
- Con confirmación → action="agendar"

═══════════════════════════════════════════════════════════════
🔴 REGLA CRÍTICA #3: CAMBIO DE ESTILISTA
═══════════════════════════════════════════════════════════════
Si el usuario dice: "otro estilista", "quién más", "hay otro", "cambiar estilista"
→ Usa action="listar_estilistas_disponibles" SIN enviar stylist actual

═══════════════════════════════════════════════════════════════
OTRAS REGLAS:
═══════════════════════════════════════════════════════════════
- Respuestas CORTAS (1-3 oraciones máximo)
- "sí"/"dale"/"confirmo"/"listo" = confirmación → action="agendar"
- NUNCA inventes servicios, estilistas o disponibilidad
- SIEMPRE usa el orquestador para verificar datos`;

    // =====================================================
    // FUNCTIONS
    // =====================================================
    const FUNCTIONS = [
        {
            type: "function",
            function: {
                name: "consultar_orquestador",
                description: `Consulta servicios, verifica disponibilidad y agenda citas. 
                
IMPORTANTE: 
- Si el usuario menciona un servicio → llama con SOLO el servicio primero
- Si hay múltiples servicios similares → el orquestador devolverá las opciones
- NO envíes fecha/hora hasta que el servicio esté confirmado
- Para cambiar estilista → usa action="listar_estilistas_disponibles" sin stylist`,
                parameters: {
                    type: "object",
                    properties: {
                        action: {
                            type: "string",
                            enum: ["orchestrate", "agendar", "listar_estilistas_disponibles"],
                            description: "orchestrate=consultar/verificar, agendar=confirmar cita, listar_estilistas_disponibles=ver otros estilistas"
                        },
                        service: {
                            type: "string",
                            description: "Nombre del servicio. Enviar PRIMERO y SOLO para verificar antes de pedir fecha."
                        },
                        selected_service_id: {
                            type: "string",
                            description: "UUID del servicio (si ya fue confirmado)"
                        },
                        stylist: {
                            type: "string",
                            description: "Nombre del estilista (NO enviar si action=listar_estilistas_disponibles)"
                        },
                        selected_stylist_id: {
                            type: "string",
                            description: "UUID del estilista"
                        },
                        date: {
                            type: "string",
                            description: "Fecha: hoy/mañana/YYYY-MM-DD. SOLO enviar después de confirmar servicio."
                        },
                        time: {
                            type: "string",
                            description: "Hora: 5pm/17:00/9am. SOLO enviar después de confirmar servicio."
                        }
                    }
                }
            }
        }
    ];

    const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...conversationHistory.slice(-12),
        { role: 'user', content: userMessage }
    ];

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
            temperature: 0.3,  // Más bajo para seguir mejor las instrucciones
            max_tokens: 350
        })
    });

    if (!response.ok) {
        throw new Error('Error de OpenAI');
    }

    const data = await response.json();
    const assistantMessage = data.choices[0].message;

    // Si hay llamada a función
    if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
        const toolCall = assistantMessage.tool_calls[0];
        const functionArgs = JSON.parse(toolCall.function.arguments || '{}');

        console.log(`   🔧 [FUNCIÓN] consultar_orquestador`);
        console.log(`   📦 [ARGS RAW]:`, JSON.stringify(functionArgs));

        // =====================================================
        // LÓGICA DE MERGE INTELIGENTE
        // =====================================================
        const isListingStylists = functionArgs.action === 'listar_estilistas_disponibles';

        // Solo incluir datos del contexto si el servicio ya está confirmado
        const serviceConfirmed = bookingContext.service_confirmed === true;

        const mergedArgs = {
            action: functionArgs.action || 'orchestrate',
            // Servicio: usar el nuevo si viene, o el del contexto si está confirmado
            service: functionArgs.service || (serviceConfirmed ? bookingContext.service : ''),
            selected_service_id: functionArgs.selected_service_id || (serviceConfirmed ? bookingContext.service_id : ''),
            // Fecha y hora: solo si el servicio está confirmado
            date: serviceConfirmed ? (functionArgs.date || bookingContext.date || '') : (functionArgs.date || ''),
            time: serviceConfirmed ? (functionArgs.time || bookingContext.time || '') : (functionArgs.time || ''),
            // Estilista: no incluir si está listando
            stylist: isListingStylists ? '' : (functionArgs.stylist || bookingContext.stylist || ''),
            selected_stylist_id: isListingStylists ? '' : (functionArgs.selected_stylist_id || bookingContext.stylist_id || ''),
        };

        console.log(`   📦 [MERGED]:`, JSON.stringify(mergedArgs));
        console.log(`   🔍 [FLAGS] serviceConfirmed: ${serviceConfirmed}, isListingStylists: ${isListingStylists}`);

        const orchestratorResult = await callOrchestrator(mergedArgs, tenantId, clientId);

        console.log(`   📋 [ORQUESTADOR]:`, JSON.stringify(orchestratorResult).substring(0, 500));

        // =====================================================
        // EXTRAER Y ACTUALIZAR CONTEXTO
        // =====================================================
        let updatedContext = {};

        // Si el orquestador confirmó un servicio único
        if (orchestratorResult.status === 'need_date' ||
            orchestratorResult.status === 'need_time' ||
            orchestratorResult.status === 'choose_time' ||
            orchestratorResult.status === 'confirm' ||
            orchestratorResult.status === 'booked') {

            // El servicio está confirmado
            if (orchestratorResult.summary?.service || orchestratorResult.service) {
                const svc = orchestratorResult.summary?.service || orchestratorResult.service;
                updatedContext.service = svc.name;
                updatedContext.service_id = svc.id;
                updatedContext.service_confirmed = true;  // Flag importante
            }
        }

        // Actualizar otros datos del contexto
        if (orchestratorResult.summary) {
            if (orchestratorResult.summary.stylist && !isListingStylists) {
                updatedContext.stylist = orchestratorResult.summary.stylist.name;
                updatedContext.stylist_id = orchestratorResult.summary.stylist.id;
            }
            if (orchestratorResult.summary.date) updatedContext.date = orchestratorResult.summary.date;
            if (orchestratorResult.summary.time) updatedContext.time = orchestratorResult.summary.time;
        }

        // Si devolvió lista de estilistas, limpiar estilista del contexto
        if (orchestratorResult.status === 'choose_stylist') {
            updatedContext.stylist = null;
            updatedContext.stylist_id = null;
        }

        if (orchestratorResult.status === 'booked') {
            updatedContext.booked = true;
        }

        // Segunda llamada a GPT para generar respuesta
        const followUpMessages = [
            ...messages,
            assistantMessage,
            { role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(orchestratorResult) }
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
                temperature: 0.3,
                max_tokens: 350
            })
        });

        if (!finalResponse.ok) {
            return {
                response: orchestratorResult.message || 'Procesado.',
                updatedContext
            };
        }

        const finalData = await finalResponse.json();
        return {
            response: finalData.choices[0].message.content,
            updatedContext
        };
    }

    return { response: assistantMessage.content, updatedContext: null };
}

/* =================================================================== */
/* ==============   HELPER: LLAMAR AL ORQUESTADOR   ================== */
/* =================================================================== */

async function callOrchestrator(args, tenantId, clientId) {
    try {
        const appointmentController = require('./appointmentController');
        const { findAvailableStylists } = require('../services/appointmentService');

        const isListingStylists = args.action === 'listar_estilistas_disponibles';

        console.log(`   🔧 [ORQUESTADOR] Action: ${args.action}, ListingStylists: ${isListingStylists}`);

        // =====================================================
        // MANEJO ESPECIAL: LISTAR ESTILISTAS
        // =====================================================
        if (isListingStylists && args.service && args.date && args.time) {
            try {
                const allStylists = await findAvailableStylists(
                    tenantId,
                    args.service,
                    args.date,
                    args.time
                );

                const availableList = allStylists
                    .filter(s => !s.is_busy)
                    .map(s => ({
                        id: s.id,
                        name: `${s.first_name} ${s.last_name || ''}`.trim()
                    }));

                if (availableList.length === 0) {
                    return {
                        status: 'no_stylists_available',
                        message: `No hay estilistas disponibles para "${args.service}" el ${args.date} a las ${args.time}.`,
                        suggestions: []
                    };
                }

                const stylistNames = availableList.map((s, i) => `${i + 1}. ${s.name}`).join('\n');

                return {
                    status: 'choose_stylist',
                    message: `Para "${args.service}" el ${args.date} a las ${args.time}, estos estilistas están disponibles:\n${stylistNames}`,
                    available_stylists: availableList,
                    service: { name: args.service, id: args.selected_service_id },
                    date: args.date,
                    time: args.time,
                    next: '¿Con cuál estilista prefieres agendar?'
                };
            } catch (error) {
                console.error('❌ Error listando estilistas:', error);
            }
        }

        // =====================================================
        // FLUJO NORMAL DEL ORQUESTADOR
        // =====================================================
        const mockReq = {
            body: {
                tenantId: tenantId,
                clientId: clientId,
                action: args.action === 'listar_estilistas_disponibles' ? 'orchestrate' : (args.action || 'orchestrate'),
                service: args.service || '',
                stylist: args.stylist || '',
                date: args.date || '',
                time: args.time || '',
                selected_service_id: args.selected_service_id || '',
                selected_stylist_id: args.selected_stylist_id || '',
                confirm: args.action === 'agendar' ? 'true' : 'false'
            },
            query: {}
        };

        let responseData = null;
        let responseStatus = 200;

        const mockRes = {
            status: (code) => {
                responseStatus = code;
                return mockRes;
            },
            json: (data) => {
                responseData = data;
                return mockRes;
            }
        };

        await appointmentController.aiOrchestratorPublic(mockReq, mockRes);

        console.log(`   🎯 [ORQUESTADOR] Status HTTP: ${responseStatus}`);

        if (responseData) {
            if (responseData.status === 'booked' && responseData.appointment) {
                try {
                    const io = getIO();
                    io.to(`tenant:${tenantId}`).emit('appointment:created', {
                        ...responseData.appointment,
                        createdVia: 'whatsapp'
                    });
                    console.log(`   📡 [SOCKET] appointment:created emitido`);
                } catch (socketError) {
                    console.log(`   ⚠️ [SOCKET] Error:`, socketError.message);
                }
            }
            return responseData;
        }

        return { success: false, message: 'Error procesando solicitud' };

    } catch (error) {
        console.error('❌ Error orquestador:', error);
        return { success: false, message: 'Error: ' + error.message };
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

        for (const key of conversationCache.keys()) {
            if (key.startsWith(tenantId)) {
                conversationCache.delete(key);
            }
        }
        for (const key of bookingContextCache.keys()) {
            if (key.startsWith(tenantId)) {
                bookingContextCache.delete(key);
            }
        }

        return res.json({ success: true, message: 'Desconectado correctamente.' });

    } catch (error) {
        console.error('Error al desconectar:', error);
        res.status(200).json({ success: true, message: 'Desconexión forzada.' });
    }
};