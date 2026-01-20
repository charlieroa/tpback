'use strict';

const db = require('../config/db');
const wahaService = require('../services/wahaService');
const { formatInTimeZone } = require('date-fns-tz');
const { getIO } = require('../socket');
const { normalizeDateKeyword, normalizeHumanTimeToHHMM } = require('../utils/appointmentHelpers');

console.log('🚀 [DEBUG] whatsappController.js cargado v11 (CON STYLIST NAME)');

const TIME_ZONE = 'America/Bogota';

// Cache para historial de conversación
const conversationCache = new Map();

// Cache para datos de reserva en progreso
const bookingContextCache = new Map();

/* =================================================================== */
/* ==============   EXTRACCIÓN DE FECHA/HORA DEL MENSAJE   =========== */
/* =================================================================== */

function extractDateTimeFromMessage(message) {
    const result = { date: null, time: null };
    const lower = message.toLowerCase();

    console.log(`\n🔍 [EXTRACT] Analizando mensaje: "${message}"`);

    // Fecha
    const datePatterns = [
        { regex: /(?:para\s+)?(pasado\s*mañana|pasado\s*manana)/i, keyword: 'pasado mañana' },
        { regex: /(?:para\s+)?(mañana|manana)/i, keyword: 'mañana' },
        { regex: /(?:para\s+)?(hoy)/i, keyword: 'hoy' },
        { regex: /(?:para\s+)?(?:el\s+|este\s+)?(lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo)/i, extract: true },
    ];

    for (const pattern of datePatterns) {
        const match = lower.match(pattern.regex);
        if (match) {
            let dateInput = pattern.keyword || match[0];
            dateInput = dateInput.replace(/^para\s+/i, '').trim();
            const normalized = normalizeDateKeyword(dateInput);
            if (normalized) {
                result.date = normalized;
                console.log(`   ✅ Fecha detectada: "${dateInput}" → ${normalized}`);
                break;
            }
        }
    }

    // Hora
    const timePatterns = [
        /a\s+las\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|de\s+la\s+mañana|de\s+la\s+tarde|de\s+la\s+noche)?/i,
        /\b(\d{1,2})\s*(am|pm|a\.m\.|p\.m\.)\b/i,
        /(?:tipo|como\s+a\s+las)\s+(\d{1,2})/i,
    ];

    for (const pattern of timePatterns) {
        const match = lower.match(pattern);
        if (match) {
            const timeStr = match[0];
            const normalized = normalizeHumanTimeToHHMM(timeStr);
            if (normalized && normalized !== '') {
                result.time = normalized;
                console.log(`   ✅ Hora detectada: "${timeStr}" → ${normalized}`);
                break;
            }
        }
    }

    return result;
}

/* =================================================================== */
/* ==============   WEBHOOK (LISTEN TO WAHA)   ======================= */
/* =================================================================== */

