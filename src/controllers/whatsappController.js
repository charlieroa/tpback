'use strict';

const db = require('../config/db');
const wahaService = require('../services/wahaService');
const { formatInTimeZone } = require('date-fns-tz');
const { getIO } = require('../socket');

console.log('🚀 [DEBUG] whatsappController.js cargado v4 (Usando Orquestador)');

const TIME_ZONE = 'America/Bogota';

// Cache para historial de conversación por número de teléfono
const conversationCache = new Map();

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

            console.log(`   📋 [PAYLOAD DEBUG] notifyName: "${notifyName}" | payload.notifyName: "${payload.notifyName}" | pushName: "${payload.pushName}"`);

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
                            await wahaService.sendMessage(tenantId, chatId, '🎤 Lo siento, no pude acceder a tu nota de voz. ¿Puedes escribir tu mensaje?');
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
                        await wahaService.sendMessage(tenantId, chatId, '🎤 Lo siento, no puedo procesar notas de voz en este momento.');
                        return res.status(200).send('OK');
                    }
                } catch (voiceError) {
                    console.error('❌ Error procesando audio:', voiceError.message);
                    await wahaService.sendMessage(tenantId, chatId, '😅 Hubo un problema con tu nota de voz. ¿Puedes escribir tu mensaje?');
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

            // Reinicio de conversación
            const simpleGreetings = /^(hola|buenos días|buenas tardes|buenas noches|hi|hey|hello)[\s!.]*$/i;
            const resetCommands = /(empezar de nuevo|cancelar|se me olvid[oó]|reset|reiniciar)/i;

            if ((simpleGreetings.test(userMessage.trim()) || resetCommands.test(userMessage.trim())) && conversationHistory.length > 0) {
                console.log(`🔄 [REINICIO] Limpiando historial de conversación para ${senderName}`);
                conversationHistory = [];
                conversationCache.set(cacheKey, conversationHistory);
            }

            try {
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

                conversationHistory.push({ role: 'user', content: userMessage });
                conversationHistory.push({ role: 'assistant', content: aiResponse });

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
                                    text: aiResponse,
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
                                    input: aiResponse,
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
                            await wahaService.sendMessage(tenantId, chatId, aiResponse);
                        }
                    } catch (ttsError) {
                        console.error('⚠️ Error en TTS:', ttsError.message);
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
    const hoyStr = formatInTimeZone(new Date(), TIME_ZONE, "EEEE d 'de' MMMM 'de' yyyy", { locale: require('date-fns/locale/es') });

    const SYSTEM_PROMPT = `Eres un asistente virtual amigable de "${tenantName}" que responde por WhatsApp.
El cliente se llama ${senderName}. Usa su nombre para ser más personal.

FECHA ACTUAL: Hoy es ${hoyStr}. Usa esta información para interpretar fechas correctamente.

BIENVENIDA:
- Si el cliente SOLO saluda (ejemplo: "hola", "buenos días") → responde: "¡Hola ${senderName}! 👋 Bienvenido/a a ${tenantName}. ¿En qué te puedo ayudar?"
- Si el saludo incluye una solicitud → procesa la solicitud directamente

🎯 FLUJO INTELIGENTE USANDO EL ORQUESTADOR:
Tienes UNA SOLA función: "consultar_orquestador". SIEMPRE úsala para:
- Listar servicios
- Listar estilistas
- Verificar disponibilidad
- Agendar citas

El orquestador te dará respuestas con "status" que indican qué hacer:
- "need_service" → Pregunta qué servicio quiere
- "list_stylist_services" → Muestra los servicios que ofrece ese estilista
- "disambiguation_needed" → Hay varias opciones, pide que elija
- "choose_time" → Muestra horarios disponibles
- "confirm" → Pide confirmación antes de agendar
- "booked" → ¡Cita agendada exitosamente!
- "stylist_not_offering_service" → El estilista no ofrece ese servicio, muestra alternativas

⚠️ REGLAS CRÍTICAS:
1. NUNCA inventes servicios ni estilistas - usa SOLO lo que devuelve el orquestador
2. NUNCA digas que alguien está disponible sin verificar con el orquestador
3. Si el cliente dice "sí", "confirmo", "dale" después de ver un resumen → usa action="agendar"
4. Respuestas cortas y directas (2-3 oraciones máximo)

ESTILO:
- Español colombiano: "¡Listo!", "¡Claro que sí!", "Con mucho gusto"
- Emojis con moderación 💇✂️📅
- NO hagas listas largas, sé conciso`;

    const FUNCTIONS = [
        {
            type: "function",
            function: {
                name: "consultar_orquestador",
                description: "Consulta el orquestador para listar servicios, estilistas, verificar disponibilidad o agendar citas. SIEMPRE usa esta función para cualquier consulta relacionada con servicios, estilistas o citas.",
                parameters: {
                    type: "object",
                    properties: {
                        action: {
                            type: "string",
                            description: "Acción a realizar: 'orchestrate' para consultar/verificar, 'agendar' para confirmar una cita",
                            enum: ["orchestrate", "agendar"]
                        },
                        service: {
                            type: "string",
                            description: "Nombre del servicio (ej: 'corte', 'tinte', 'manicure')"
                        },
                        stylist: {
                            type: "string",
                            description: "Nombre del estilista (ej: 'María', 'Carlos')"
                        },
                        date: {
                            type: "string",
                            description: "Fecha deseada. Usar palabras del cliente: 'hoy', 'mañana', 'sábado', '21 de enero', etc."
                        },
                        time: {
                            type: "string",
                            description: "Hora deseada: '3pm', '15:00', '3 de la tarde', etc."
                        },
                        selected_service_id: {
                            type: "string",
                            description: "UUID del servicio seleccionado (cuando hay desambiguación)"
                        },
                        selected_stylist_id: {
                            type: "string",
                            description: "UUID del estilista seleccionado (cuando hay desambiguación)"
                        }
                    },
                    required: []
                }
            }
        }
    ];

    const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...conversationHistory.slice(-10),
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
            temperature: 0.7,
            max_tokens: 400
        })
    });

    if (!response.ok) {
        throw new Error('Error de OpenAI');
    }

    const data = await response.json();
    const assistantMessage = data.choices[0].message;

    if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
        const toolCall = assistantMessage.tool_calls[0];
        const functionName = toolCall.function.name;
        const functionArgs = JSON.parse(toolCall.function.arguments || '{}');

        console.log(`   🔧 Ejecutando función: ${functionName}`);
        console.log(`   📦 Args:`, JSON.stringify(functionArgs));

        const functionResult = await callOrchestrator(functionArgs, tenantId, clientId);

        console.log(`   📋 Resultado orquestador:`, JSON.stringify(functionResult).substring(0, 500));

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
                max_tokens: 400
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
/* ==============   HELPER: LLAMAR AL ORQUESTADOR   ================== */
/* =================================================================== */

