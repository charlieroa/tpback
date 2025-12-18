'use strict';

const db = require('../config/db');
const wahaService = require('../services/wahaService');
const { formatInTimeZone, zonedTimeToUtc } = require('date-fns-tz');

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

            // Solo procesar mensajes de texto (type puede estar en payload o en _data)
            const messageType = payload.type || payload._data?.type;
            if (messageType !== 'chat' || !payload.body) {
                return res.status(200).send('OK');
            }

            const chatId = payload.from;        // Ej: 573123456789@c.us
            const userMessage = payload.body;   // Texto del mensaje
            const senderName = payload.notifyName || payload._data?.notifyName || 'Cliente';

            console.log(`\n💬 [MENSAJE] De: ${senderName} (${chatId})`);
            console.log(`   Texto: "${userMessage}"`);

            // Obtener API Key del tenant
            const tenantResult = await db.query(
                'SELECT openai_api_key FROM tenants WHERE id = $1',
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

            // Obtener o crear historial de conversación
            const cacheKey = `${tenantId}:${chatId}`;
            let conversationHistory = conversationCache.get(cacheKey) || [];

            // Buscar cliente por número de teléfono
            const phoneNumber = chatId.split('@')[0];
            const clientResult = await db.query(
                `SELECT id FROM clients WHERE tenant_id = $1 AND phone LIKE $2 LIMIT 1`,
                [tenantId, `%${phoneNumber.slice(-10)}%`]
            );
            const clientId = clientResult.rows[0]?.id || null;

            try {
                // Procesar con IA
                const aiResponse = await processWithAI(
                    apiKey,
                    tenantId,
                    clientId,
                    userMessage,
                    conversationHistory
                );

                // Actualizar historial
                conversationHistory.push({ role: 'user', content: userMessage });
                conversationHistory.push({ role: 'assistant', content: aiResponse });

                // Mantener solo últimos 10 mensajes
                if (conversationHistory.length > 20) {
                    conversationHistory = conversationHistory.slice(-20);
                }
                conversationCache.set(cacheKey, conversationHistory);

                // Responder por WhatsApp
                await wahaService.sendMessage(tenantId, chatId, aiResponse);
                console.log(`   ✅ Respuesta enviada`);

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

async function processWithAI(apiKey, tenantId, clientId, userMessage, conversationHistory) {
    const SYSTEM_PROMPT = `Eres un asistente virtual amigable de una peluquería que responde por WhatsApp. 
Ayudas a los clientes a consultar servicios, ver estilistas disponibles y agendar citas.

REGLAS:
- Sé amable, conciso y usa emojis 💇✂️📅
- Si el cliente quiere agendar, pregunta servicio, fecha y hora
- Usa las funciones disponibles para obtener información real
- Las fechas "hoy" y "mañana" son válidas
- Respuestas cortas (máximo 2-3 oraciones por mensaje)`;

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
                description: "Lista los estilistas disponibles",
                parameters: { type: "object", properties: {}, required: [] }
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
                description: "Verifica disponibilidad para un servicio",
                parameters: {
                    type: "object",
                    properties: {
                        servicio: { type: "string" },
                        estilista: { type: "string" },
                        fecha: { type: "string" },
                        hora: { type: "string" }
                    },
                    required: ["servicio"]
                }
            }
        },
        {
            type: "function",
            function: {
                name: "agendar_cita",
                description: "Agenda una cita confirmada",
                parameters: {
                    type: "object",
                    properties: {
                        servicio: { type: "string" },
                        estilista: { type: "string" },
                        fecha: { type: "string" },
                        hora: { type: "string" }
                    },
                    required: ["servicio", "fecha", "hora"]
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
        const functionResult = await executeWhatsAppFunction(functionName, functionArgs, tenantId, clientId);

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

async function executeWhatsAppFunction(functionName, args, tenantId, clientId) {
    // Helpers
    const normalizeDateKeyword = (dateStr) => {
        if (!dateStr) return formatInTimeZone(new Date(), TIME_ZONE, 'yyyy-MM-dd');
        const s = String(dateStr).toLowerCase();
        const now = new Date();
        const today = formatInTimeZone(now, TIME_ZONE, 'yyyy-MM-dd');
        const tomorrow = formatInTimeZone(new Date(now.getTime() + 86400000), TIME_ZONE, 'yyyy-MM-dd');
        if (s.includes('mañana')) return tomorrow;
        if (s.includes('hoy')) return today;
        return dateStr;
    };

    const normalizeHumanTime = (t) => {
        if (!t) return '10:00';
        let s = String(t).toLowerCase().replace(/\s+/g, '');
        const m = s.match(/^(\d{1,2})(?::?(\d{2}))?(am|pm)?$/);
        if (!m) return '10:00';
        let h = parseInt(m[1], 10);
        let mm = m[2] ? parseInt(m[2], 10) : 0;
        if (m[3] === 'pm' && h < 12) h += 12;
        if (m[3] === 'am' && h === 12) h = 0;
        return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    };

    try {
        switch (functionName) {
            case 'listar_servicios': {
                const result = await db.query(
                    `SELECT name, duration_minutes, price FROM services WHERE tenant_id = $1 ORDER BY name`,
                    [tenantId]
                );
                return {
                    success: true,
                    servicios: result.rows.map(s => `${s.name} (${s.duration_minutes}min)`),
                    message: `Servicios: ${result.rows.map(s => s.name).join(', ')}`
                };
            }

            case 'listar_estilistas': {
                const result = await db.query(
                    `SELECT first_name, last_name FROM users 
                     WHERE tenant_id = $1 AND role_id = 3 AND COALESCE(NULLIF(status,''),'active') = 'active'`,
                    [tenantId]
                );
                const nombres = result.rows.map(u => `${u.first_name} ${u.last_name || ''}`.trim());
                return { success: true, estilistas: nombres, message: `Estilistas: ${nombres.join(', ')}` };
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
                const fecha = normalizeDateKeyword(args.fecha);
                const hora = args.hora ? normalizeHumanTime(args.hora) : null;

                const svcResult = await db.query(
                    `SELECT id, name, duration_minutes FROM services 
                     WHERE tenant_id = $1 AND LOWER(name) LIKE $2 LIMIT 1`,
                    [tenantId, `%${(args.servicio || '').toLowerCase()}%`]
                );

                if (svcResult.rows.length === 0) {
                    return { success: false, message: `No encontré el servicio "${args.servicio}"` };
                }

                const servicio = svcResult.rows[0];

                // Buscar estilista
                let queryParams = [tenantId, servicio.id];
                let stylistCondition = '';
                if (args.estilista) {
                    stylistCondition = `AND (LOWER(u.first_name) LIKE $3 OR LOWER(CONCAT(u.first_name, ' ', u.last_name)) LIKE $3)`;
                    queryParams.push(`%${args.estilista.toLowerCase()}%`);
                }

                const stylistsResult = await db.query(
                    `SELECT u.id, u.first_name, u.last_name FROM users u
                     INNER JOIN stylist_services ss ON u.id = ss.user_id
                     WHERE u.tenant_id = $1 AND ss.service_id = $2 AND u.role_id = 3
                     ${stylistCondition} LIMIT 1`,
                    queryParams
                );

                if (stylistsResult.rows.length === 0) {
                    return { success: false, message: `No hay estilistas disponibles para ${servicio.name}` };
                }

                const estilista = stylistsResult.rows[0];
                const nombreEstilista = `${estilista.first_name} ${estilista.last_name || ''}`.trim();

                if (hora) {
                    const startTime = zonedTimeToUtc(`${fecha} ${hora}:00`, TIME_ZONE);
                    const endTime = new Date(startTime.getTime() + servicio.duration_minutes * 60000);

                    const conflict = await db.query(
                        `SELECT id FROM appointments 
                         WHERE tenant_id = $1 AND stylist_id = $2 
                         AND status IN ('scheduled','rescheduled','checked_in')
                         AND (start_time, end_time) OVERLAPS ($3::timestamptz, $4::timestamptz)`,
                        [tenantId, estilista.id, startTime, endTime]
                    );

                    if (conflict.rows.length > 0) {
                        return {
                            success: true,
                            available: false,
                            message: `❌ ${nombreEstilista} no está disponible a las ${hora}. ¿Quieres otra hora?`
                        };
                    }

                    return {
                        success: true,
                        available: true,
                        servicio: servicio.name,
                        estilista: nombreEstilista,
                        fecha,
                        hora,
                        message: `✅ ${nombreEstilista} disponible el ${fecha} a las ${hora} para ${servicio.name}. ¿Confirmo la cita?`
                    };
                }

                return {
                    success: true,
                    servicio: servicio.name,
                    estilista: nombreEstilista,
                    fecha,
                    message: `${nombreEstilista} puede atenderte para ${servicio.name} el ${fecha}. ¿A qué hora?`
                };
            }

            case 'agendar_cita': {
                if (!clientId) {
                    return { success: false, message: 'Para agendar, necesito tu número registrado. ¿Podrías darnos tu nombre?' };
                }

                const fecha = normalizeDateKeyword(args.fecha);
                const hora = normalizeHumanTime(args.hora);

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
                    stylistCondition = `AND (LOWER(u.first_name) LIKE $3)`;
                    queryParams.push(`%${args.estilista.toLowerCase()}%`);
                }

                const stylistResult = await db.query(
                    `SELECT u.id, u.first_name FROM users u
                     INNER JOIN stylist_services ss ON u.id = ss.user_id
                     WHERE u.tenant_id = $1 AND ss.service_id = $2 AND u.role_id = 3
                     ${stylistCondition} LIMIT 1`,
                    queryParams
                );

                if (stylistResult.rows.length === 0) {
                    return { success: false, message: 'No hay estilistas disponibles' };
                }

                const estilista = stylistResult.rows[0];
                const startTime = zonedTimeToUtc(`${fecha} ${hora}:00`, TIME_ZONE);
                const endTime = new Date(startTime.getTime() + servicio.duration_minutes * 60000);

                await db.query(
                    `INSERT INTO appointments (tenant_id, client_id, stylist_id, service_id, start_time, end_time, status)
                     VALUES ($1, $2, $3, $4, $5, $6, 'scheduled')`,
                    [tenantId, clientId, estilista.id, servicio.id, startTime, endTime]
                );

                return {
                    success: true,
                    message: `🎉 ¡Cita agendada!\n📅 ${fecha} a las ${hora}\n💇 ${servicio.name}\n👤 ${estilista.first_name}\n\n¡Te esperamos!`
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