exports.handleWahaWebhook = async (req, res) => {
    try {
        const event = req.body;
        const eventType = event.event;
        const tenantId = event.session;

        console.log(`\n📥 [WEBHOOK] Evento recibido: ${eventType} | Sesión: ${tenantId}`);

        // Cambio de estado de sesión
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

        // Mensaje entrante
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
            let notifyName = payload.notifyName || payload._data?.notifyName || payload.pushName || payload._data?.pushName || '';

            // Gestión de cliente
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
                    if (savedFirstName && savedFirstName.length >= 2 && !/^\d+$/.test(savedFirstName) && !invalidNames.includes(savedFirstName.toLowerCase())) {
                        senderName = savedLastName && savedLastName.length >= 2 ? `${savedFirstName} ${savedLastName}`.trim() : savedFirstName;
                    }
                } else {
                    const newClient = await db.query(
                        `INSERT INTO users (tenant_id, role_id, first_name, phone, email, password_hash)
                         VALUES ($1, 4, $2, $3, $4, 'whatsapp')
                         RETURNING id`,
                        [tenantId, senderName, phoneNumber, `${phoneNumber}@whatsapp.temp`]
                    );
                    if (newClient.rows.length > 0) {
                        clientId = newClient.rows[0].id;
                        console.log(`   🆕 Nuevo cliente: ${senderName}`);
                    }
                }
            } catch (clientError) {
                console.error('   ⚠️ Error cliente:', clientError.message);
            }

            // Manejar notas de voz
            if (messageType === 'ptt' || messageType === 'audio') {
                console.log(`\n🎤 [AUDIO] De: ${senderName}`);
                isVoiceMessage = true;

                try {
                    const apiKeyResult = await db.query('SELECT openai_api_key FROM tenants WHERE id = $1', [tenantId]);
                    const apiKey = apiKeyResult.rows[0]?.openai_api_key;

                    if (apiKey) {
                        const axios = require('axios');
                        let audioBuffer = null;

                        const WAHA_URL = process.env.WAHA_URL || 'http://212.28.189.253:3002';
                        const WAHA_API_KEY = process.env.WAHA_API_KEY || '';

                        if (payload.media?.url) {
                            try {
                                let mediaUrl = payload.media.url;
                                if (mediaUrl.includes('localhost:3000')) mediaUrl = mediaUrl.replace('http://localhost:3000', WAHA_URL);
                                if (mediaUrl.includes('0.0.0.0:3000')) mediaUrl = mediaUrl.replace('http://0.0.0.0:3000', WAHA_URL);

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

                        if (!audioBuffer) {
                            await wahaService.sendMessage(tenantId, chatId, '🎤 No pude acceder a tu nota de voz. ¿Puedes escribirme?');
                            return res.status(200).send('OK');
                        }

                        const FormData = require('form-data');
                        const formData = new FormData();
                        formData.append('file', audioBuffer, { filename: 'audio.ogg', contentType: 'audio/ogg' });
                        formData.append('model', 'whisper-1');
                        formData.append('language', 'es');

                        const whisperResponse = await axios.post('https://api.openai.com/v1/audio/transcriptions', formData, {
                            headers: {
                                'Authorization': `Bearer ${apiKey}`,
                                ...formData.getHeaders()
                            }
                        });
                        userMessage = whisperResponse.data.text;
                        console.log(`   📝 Transcripción: "${userMessage}"`);
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
            const tenantResult = await db.query('SELECT openai_api_key, name FROM tenants WHERE id = $1', [tenantId]);

            if (tenantResult.rows.length === 0 || !tenantResult.rows[0].openai_api_key) {
                console.log('⚠️ No hay API Key configurada');
                await wahaService.sendMessage(tenantId, chatId, '⚠️ El asistente no está configurado. Contacta al administrador.');
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
                console.log(`🔄 Limpiando conversación para ${senderName}`);
                conversationHistory = [];
                bookingContext = {};
                conversationCache.set(cacheKey, conversationHistory);
                bookingContextCache.set(cacheKey, bookingContext);
            }

            // Extraer fecha/hora del mensaje
            const extractedDateTime = extractDateTimeFromMessage(userMessage);

            let contextUpdated = false;
            if (extractedDateTime.date && !bookingContext.date) {
                bookingContext.date = extractedDateTime.date;
                contextUpdated = true;
                console.log(`   ✅ Fecha guardada: ${extractedDateTime.date}`);
            }
            if (extractedDateTime.time && !bookingContext.time) {
                bookingContext.time = extractedDateTime.time;
                contextUpdated = true;
                console.log(`   ⏰ Hora guardada: ${extractedDateTime.time}`);
            }

            if (contextUpdated) {
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

                if (result.updatedContext) {
                    bookingContext = { ...bookingContext, ...result.updatedContext };
                    bookingContextCache.set(cacheKey, bookingContext);
                }

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

                        const tenantVoice = await db.query('SELECT elevenlabs_api_key, elevenlabs_voice_id FROM tenants WHERE id = $1', [tenantId]);
                        const elevenLabsKey = tenantVoice.rows[0]?.elevenlabs_api_key;
                        const voiceId = tenantVoice.rows[0]?.elevenlabs_voice_id || 'pNInz6obpgDQGcFmaJgB';

                        if (elevenLabsKey) {
                            const elevenLabsResponse = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
                                method: 'POST',
                                headers: { 'xi-api-key': elevenLabsKey, 'Content-Type': 'application/json' },
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
                                headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
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
                console.error('❌ Error IA:', aiError.message);
                await wahaService.sendMessage(tenantId, chatId, '😅 Tuve un problema. ¿Puedes intentar de nuevo?');
            }
        }

        res.status(200).send('OK');

    } catch (error) {
        console.error('❌ [WEBHOOK ERROR]:', error);
        res.status(500).send('Error procesando webhook');
    }
};

/* =================================================================== */
/* ==============   PROCESAR CON IA (OPENAI)   ======================= */
/* =================================================================== */

async function processWithAI(apiKey, tenantId, clientId, userMessage, conversationHistory, bookingContext, senderName, tenantName) {
    const hoyStr = formatInTimeZone(new Date(), TIME_ZONE, "EEEE d 'de' MMMM 'de' yyyy", { locale: require('date-fns/locale/es') });

    // Contexto actual
    let contextInfo = '';
    if (Object.keys(bookingContext).length > 0) {
        const parts = [];
        if (bookingContext.service) parts.push(`📋 Servicio: ${bookingContext.service}`);
        if (bookingContext.stylist) parts.push(`💇 Estilista: ${bookingContext.stylist}`);
        if (bookingContext.date) parts.push(`📅 Fecha: ${bookingContext.date}`);
        if (bookingContext.time) parts.push(`⏰ Hora: ${bookingContext.time}`);
        if (parts.length > 0) {
            contextInfo = `\n\n📋 DATOS DE LA RESERVA EN PROGRESO:\n${parts.join('\n')}`;
        }
    }

    // 🆕 System Prompt MEJORADO
    const SYSTEM_PROMPT = `Eres el asistente de "${tenantName}" en WhatsApp. Cliente: ${senderName}.
Hoy: ${hoyStr}.${contextInfo}

TIENES 3 FUNCIONES DISPONIBLES:
1. buscar_servicio → Para buscar servicios y ver qué estilistas los ofrecen
2. verificar_disponibilidad → Para ver horarios (acepta stylistName O stylistId)
3. agendar_cita → Para confirmar la cita (acepta stylistName O stylistId)

═══════════════════════════════════════════════════════════════
FLUJO DE AGENDAMIENTO (OBLIGATORIO):
═══════════════════════════════════════════════════════════════

PASO 1: SERVICIO
- Usuario menciona servicio → llamar buscar_servicio
- Guardar service_id en contexto
- Mostrar lista de estilistas disponibles

PASO 2: FECHA (si no está en contexto)
- Preguntar: "¿Para qué fecha?"
- Guardar en contexto

PASO 3: ESTILISTA
- Cuando usuario elija estilista por NOMBRE (ej: "Sofia", "Carlos") →
  llamar verificar_disponibilidad con stylistName="Sofia"
- El endpoint buscará automáticamente el UUID
- Mostrar horarios disponibles
- Guardar stylist_id cuando lo recibas del resultado

PASO 4: HORA
- Usuario elige hora de los slots disponibles
- Guardar en contexto

PASO 5: CONFIRMAR
- Mostrar resumen completo
- Cuando diga "sí"/"confirmo"/"dale" → llamar agendar_cita

═══════════════════════════════════════════════════════════════
REGLAS IMPORTANTES:
═══════════════════════════════════════════════════════════════
- NUNCA inventes servicios o estilistas
- SIEMPRE usa stylistName cuando el usuario diga un nombre
- USA fecha/hora del contexto si ya existen
- Respuestas CORTAS (máximo 2-3 oraciones)
- Tono amigable y natural
- Si usuario cancela → reiniciar flujo

═══════════════════════════════════════════════════════════════
EJEMPLOS CORREGIDOS:
═══════════════════════════════════════════════════════════════

Usuario: "quiero un corte para mañana"
→ [buscar_servicio: "corte"]
→ Respuesta: "Para corte tenemos a: Pedro, Carlos y Sofía. ¿Con quién prefieres?"

Usuario: "con Sofia"
→ [verificar_disponibilidad: serviceId=xxx, stylistName="Sofia", date="2026-01-21"]
→ Respuesta: "Sofía tiene disponible: 9:00, 10:00, 14:00. ¿Cuál te sirve?"

Usuario: "a las 10"
→ Respuesta: "Perfecto. ¿Confirmo tu cita de Corte con Sofía mañana a las 10:00?"

Usuario: "sí"
→ [agendar_cita: con todos los IDs guardados en contexto]
→ Respuesta: "¡Listo! Tu cita quedó agendada..."

Usuario: "hay otro estilista disponible?"
→ [verificar_disponibilidad: sin stylistId ni stylistName, solo con date y time]
→ Respuesta: "A las 10 también están disponibles: María y Carlos. ¿Con quién prefieres?"`;

    // 🆕 Funciones ACTUALIZADAS con stylistName
    const FUNCTIONS = [
        {
            type: "function",
            function: {
                name: "buscar_servicio",
                description: "Busca un servicio y devuelve los estilistas que lo ofrecen",
                parameters: {
                    type: "object",
                    properties: {
                        service: {
                            type: "string",
                            description: "Nombre del servicio (ej: 'corte', 'manicure', 'tintura')"
                        }
                    },
                    required: ["service"]
                }
            }
        },
        {
            type: "function",
            function: {
                name: "verificar_disponibilidad",
                description: "Verifica disponibilidad de horarios. Puede usar stylistId (si ya lo tienes guardado) O stylistName (cuando el usuario menciona un nombre).",
                parameters: {
                    type: "object",
                    properties: {
                        serviceId: {
                            type: "string",
                            description: "UUID del servicio"
                        },
                        stylistId: {
                            type: "string",
                            description: "UUID del estilista (opcional - solo si ya lo tienes guardado en el contexto)"
                        },
                        stylistName: {
                            type: "string",
                            description: "Nombre del estilista (opcional - úsalo cuando el usuario mencione un nombre como 'Sofia', 'Carlos', 'Pedro', etc.)"
                        },
                        date: {
                            type: "string",
                            description: "Fecha en formato YYYY-MM-DD"
                        },
                        time: {
                            type: "string",
                            description: "Hora en formato HH:mm (opcional)"
                        }
                    },
                    required: ["serviceId", "date"]
                }
            }
        },
        {
            type: "function",
            function: {
                name: "agendar_cita",
                description: "Agenda la cita cuando el usuario confirma. Puede usar stylistId O stylistName.",
                parameters: {
                    type: "object",
                    properties: {
                        serviceId: {
                            type: "string",
                            description: "UUID del servicio"
                        },
                        stylistId: {
                            type: "string",
                            description: "UUID del estilista (usa esto si lo tienes guardado)"
                        },
                        stylistName: {
                            type: "string",
                            description: "Nombre del estilista (usa esto si no tienes el UUID)"
                        },
                        date: {
                            type: "string",
                            description: "Fecha YYYY-MM-DD"
                        },
                        time: {
                            type: "string",
                            description: "Hora HH:mm"
                        }
                    },
                    required: ["serviceId", "date", "time"]
                }
            }
        }
    ];

    const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...conversationHistory.slice(-12),
        { role: 'user', content: userMessage }
    ];

    console.log('\n🤖 [GPT] Enviando request...');

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
            temperature: 0.3,
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
        const functionName = toolCall.function.name;
        const functionArgs = JSON.parse(toolCall.function.arguments || '{}');

        console.log(`\n🔧 [FUNCIÓN] ${functionName} llamada`);
        console.log(`📦 [ARGS]:`, JSON.stringify(functionArgs, null, 2));

        let functionResult;
        let updatedContext = {};

        // Ejecutar la función correspondiente
        if (functionName === 'buscar_servicio') {
            functionResult = await callSearchService(tenantId, functionArgs.service);

            // Guardar servicio en contexto si se encontró
            if (functionResult.found && functionResult.service) {
                updatedContext.service = functionResult.service.name;
                updatedContext.service_id = functionResult.service.id;
            }
        }
        else if (functionName === 'verificar_disponibilidad') {
            // 🆕 PASAR stylistName también
            const checkParams = {
                serviceId: functionArgs.serviceId || bookingContext.service_id,
                stylistId: functionArgs.stylistId || bookingContext.stylist_id,
                stylistName: functionArgs.stylistName, // 🆕 NUEVO
                date: functionArgs.date || bookingContext.date,
                time: functionArgs.time || bookingContext.time
            };

            functionResult = await callCheckAvailability(tenantId, checkParams);

            // 🆕 Guardar el stylist_id que devuelve el endpoint
            if (functionResult.stylist && functionResult.stylist.id) {
                updatedContext.stylist = functionResult.stylist.name;
                updatedContext.stylist_id = functionResult.stylist.id;
                console.log(`   ✅ Estilista guardado en contexto: ${functionResult.stylist.name} (${functionResult.stylist.id})`);
            }
        }
        else if (functionName === 'agendar_cita') {
            // 🆕 PASAR stylistName también
            const bookParams = {
                serviceId: functionArgs.serviceId || bookingContext.service_id,
                stylistId: functionArgs.stylistId || bookingContext.stylist_id,
                stylistName: functionArgs.stylistName, // 🆕 NUEVO
                date: functionArgs.date || bookingContext.date,
                time: functionArgs.time || bookingContext.time
            };

            functionResult = await callBookAppointment(tenantId, clientId, bookParams);

            if (functionResult.booked) {
                updatedContext.booked = true;
            }
        }

        console.log('\n📋 [FUNCTION RESULT]:', JSON.stringify(functionResult, null, 2).substring(0, 500));

        // Segunda llamada a GPT para generar respuesta
        const followUpMessages = [
            ...messages,
            assistantMessage,
            { role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(functionResult) }
        ];

        console.log('\n🤖 [GPT] Generando respuesta final...');

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
                response: functionResult.message || 'Procesado.',
                updatedContext
            };
        }

        const finalData = await finalResponse.json();
        const finalResponseText = finalData.choices[0].message.content;

        return {
            response: finalResponseText,
            updatedContext
        };
    }

    // Respuesta directa de GPT
    return { response: assistantMessage.content, updatedContext: null };
}