async function callOrchestrator(args, tenantId, clientId) {
    try {
        // Importar el controlador de appointments
        const appointmentController = require('./appointmentController');

        // Crear un mock de req/res para llamar al orquestador internamente
        const mockReq = {
            body: {
                tenantId: tenantId,
                clientId: clientId,
                action: args.action || 'orchestrate',
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

        console.log(`   🎯 [ORQUESTADOR] Status: ${responseStatus}`);

        // Formatear respuesta para GPT
        if (responseData) {
            // Añadir contexto útil para GPT
            if (responseData.status === 'booked' && responseData.appointment) {
                const io = getIO();
                io.to(`tenant:${tenantId}`).emit('appointment:created', {
                    ...responseData.appointment,
                    createdVia: 'whatsapp'
                });
                console.log(`   📡 [SOCKET] Evento appointment:created emitido`);
            }

            return responseData;
        }

        return { success: false, message: 'No se pudo procesar la solicitud' };

    } catch (error) {
        console.error('❌ Error llamando al orquestador:', error);
        return { success: false, message: 'Error procesando la solicitud: ' + error.message };
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

        return res.json({ success: true, message: 'Desconectado correctamente.' });

    } catch (error) {
        console.error('Error al desconectar:', error);
        res.status(200).json({ success: true, message: 'Desconexión forzada.' });
    }
};