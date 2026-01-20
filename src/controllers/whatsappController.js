'use strict';

const db = require('../config/db');
const wahaService = require('../services/wahaService');
const { formatInTimeZone } = require('date-fns-tz');
const { getIO } = require('../socket');
const { normalizeDateKeyword, normalizeHumanTimeToHHMM } = require('../utils/appointmentHelpers');

console.log('🚀 [DEBUG] whatsappController.js cargado v12 (FECHA OBLIGATORIA ANTES DE ESTILISTA)');

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
    
    // Normalizar mensaje: reemplazar errores tipográficos comunes
    let normalizedMessage = message.toLowerCase()
        .replace(/ma[;:.,]ana/gi, 'mañana')      // ma;ana, ma:ana, ma.ana → mañana
        .replace(/manana/gi, 'mañana')           // manana → mañana
        .replace(/ma[ñn]ana/gi, 'mañana');       // mañana, manana → mañana

    console.log(`\n🔍 [EXTRACT] Analizando mensaje: "${message}"`);
    if (normalizedMessage !== message.toLowerCase()) {
        console.log(`   📝 Normalizado a: "${normalizedMessage}"`);
    }

    // Fecha
    const datePatterns = [
        { regex: /(?:para\s+)?(pasado\s*mañana)/i, keyword: 'pasado mañana' },
        { regex: /(?:para\s+)?(mañana)/i, keyword: 'mañana' },
        { regex: /(?:para\s+)?(hoy)/i, keyword: 'hoy' },
        { regex: /(?:para\s+)?(?:el\s+|este\s+)?(lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo)/i, extract: true },
    ];

    for (const pattern of datePatterns) {
        const match = normalizedMessage.match(pattern.regex);
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

    // Hora - patrones mejorados
    const timePatterns = [
        /a\s+las\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|de\s+la\s+mañana|de\s+la\s+tarde|de\s+la\s+noche)?/i,
        /las\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i,  // "las 2", "las 14"
        /\b(\d{1,2})\s*(am|pm|a\.m\.|p\.m\.)\b/i,
        /(?:tipo|como\s+a\s+las?)\s+(\d{1,2})/i,
        /\b(\d{1,2}):(\d{2})\b/,  // "14:00"
    ];

    for (const pattern of timePatterns) {
        const match = normalizedMessage.match(pattern);
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
            let shouldAutoCheck = false; // 🆕 Flag para verificar automáticamente

            // 🆕 DETECTAR NOMBRES DE ESTILISTAS MENCIONADOS (si hay servicio en contexto)
            if (bookingContext.service_id && !bookingContext.stylist_id) {
                // Patrones comunes de nombres de estilistas mencionados
                const stylistNames = ['pedro', 'carlos', 'sofia', 'sofía', 'maria', 'maría', 'juan', 'ana', 'laura'];
                const userMessageLower = userMessage.toLowerCase().trim();
                
                for (const name of stylistNames) {
                    if (userMessageLower === name || 
                        userMessageLower.includes(name + ' ') || 
                        userMessageLower.includes(' ' + name) ||
                        userMessageLower === name + ' está bien' ||
                        userMessageLower.includes(name + ' esta bien')) {
                        
                        bookingContext.stylist = name.charAt(0).toUpperCase() + name.slice(1);
                        contextUpdated = true;
                        console.log(`   ✅ Estilista detectado y guardado: ${bookingContext.stylist}`);
                        break;
                    }
                }
            }

            if (extractedDateTime.date && !bookingContext.date) {
                bookingContext.date = extractedDateTime.date;
                contextUpdated = true;
                console.log(`   ✅ Fecha guardada en contexto: ${extractedDateTime.date}`);
                
                // 🆕 Si ya tenemos servicio + estilista, podemos verificar automáticamente
                if (bookingContext.service_id && bookingContext.stylist) {
                    shouldAutoCheck = true;
                    console.log(`   🎯 Tiene servicio + estilista + fecha → Puede verificar automáticamente`);
                }
            }
            if (extractedDateTime.time && !bookingContext.time) {
                bookingContext.time = extractedDateTime.time;
                contextUpdated = true;
                console.log(`   ⏰ Hora guardada en contexto: ${extractedDateTime.time}`);
            }

            if (contextUpdated) {
                bookingContextCache.set(cacheKey, bookingContext);
            }

            // 🆕 Si se acaba de completar la información necesaria, incluir hint para GPT
            if (shouldAutoCheck) {
                console.log(`   💡 Hint para GPT: Ya tiene servicio + estilista + fecha → Debe verificar disponibilidad`);
            }

            try {
                // 🆕 Si acabamos de completar la información, añadir hint al mensaje
                let messageToProcess = userMessage;
                if (shouldAutoCheck) {
                    messageToProcess = `${userMessage}\n\n[NOTA: Ya tienes servicio + estilista + fecha en el contexto. Verifica disponibilidad automáticamente.]`;
                    console.log(`   📝 Mensaje procesado con hint de auto-verificación`);
                }

                const result = await processWithAI(
                    apiKey,
                    tenantId,
                    clientId,
                    messageToProcess,
                    conversationHistory,
                    bookingContext,
                    senderName,
                    tenantName,
                    extractedDateTime
                );

                if (result.updatedContext) {
                    bookingContext = { ...bookingContext, ...result.updatedContext };
                    bookingContextCache.set(cacheKey, bookingContext);
                    console.log(`   📝 Contexto actualizado:`, JSON.stringify(bookingContext));
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

async function processWithAI(apiKey, tenantId, clientId, userMessage, conversationHistory, bookingContext, senderName, tenantName, extractedDateTime = { date: null, time: null }) {
    const hoyStr = formatInTimeZone(new Date(), TIME_ZONE, "EEEE d 'de' MMMM 'de' yyyy", { locale: require('date-fns/locale/es') });

    // Contexto actual CON IDs
    let contextInfo = '';
    if (Object.keys(bookingContext).length > 0) {
        const parts = [];
        if (bookingContext.service) parts.push(`📋 Servicio: ${bookingContext.service}`);
        if (bookingContext.service_id) parts.push(`   (service_id: ${bookingContext.service_id})`);
        if (bookingContext.stylist) parts.push(`💇 Estilista: ${bookingContext.stylist}`);
        if (bookingContext.stylist_id) parts.push(`   (stylist_id: ${bookingContext.stylist_id})`);
        if (bookingContext.date) parts.push(`📅 Fecha: ${bookingContext.date}`);
        if (bookingContext.time) parts.push(`⏰ Hora: ${bookingContext.time}`);
        if (parts.length > 0) {
            contextInfo = `\n\n📋 DATOS DE LA RESERVA EN PROGRESO:\n${parts.join('\n')}`;
        }
    }

    // 🆕 System Prompt MEJORADO - FLUJO ORDENADO
    const SYSTEM_PROMPT = `Eres el asistente de "${tenantName}" en WhatsApp. Cliente: ${senderName}.
Hoy: ${hoyStr}.${contextInfo}

⚠️ CRÍTICO: USA LOS DATOS DEL CONTEXTO ARRIBA. Si dice "📅 Fecha: 2026-01-22", esa fecha YA ESTÁ GUARDADA.

TIENES 3 FUNCIONES:
1. buscar_servicio → Buscar servicios (SIEMPRE PRIMERO)
2. verificar_disponibilidad → Ver horarios (requiere servicio + estilista + fecha)
3. agendar_cita → Confirmar cita

═══════════════════════════════════════════════════════════════
🎯 FLUJO OBLIGATORIO (SIGUE EN ORDEN):
═══════════════════════════════════════════════════════════════

PASO 1: BUSCAR SERVICIO PRIMERO - ⚠️ OBLIGATORIO
- Usuario dice: "quiero un servicio" / "necesito un servicio" / "corte" / "manicure" → LLAMAR buscar_servicio INMEDIATAMENTE
- Si el usuario no especifica qué servicio, usa "servicio" como palabra clave: [buscar_servicio: service="servicio"]
- NO respondas sin llamar la función. SIEMPRE llama buscar_servicio cuando alguien pide un servicio.
- Si hay múltiples servicios → mostrar opciones y pedir confirmación
- Si hay un solo servicio → guardar service_id y mostrar estilistas

PASO 2: ELEGIR ESTILISTA
- Usuario elige estilista por nombre (ej: "sofia", "pedro", "carlos")
- SI HAY FECHA EN CONTEXTO → verificar_disponibilidad INMEDIATAMENTE sin preguntar nada
  → Ejemplo: [verificar_disponibilidad: serviceId="xxx", stylistName="sofia", date="2026-01-22"]
  → Mostrar directamente los horarios: "Sofía tiene disponible mañana en estos horarios: 9:00, 10:00..."
- SI NO HAY FECHA → preguntar: "¿Para qué fecha quieres tu cita con [nombre]?"

PASO 2.5: USUARIO MENCIONA HORA
- Si el usuario dice una hora (ej: "a las 9", "9", "mañana a las 9") y ya hay estilista + fecha en contexto:
  → Llamar verificar_disponibilidad con la hora incluida
  → Responder DIRECTAMENTE:
    * Si disponible: "Sí, Sofía está disponible mañana a las 9:00. ¿Confirmo tu cita?"
    * Si NO disponible: "Sofía no está disponible mañana a las 9:00. Horarios disponibles: 10:00, 11:00, 14:00. ¿Cuál prefieres?"

PASO 3: VERIFICAR DISPONIBILIDAD
- Usar fecha del contexto si existe
- Llamar con: serviceId + stylistName + date (del contexto o nueva)
- RESPUESTA DIRECTA: No digas "Voy a verificar" o "Un momento". Di directamente el resultado:
  * Si está disponible: "[Nombre] tiene disponible [fecha] en estos horarios: [lista]"
  * Si NO está disponible: "[Nombre] no está disponible [fecha] a las [hora]. Horarios disponibles: [lista]"
  * Si no encuentra estilista: "No encontré [nombre]. Disponibles: [lista]"
- ⚠️ IMPORTANTE: Usa el formato de 12 horas (AM/PM) para mostrar horarios. Si el resultado tiene "slots_12h", úsalo. Ejemplo: "9:00 AM", "2:00 PM", "12:00 PM"

PASO 4: CONFIRMAR Y AGENDAR
- Usuario elige hora → confirmar
- Usuario dice "sí" → agendar_cita

═══════════════════════════════════════════════════════════════
EJEMPLOS CORRECTOS:
═══════════════════════════════════════════════════════════════

EJEMPLO 1 - Usuario pide servicio genérico:
Usuario: "quiero un servicio para mañana"
→ Contexto guarda: 📅 Fecha: 2026-01-21
→ [buscar_servicio: service="servicio"] OBLIGATORIO
→ Mostrar todos los servicios disponibles

EJEMPLO 2 - Fecha ya mencionada, usuario elige estilista:
Contexto: 📅 Fecha: 2026-01-21 (mañana), 📋 Servicio: Corte Caballero
Usuario: "sofia"
→ YA HAY FECHA en contexto → LLAMAR verificar_disponibilidad AUTOMÁTICAMENTE
→ [verificar_disponibilidad: serviceId, stylistName="sofia", date="2026-01-21"]
→ RESPUESTA DIRECTA: "Sofía tiene disponible mañana en estos horarios: 9:00, 10:00, 14:00, 15:00. ¿Cuál prefieres?"
→ NO digas: "¿Para qué fecha?" (ya la tiene), NO digas "Voy a verificar"

EJEMPLO 3 - Usuario menciona fecha después de elegir estilista:
Contexto: 📋 Servicio: Corte Caballero, 💇 Estilista: Sofía (sin fecha)
Usuario: "para mañana"
→ Se guarda fecha: 📅 2026-01-21
→ AUTOMÁTICAMENTE: [verificar_disponibilidad: serviceId, stylistName="sofia", date="2026-01-21"]
→ "Sofía tiene disponible mañana en estos horarios: 9:00, 10:00, 14:00. ¿Cuál prefieres?"

EJEMPLO 4 - Usuario menciona hora:
Contexto: 📅 Fecha: 2026-01-21, 📋 Servicio: Corte Caballero, 💇 Estilista: Sofía
Usuario: "a las 9" o "9" o "tipo 9"
→ [verificar_disponibilidad: serviceId, stylistName="sofia", date="2026-01-21", time="09:00"]
→ Si disponible: "Sí, Sofía está disponible mañana a las 9:00. ¿Confirmo tu cita?"
→ Si NO disponible: "Sofía no está disponible mañana a las 9:00. Horarios disponibles: 10:00, 11:00, 14:00. ¿Cuál prefieres?"

EJEMPLO 3 - Sin fecha previa:
Contexto: 📋 Servicio: Corte Caballero (sin fecha)
Usuario: "sofia"
→ NO hay fecha en contexto
→ "¡Perfecto! ¿Para qué fecha quieres tu cita con Sofía?"

EJEMPLO 4 - Todo junto:
Usuario: "corte caballero con sofia mañana"
→ [buscar_servicio: "corte caballero"] PRIMERO
→ Guardar servicio, extraer fecha="mañana", estilista="sofia"
→ [verificar_disponibilidad con todos los datos]

REGLA DE ORO: 
- Si el usuario pide un servicio → LLAMA buscar_servicio INMEDIATAMENTE
- Si tienes servicio + estilista + fecha en contexto → LLAMA verificar_disponibilidad AUTOMÁTICAMENTE
- Si el usuario menciona una hora después de elegir estilista → LLAMA verificar_disponibilidad con la hora
- SIEMPRE di el resultado directamente, NO digas "Voy a verificar" ni "Un momento"`;

    // Funciones
    const FUNCTIONS = [
        {
            type: "function",
            function: {
                name: "buscar_servicio",
                description: "Busca un servicio y devuelve los estilistas que lo ofrecen. USA ESTA FUNCIÓN cuando el usuario pida un servicio (ej: 'quiero un servicio', 'necesito corte', 'manicure'). Si el usuario no especifica qué servicio, usa 'servicio' como palabra clave.",
                parameters: {
                    type: "object",
                    properties: {
                        service: {
                            type: "string",
                            description: "Nombre del servicio. Si el usuario dice solo 'quiero un servicio', usa 'servicio'. Si dice 'corte', 'manicure', etc., usa esa palabra exacta."
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
                description: "Verifica horarios disponibles. REQUIERE fecha. Puede usar stylistName para buscar por nombre.",
                parameters: {
                    type: "object",
                    properties: {
                        serviceId: {
                            type: "string",
                            description: "UUID del servicio (OBLIGATORIO - usa el del contexto)"
                        },
                        stylistId: {
                            type: "string",
                            description: "UUID del estilista (opcional - solo si ya lo tienes)"
                        },
                        stylistName: {
                            type: "string",
                            description: "Nombre del estilista (usa esto cuando el usuario mencione un nombre)"
                        },
                        date: {
                            type: "string",
                            description: "Fecha en formato YYYY-MM-DD (OBLIGATORIO)"
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
                description: "Agenda la cita cuando el usuario confirma.",
                parameters: {
                    type: "object",
                    properties: {
                        serviceId: {
                            type: "string",
                            description: "UUID del servicio"
                        },
                        stylistId: {
                            type: "string",
                            description: "UUID del estilista"
                        },
                        stylistName: {
                            type: "string",
                            description: "Nombre del estilista (alternativa al stylistId)"
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
    console.log('   Contexto actual:', JSON.stringify(bookingContext));

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
            max_tokens: 400
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
            // 🆕 Pasar date y time si están disponibles en el contexto o en el mensaje extraído
            const searchDate = bookingContext.date || extractedDateTime.date || null;
            const searchTime = bookingContext.time || extractedDateTime.time || null;
            functionResult = await callSearchService(tenantId, functionArgs.service, searchDate, searchTime);

            // Guardar servicio en contexto si se encontró un servicio único
            if (functionResult.found && functionResult.service && !functionResult.multiple) {
                updatedContext.service = functionResult.service.name;
                updatedContext.service_id = functionResult.service.id;
                console.log(`   ✅ Servicio guardado: ${functionResult.service.name} (${functionResult.service.id})`);
                
                // Si ya hay fecha en el contexto, recordarle a GPT que la use
                if (bookingContext.date && functionResult.stylists && functionResult.stylists.length > 0) {
                    console.log(`   📅 Fecha ya existe en contexto: ${bookingContext.date}`);
                    functionResult.date_in_context = bookingContext.date;
                    functionResult.hint = `Nota: Ya tienes fecha guardada (${bookingContext.date}). Cuando el usuario elija estilista, usa esa fecha para verificar disponibilidad.`;
                }
            }
            
            // Si hay múltiples opciones pero found=true, mostrar las opciones al usuario
            if (functionResult.found && functionResult.multiple && functionResult.options) {
                console.log(`   📋 Servicios encontrados (múltiples): ${functionResult.options.map(o => o.name).join(', ')}`);
                functionResult.hint = 'Muestra estas opciones al usuario para que elija. NO digas "no encontré", di "Encontré estos servicios: ..."';
            }
        }
        else if (functionName === 'verificar_disponibilidad') {
            // Usar IDs del contexto si no vienen en args
            const checkParams = {
                serviceId: functionArgs.serviceId || bookingContext.service_id,
                stylistId: functionArgs.stylistId || bookingContext.stylist_id,
                stylistName: functionArgs.stylistName || bookingContext.stylist, // ← FIX: usar nombre del contexto
                date: functionArgs.date || bookingContext.date,
                time: functionArgs.time || bookingContext.time
            };

            console.log(`   📋 Params finales:`, JSON.stringify(checkParams));

            functionResult = await callCheckAvailability(tenantId, checkParams);

            // Guardar el stylist_id que devuelve el endpoint (caso: un solo estilista)
            if (functionResult.stylist && functionResult.stylist.id) {
                updatedContext.stylist = functionResult.stylist.name;
                updatedContext.stylist_id = functionResult.stylist.id;
                console.log(`   ✅ Estilista guardado: ${functionResult.stylist.name} (${functionResult.stylist.id})`);
            }

            // Si needsDate, guardar el estilista pero indicar que falta fecha
            if (functionResult.needsDate && functionResult.stylist) {
                updatedContext.stylist = functionResult.stylist.name;
                updatedContext.stylist_id = functionResult.stylist.id;
            }

            // 🆕 Si el resultado tiene múltiples estilistas, buscar el que coincida con stylistName
            if (functionResult.stylists && Array.isArray(functionResult.stylists) && checkParams.stylistName) {
                const searchName = checkParams.stylistName.toLowerCase();
                const matchedStylist = functionResult.stylists.find(s => 
                    s.name.toLowerCase().includes(searchName) ||
                    searchName.includes(s.name.toLowerCase().split(' ')[0])
                );
                
                if (matchedStylist) {
                    updatedContext.stylist = matchedStylist.name;
                    updatedContext.stylist_id = matchedStylist.id;
                    console.log(`   ✅ Estilista encontrado en lista: ${matchedStylist.name} (${matchedStylist.id})`);
                    
                    // Modificar el resultado para que GPT sepa qué estilista usar
                    functionResult.matched_stylist = matchedStylist;
                }
            }

            // Guardar fecha si viene en el resultado
            if (functionResult.date && !bookingContext.date) {
                updatedContext.date = functionResult.date;
            }
        }
        else if (functionName === 'agendar_cita') {
            // 🔧 IMPORTANTE: Usar el nombre del estilista del contexto si no viene en args
            const bookParams = {
                serviceId: functionArgs.serviceId || bookingContext.service_id,
                stylistId: functionArgs.stylistId || bookingContext.stylist_id,
                stylistName: functionArgs.stylistName || bookingContext.stylist, // ← FIX: usar nombre del contexto
                date: functionArgs.date || bookingContext.date,
                time: functionArgs.time || bookingContext.time
            };

            console.log(`\n📝 [AGENDAR CITA] Preparando reserva`);
            console.log(`   ClientId: ${clientId}`);
            console.log(`   BookingContext completo:`, JSON.stringify(bookingContext, null, 2));
            console.log(`   Params finales:`, JSON.stringify(bookParams, null, 2));

            functionResult = await callBookAppointment(tenantId, clientId, bookParams);

            if (functionResult.booked) {
                updatedContext.booked = true;
                console.log(`   ✅ Cita agendada exitosamente`);
            } else {
                console.log(`   ❌ Error al agendar:`, functionResult.error || functionResult.message);
            }
        }

        console.log('\n📋 [FUNCTION RESULT]:', JSON.stringify(functionResult, null, 2).substring(0, 800));

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
                max_tokens: 400
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
/* ==============   LLAMADAS A LOS ENDPOINTS   ======================= */
/* =================================================================== */

async function callSearchService(tenantId, service, date = null, time = null) {
    try {
        const whatsappBookingController = require('./Whatsappbookingcontroller');

        const mockReq = {
            body: { tenantId, service, date, time } // 🆕 Pasar date y time si están disponibles
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
        const whatsappBookingController = require('./Whatsappbookingcontroller');

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
        const whatsappBookingController = require('./Whatsappbookingcontroller');

        console.log('\n📞 [CALL BOOK APPOINTMENT]');
        console.log('   TenantId:', tenantId);
        console.log('   ClientId:', clientId);
        console.log('   Params recibidos:', JSON.stringify(params, null, 2));

        // Validaciones previas
        if (!clientId) {
            console.log('   ❌ Error: clientId no proporcionado');
            return { booked: false, error: 'No se pudo identificar al cliente. Por favor intenta de nuevo.' };
        }

        if (!params.serviceId) {
            console.log('   ❌ Error: serviceId no proporcionado');
            return { booked: false, error: 'No se ha seleccionado un servicio. ¿Qué servicio deseas?' };
        }

        if (!params.stylistId && !params.stylistName) {
            console.log('   ❌ Error: No hay stylistId ni stylistName');
            return { booked: false, error: 'No se ha seleccionado un estilista. ¿Con quién te gustaría la cita?' };
        }

        if (!params.date) {
            console.log('   ❌ Error: date no proporcionado');
            return { booked: false, error: 'No se ha indicado la fecha. ¿Para qué día quieres la cita?' };
        }

        if (!params.time) {
            console.log('   ❌ Error: time no proporcionado');
            return { booked: false, error: 'No se ha indicado la hora. ¿A qué hora te gustaría?' };
        }

        const mockReq = {
            body: { tenantId, clientId, ...params }
        };

        let responseData = null;
        let statusCode = 200;
        const mockRes = {
            status: (code) => { statusCode = code; return mockRes; },
            json: (data) => { responseData = data; return mockRes; }
        };

        await whatsappBookingController.bookAppointment(mockReq, mockRes);
        
        console.log('   📋 Respuesta del endpoint:', JSON.stringify(responseData, null, 2));
        console.log('   Status code:', statusCode);

        return responseData || { booked: false, error: 'Error desconocido al agendar cita' };
    } catch (error) {
        console.error('❌ Error en callBookAppointment:', error);
        return { booked: false, error: 'Error interno: ' + error.message };
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