/* =================================================================== */
/* ==============   LLAMADAS A LOS NUEVOS ENDPOINTS   ================ */
/* =================================================================== */

async function callSearchService(tenantId, service) {
    try {
        const whatsappBookingController = require('./whatsappBookingController');

        const mockReq = {
            body: { tenantId, service }
        };

        let responseData = null;
        const mockRes = {
            status: (code) => mockRes,
            json: (data) => { responseData = data; return mockRes; }
        };

        await whatsappBookingController.searchService(mockReq, mockRes);
        return responseData || { found: false, message: 'Error buscando servicio' };
    } catch (error) {
        console.error('❌ Error en callSearchService:', error);
        return { found: false, message: 'Error interno' };
    }
}

async function callCheckAvailability(tenantId, params) {
    try {
        const whatsappBookingController = require('./whatsappBookingController');

        const mockReq = {
            body: { tenantId, ...params }
        };

        let responseData = null;
        const mockRes = {
            status: (code) => mockRes,
            json: (data) => { responseData = data; return mockRes; }
        };

        await whatsappBookingController.checkAvailability(mockReq, mockRes);
        return responseData || { available: false, message: 'Error verificando disponibilidad' };
    } catch (error) {
        console.error('❌ Error en callCheckAvailability:', error);
        return { available: false, message: 'Error interno' };
    }
}

async function callBookAppointment(tenantId, clientId, params) {
    try {
        const whatsappBookingController = require('./whatsappBookingController');

        const mockReq = {
            body: { tenantId, clientId, ...params }
        };

        let responseData = null;
        const mockRes = {
            status: (code) => mockRes,
            json: (data) => { responseData = data; return mockRes; }
        };

        await whatsappBookingController.bookAppointment(mockReq, mockRes);
        return responseData || { booked: false, message: 'Error agendando cita' };
    } catch (error) {
        console.error('❌ Error en callBookAppointment:', error);
        return { booked: false, message: 'Error interno: ' + error.message };
    }
}

/* =================================================================== */
/* ==============   OTROS ENDPOINTS (GET STATUS, ETC)   ============== */
/* =================================================================== */

exports.getStatus = async (req, res) => {
    const { tenantId } = req.params;

    if (!tenantId) return res.status(400).json({ error: 'Falta tenantId' });

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

exports.disconnect = async (req, res) => {
    const { tenantId } = req.body;

    if (!tenantId) return res.status(400).json({ error: 'Falta tenantId' });

    console.log(`🔌 Desconectando tenant: ${tenantId}`);

    try {
        await wahaService.deleteSession(tenantId);

        await db.query(
            `UPDATE tenant_numbers
             SET provider = 'disconnected', phone_number_id = 'disconnected', display_phone_number = '', updated_at = NOW()
             WHERE tenant_id = $1`,
            [tenantId]
        );

        for (const key of conversationCache.keys()) {
            if (key.startsWith(tenantId)) conversationCache.delete(key);
        }
        for (const key of bookingContextCache.keys()) {
            if (key.startsWith(tenantId)) bookingContextCache.delete(key);
        }

        return res.json({ success: true, message: 'Desconectado correctamente.' });

    } catch (error) {
        console.error('Error al desconectar:', error);
        res.status(200).json({ success: true, message: 'Desconexión forzada.' });
    }
};