'use strict';

const db = require('../config/db');
const wahaService = require('../services/wahaService');
const { formatInTimeZone } = require('date-fns-tz');
const { getIO } = require('../socket');
const { normalizeDateKeyword, normalizeHumanTimeToHHMM } = require('../utils/appointmentHelpers');

console.log('🚀 [DEBUG] whatsappController.js cargado v13 (FIX: UUID auto-generado por PostgreSQL)');

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
        .replace(/ma[ñn]ana/gi, 'mañana')        // mañana, manana → mañana
        // 🆕 Normalizar días de la semana con typos comunes
        .replace(/vien[rn]es/gi, 'viernes')      // vienres, viennes → viernes
        .replace(/juev[ea]s/gi, 'jueves')        // juevas, juevss → jueves
        .replace(/mi[eé]rcol[ea]s/gi, 'miércoles') // miercolas, miércoless → miércoles
        .replace(/mier[ck]ol[ea]s/gi, 'miércoles') // mierkoles → miércoles
        .replace(/mart[ea]s/gi, 'martes')        // martas → martes
        .replace(/lun[ea]s/gi, 'lunes')          // lunas → lunes
        .replace(/s[aá]bad[oa]/gi, 'sábado')     // sabada, sababo → sábado
        .replace(/doming[oa]/gi, 'domingo');     // dominga → domingo

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
        /a\s+las\s+(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|de\s+la\s+mañana|de\s+la\s+tarde|de\s+la\s+noche)?/i,
        /las\s+(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?/i,  // "las 2", "las 14", "las 9.30"
        /\b(\d{1,2})[:.](\d{2})\s*(am|pm|a\.m\.|p\.m\.)\b/i,  // "9.30 am", "9:30 pm"
        /\b(\d{1,2})\s*(am|pm|a\.m\.|p\.m\.)\b/i,  // "9 am", "2pm"
        /(?:tipo|como\s+a\s+las?)\s+(\d{1,2})(?:[:.](\d{2}))?/i,  // "tipo 9.30"
        /\b(\d{1,2})[:.](\d{2})\b/,  // "14:00", "9.30"
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
            
            // 🔍 MEJORADO: Buscar display name en múltiples lugares del payload
            const notifyNameRaw = payload.notifyName || payload._data?.notifyName || payload.author?.notifyName || payload.contact?.notifyName;
            const pushNameRaw = payload.pushName || payload._data?.pushName || payload.author?.pushName || payload.contact?.pushName;
            const contactName = payload.contact?.name || payload.author?.name || payload.name;
            let notifyName = notifyNameRaw || pushNameRaw || contactName || '';
            
            // Log completo del payload para diagnóstico (solo cuando no hay nombre)
            if (!notifyName || notifyName.trim() === '') {
                console.log(`   ⚠️ DIAGNÓSTICO - Display name vacío o no disponible para ${phoneNumber}:`);
                console.log(`      payload.notifyName: "${payload.notifyName || '(no existe)'}"`);
                console.log(`      payload._data?.notifyName: "${payload._data?.notifyName || '(no existe)'}"`);
                console.log(`      payload.pushName: "${payload.pushName || '(no existe)'}"`);
                console.log(`      payload._data?.pushName: "${payload._data?.pushName || '(no existe)'}"`);
                console.log(`      payload.contact?.name: "${payload.contact?.name || '(no existe)'}"`);
                console.log(`      payload.contact?.notifyName: "${payload.contact?.notifyName || '(no existe)'}"`);
                console.log(`      payload.author?.name: "${payload.author?.name || '(no existe)'}"`);
                console.log(`      payload.author?.notifyName: "${payload.author?.notifyName || '(no existe)'}"`);
                console.log(`      payload.name: "${payload.name || '(no existe)'}"`);
                console.log(`      payload.from: "${payload.from || '(no existe)'}"`);
                console.log(`      📦 Payload completo (keys): ${Object.keys(payload).join(', ')}`);
            } else {
                console.log(`   ✅ Display name encontrado: "${notifyName}" (fuente: ${notifyNameRaw ? 'notifyName' : pushNameRaw ? 'pushName' : 'contact/author'})`);
            }

            // 🔧 Función helper para separar nombre completo en first_name y last_name
            const parseFullName = (fullName) => {
                if (!fullName || fullName.trim() === '') return { firstName: null, lastName: null };
                
                const trimmed = fullName.trim();
                const invalidNames = ['cliente', 'hola', 'buenos', 'días', 'tardes', 'noches', 'hi', 'hello', 'whatsapp'];
                
                // Si es un nombre inválido, retornar null
                if (invalidNames.includes(trimmed.toLowerCase())) {
                    return { firstName: null, lastName: null };
                }
                
                // Si es solo un número, retornar null
                if (/^\d+$/.test(trimmed)) {
                    return { firstName: null, lastName: null };
                }
                
                // Separar por espacios
                const parts = trimmed.split(/\s+/).filter(p => p.length > 0);
                
                if (parts.length === 0) return { firstName: null, lastName: null };
                if (parts.length === 1) return { firstName: parts[0], lastName: null };
                
                // Si tiene 2 o más partes, primera es nombre, resto es apellido
                return {
                    firstName: parts[0],
                    lastName: parts.slice(1).join(' ')
                };
            };

            // Gestión de cliente
            let clientId = null;
            let senderName = notifyName || 'Cliente';
            let hasNameInDB = false; // 🔧 Flag para saber si el usuario tiene nombre guardado en BD
            const parsedName = parseFullName(notifyName);
            
            console.log(`   📋 Nombre de display recibido: "${notifyName}" ${notifyName ? '(válido)' : '(vacío - usando "Cliente")'}`);
            console.log(`   📋 Nombre parseado: first_name="${parsedName.firstName || 'null'}", last_name="${parsedName.lastName || 'null'}"`);

            try {
                // 🔧 MEJORADO: Buscar cliente por teléfono O por nombre (si tenemos display name válido)
                let existingClient = await db.query(
                    `SELECT id, first_name, last_name, phone FROM users
                     WHERE tenant_id = $1 AND phone = $2 AND role_id = 4`,
                    [tenantId, phoneNumber]
                );

                // Si no se encontró por teléfono y tenemos un nombre válido, buscar por nombre
                if (existingClient.rows.length === 0 && parsedName.firstName && parsedName.firstName.length >= 2) {
                    console.log(`   🔍 No se encontró por teléfono, buscando por nombre: "${parsedName.firstName}"`);
                    const nameSearch = await db.query(
                        `SELECT id, first_name, last_name, phone FROM users
                         WHERE tenant_id = $1 
                           AND role_id = 4
                           AND LOWER(first_name) = LOWER($2)
                           ${parsedName.lastName ? 'AND (LOWER(last_name) = LOWER($3) OR last_name IS NULL OR last_name = \'\')' : 'AND (last_name IS NULL OR last_name = \'\')'}
                         ORDER BY created_at DESC
                         LIMIT 1`,
                        parsedName.lastName 
                            ? [tenantId, parsedName.firstName, parsedName.lastName]
                            : [tenantId, parsedName.firstName]
                    );
                    
                    if (nameSearch.rows.length > 0) {
                        existingClient = nameSearch;
                        console.log(`   ✅ Cliente encontrado por nombre: ${nameSearch.rows[0].first_name} (teléfono actual: ${nameSearch.rows[0].phone})`);
                        console.log(`   📱 Actualizando teléfono de ${nameSearch.rows[0].phone} a ${phoneNumber}`);
                        
                        // Actualizar el teléfono del cliente existente
                        await db.query(
                            `UPDATE users SET phone = $1, updated_at = NOW() WHERE id = $2`,
                            [phoneNumber, nameSearch.rows[0].id]
                        );
                    }
                }

                if (existingClient.rows.length > 0) {
                    clientId = existingClient.rows[0].id;
                    let savedFirstName = existingClient.rows[0].first_name;
                    let savedLastName = existingClient.rows[0].last_name;

                    // 🔧 SIMPLIFICADO: Si el cliente existe (role_id = 4) y tiene display name válido, actualizar el nombre en BD
                    const invalidNames = ['cliente', 'hola', 'buenos días', 'buenas tardes', 'buenas noches', 'hi', 'hello'];
                    const hasInvalidSavedName = !savedFirstName || 
                                               savedFirstName.length < 2 || 
                                               /^\d+$/.test(savedFirstName) || 
                                               invalidNames.includes(savedFirstName.toLowerCase());
                    
                    // Si tenemos un display name válido Y el nombre guardado es inválido, actualizarlo
                    if (parsedName.firstName && parsedName.firstName.length >= 2 && hasInvalidSavedName) {
                        try {
                            await db.query(
                                `UPDATE users 
                                 SET first_name = $1, last_name = $2, updated_at = NOW()
                                 WHERE id = $3 AND tenant_id = $4 AND role_id = 4`,
                                [parsedName.firstName, parsedName.lastName, clientId, tenantId]
                            );
                            savedFirstName = parsedName.firstName;
                            savedLastName = parsedName.lastName;
                            console.log(`   ✅ Nombre del cliente actualizado desde display: ${parsedName.firstName} ${parsedName.lastName || ''}`);
                        } catch (updateError) {
                            console.error(`   ⚠️ Error al actualizar nombre desde display: ${updateError.message}`);
                        }
                    }

                    // Usar el nombre guardado (actualizado o existente) para senderName
                    if (savedFirstName && savedFirstName.length >= 2 && !/^\d+$/.test(savedFirstName) && !invalidNames.includes(savedFirstName.toLowerCase())) {
                        senderName = savedLastName && savedLastName.length >= 2 ? `${savedFirstName} ${savedLastName}`.trim() : savedFirstName;
                        hasNameInDB = true; // ✅ Tiene nombre válido en BD
                    } else if (parsedName.firstName && parsedName.firstName.length >= 2) {
                        // Si el nombre guardado no es válido pero tenemos un display name válido, usarlo temporalmente
                        senderName = parsedName.lastName && parsedName.lastName.length >= 2 
                            ? `${parsedName.firstName} ${parsedName.lastName}`.trim() 
                            : parsedName.firstName;
                        console.log(`   ℹ️ Usando display name para senderName: "${senderName}" (no está en BD aún)`);
                        // hasNameInDB permanece false para que el bot pregunte el nombre
                    }
                    console.log(`   ✅ Cliente existente identificado: ${senderName} (ID: ${clientId}, teléfono: ${phoneNumber}, tieneNombreEnBD: ${hasNameInDB})`);
                } else {
                    // ✅ SOLUCIÓN: Omitir el campo id y dejar que PostgreSQL lo genere automáticamente
                    try {
                        const firstNameToUse = parsedName.firstName || 'Cliente';
                        const lastNameToUse = parsedName.lastName || null;
                        
                        const newClient = await db.query(
                            `INSERT INTO users (tenant_id, role_id, first_name, last_name, phone, email, password_hash)
                             VALUES ($1, 4, $2, $3, $4, $5, 'whatsapp')
                             RETURNING id`,
                            [tenantId, firstNameToUse, lastNameToUse, phoneNumber, `${phoneNumber}@whatsapp.temp`]
                        );
                        
                        if (newClient.rows.length > 0) {
                            clientId = newClient.rows[0].id;
                            senderName = lastNameToUse ? `${firstNameToUse} ${lastNameToUse}` : firstNameToUse;
                            
                            // Si el nombre es "Cliente" pero tenemos un display name válido, intentar actualizarlo
                            if (firstNameToUse === 'Cliente' && parsedName.firstName && parsedName.firstName.length >= 2) {
                                console.log(`   🔄 Actualizando nombre de "Cliente" a "${parsedName.firstName}"`);
                                try {
                                    await db.query(
                                        `UPDATE users SET first_name = $1, last_name = $2, updated_at = NOW() WHERE id = $3`,
                                        [parsedName.firstName, parsedName.lastName, clientId]
                                    );
                                    senderName = parsedName.lastName && parsedName.lastName.length >= 2 
                                        ? `${parsedName.firstName} ${parsedName.lastName}`.trim() 
                                        : parsedName.firstName;
                                    hasNameInDB = true; // ✅ Ahora tiene nombre válido
                                    console.log(`   ✅ Nombre actualizado a: ${senderName}`);
                                } catch (updateError) {
                                    console.error(`   ⚠️ Error al actualizar nombre: ${updateError.message}`);
                                }
                            } else if (firstNameToUse !== 'Cliente') {
                                hasNameInDB = true; // ✅ Tiene nombre válido desde el inicio
                            }
                            
                            console.log(`   🆕 Nuevo cliente creado: ${senderName} (ID: ${clientId}, teléfono: ${phoneNumber}, tieneNombreEnBD: ${hasNameInDB})`);
                        }
                    } catch (insertError) {
                        // Si falla por duplicado (puede haber un race condition), intentar buscar de nuevo
                        if (insertError.code === '23505' || insertError.message.includes('duplicate') || insertError.message.includes('unique')) {
                            console.log(`   ⚠️ Cliente duplicado detectado, buscando nuevamente...`);
                            const retryClient = await db.query(
                                `SELECT id, first_name, last_name FROM users
                                 WHERE tenant_id = $1 AND phone = $2 AND role_id = 4`,
                                [tenantId, phoneNumber]
                            );
                            if (retryClient.rows.length > 0) {
                                clientId = retryClient.rows[0].id;
                                const retryFirstName = retryClient.rows[0].first_name;
                                const retryLastName = retryClient.rows[0].last_name;
                                senderName = retryLastName ? `${retryFirstName} ${retryLastName}` : retryFirstName;
                                console.log(`   ✅ Cliente encontrado después de retry: ${senderName} (ID: ${clientId})`);
                            } else {
                                console.error(`   ❌ Error al crear cliente (duplicado pero no encontrado): ${insertError.message}`);
                            }
                        } else {
                            console.error(`   ❌ Error al crear cliente: ${insertError.message}`);
                            throw insertError; // Re-lanzar si es otro tipo de error
                        }
                    }
                }
            } catch (clientError) {
                console.error('   ❌ Error crítico en gestión de cliente:', clientError.message);
                console.error('   Stack:', clientError.stack);
                // No lanzar el error, pero registrar que clientId es null
                // El proceso continuará y fallará en callBookAppointment con un mensaje más claro
            }

            // Validar que tenemos clientId antes de continuar
            if (!clientId) {
                console.error(`   ⚠️ ADVERTENCIA: No se pudo obtener/crear clientId para ${phoneNumber}`);
                hasNameInDB = false; // Sin clientId, no puede tener nombre válido
            }
            
            // 🔧 Log final del estado del nombre
            console.log(`   📊 Estado final: senderName="${senderName}", hasNameInDB=${hasNameInDB}, clientId=${clientId ? 'existe' : 'null'}`);

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

            // 🔧 NUEVO: Detectar si el usuario no tiene nombre y necesita proporcionarlo
            const invalidNameValues = ['cliente', 'hola', 'buenos días', 'buenas tardes', 'buenas noches', 'hi', 'hello'];
            const hasInvalidName = clientId && !hasNameInDB && (
                                  !senderName || 
                                  senderName === 'Cliente' || 
                                  senderName.length < 2 || 
                                  /^\d+$/.test(senderName) ||
                                  invalidNameValues.includes(senderName.toLowerCase())
                              );
            
            // 🔧 DEBUG: Verificar si es un saludo simple
            const isSimpleGreeting = simpleGreetings.test(userMessage.trim());
            const hasNoHistory = conversationHistory.length === 0;
            
            console.log(`   👤 Validación de nombre: senderName="${senderName}", hasNameInDB=${hasNameInDB}, clientId=${clientId ? 'existe' : 'null'}, hasInvalidName=${hasInvalidName}`);
            console.log(`   🔍 Condiciones: isSimpleGreeting=${isSimpleGreeting}, hasNoHistory=${hasNoHistory}`);
            
            // Si no tiene nombre válido y el mensaje parece ser un nombre (2+ palabras), guardarlo PRIMERO
            if (hasInvalidName && clientId) {
                const namePattern = /^([A-Za-zÁÉÍÓÚáéíóúÑñ]{2,})\s+([A-Za-zÁÉÍÓÚáéíóúÑñ]{2,})$/;
                const potentialName = userMessage.trim();
                if (namePattern.test(potentialName)) {
                    const match = potentialName.match(namePattern);
                    const firstName = match[1];
                    const lastName = match[2];
                    
                    const invalidNames = ['cliente', 'hola', 'buenos', 'días', 'tardes', 'noches', 'hi', 'hello', 'si', 'sí', 'no'];
                    if (!invalidNames.includes(firstName.toLowerCase()) && !invalidNames.includes(lastName.toLowerCase())) {
                        try {
                            await db.query(
                                `UPDATE users 
                                 SET first_name = $1, last_name = $2, updated_at = NOW()
                                 WHERE id = $3 AND tenant_id = $4 AND role_id = 4`,
                                [firstName, lastName, clientId, tenantId]
                            );
                            console.log(`   ✅ Nombre del cliente guardado: ${firstName} ${lastName}`);
                            senderName = `${firstName} ${lastName}`;
                            hasNameInDB = true; // ✅ Ahora tiene nombre válido
                        } catch (updateError) {
                            console.error(`   ⚠️ Error al guardar nombre: ${updateError.message}`);
                        }
                    }
                }
            }
            
            // Si no tiene nombre válido y envía un saludo, preguntarle su nombre ANTES de procesar con IA
            if (hasInvalidName && isSimpleGreeting && hasNoHistory) {
                console.log(`   👤 Usuario sin nombre detectado (senderName="${senderName}", hasNameInDB=${hasNameInDB}), preguntando nombre...`);
                await wahaService.sendMessage(tenantId, chatId, '¡Hola! 👋 Para poder ayudarte mejor, ¿podrías decirme tu nombre completo?');
                return res.status(200).send('OK');
            }
            
            // Si no tiene clientId, también preguntar el nombre
            if (!clientId && isSimpleGreeting && hasNoHistory) {
                console.log(`   ⚠️ Usuario sin clientId, preguntando nombre...`);
                await wahaService.sendMessage(tenantId, chatId, '¡Hola! 👋 Para poder ayudarte mejor, ¿podrías decirme tu nombre completo?');
                return res.status(200).send('OK');
            }

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
            let shouldAutoCheck = false;

            // 🆕 DETECTAR NOMBRES DE ESTILISTAS MENCIONADOS
            if (bookingContext.service_id && !bookingContext.stylist_id) {
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

            let shouldShowStylists = false;
            
            if (extractedDateTime.date && !bookingContext.date) {
                bookingContext.date = extractedDateTime.date;
                contextUpdated = true;
                console.log(`   ✅ Fecha guardada en contexto: ${extractedDateTime.date}`);
                
                if (bookingContext.service_id && bookingContext.stylist) {
                    shouldAutoCheck = true;
                    console.log(`   🎯 Tiene servicio + estilista + fecha → Puede verificar automáticamente`);
                }
                
                if (bookingContext.service_id && !bookingContext.stylist) {
                    shouldShowStylists = true;
                    console.log(`   🎯 Tiene servicio + fecha (sin estilista) → Debe mostrar estilistas automáticamente`);
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

            if (shouldAutoCheck) {
                console.log(`   💡 Hint para GPT: Ya tiene servicio + estilista + fecha → Debe verificar disponibilidad`);
            }

            try {
                let messageToProcess = userMessage;
                if (shouldAutoCheck) {
                    messageToProcess = `${userMessage}\n\n[NOTA: Ya tienes servicio + estilista + fecha en el contexto. Verifica disponibilidad automáticamente.]`;
                    console.log(`   📝 Mensaje procesado con hint de auto-verificación`);
                } else if (shouldShowStylists) {
                    messageToProcess = `${userMessage}\n\n[NOTA: Ya tienes servicio y fecha en el contexto. Muestra los estilistas disponibles automáticamente usando buscar_servicio. NO digas "He guardado la fecha" ni "Un momento, por favor". Muestra directamente los estilistas.]`;
                    console.log(`   📝 Mensaje procesado con hint para mostrar estilistas`);
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

    const SYSTEM_PROMPT = `Eres el asistente de "${tenantName}" en WhatsApp. Cliente: ${senderName}.
Hoy: ${hoyStr}.${contextInfo}

⚠️ IMPORTANTE - IDENTIFICACIÓN DE CLIENTE:
- Si el usuario proporciona su nombre completo (ej: "Fredy castellanos", "Juan Pérez"), esto es para identificarlo en el sistema.
- Si ya tienes todos los datos de la cita (servicio, estilista, fecha, hora) y el usuario proporciona su nombre, intenta agendar la cita de nuevo.
- El nombre del usuario se usará para actualizar su perfil en el sistema.

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
- ⚠️ CRÍTICO: Si el resultado tiene "stylists" con una lista, SOLO muestra esos estilistas. NO inventes estilistas.

🆕 CASO ESPECIAL - Usuario dice TODO de una vez (servicio + estilista + fecha + hora):
- Usuario dice: "Quiero una cita para mañana 9:30 am para corte con carlos roa"
- ⚠️ IMPORTANTE: Aunque llames buscar_servicio primero, NO muestres la lista de estilistas
- Extrae del mensaje: servicio="corte", estilista="carlos roa", fecha="mañana", hora="09:30"
- Llama buscar_servicio solo para obtener el service_id (sin mostrar resultado al usuario)
- Luego llama verificar_disponibilidad INMEDIATAMENTE con todos los datos
- Responde DIRECTAMENTE: "Carlos está disponible mañana a las 9:30 AM. ¿Confirmo tu cita?"
- NO digas: "Estos estilistas ofrecen..." si el usuario ya especificó un estilista

PASO 2: ELEGIR ESTILISTA / FECHA
- Si el usuario menciona una FECHA después de elegir servicio → Guardar fecha y MOSTRAR ESTILISTAS INMEDIATAMENTE
  → NO digas "He guardado la fecha" ni "Un momento, por favor"
  → Llama buscar_servicio con el service_id del contexto para obtener los estilistas
  → Muestra directamente: "Estos estilistas ofrecen [servicio]: 1. [nombre], 2. [nombre]..."
- Si el usuario elige estilista por nombre (ej: "sofia", "pedro", "carlos"):
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
  * ⚠️ CRÍTICO - Si el salón está cerrado ese día (salonClosed: true): Responde claramente "NO" o "No podemos agendar". Usa el mensaje exacto del resultado.
  * ⚠️ CRÍTICO - Si la hora está fuera del horario laboral: Responde "No, esa hora está fuera de nuestro horario de atención. Horarios disponibles: [lista]"
  * Si está disponible: "[Nombre] tiene disponible [fecha] en estos horarios: [lista]"
  * Si NO está disponible (estilista ocupado): "[Nombre] no está disponible [fecha] a las [hora]. Horarios disponibles: [lista]"
  * Si no encuentra estilista: "No encontré [nombre]. Disponibles: [lista]"
- ⚠️ IMPORTANTE: Usa el formato de 12 horas (AM/PM) para mostrar horarios. Si el resultado tiene "slots_12h", úsalo.
- 🆕 MUESTRA TODOS LOS HORARIOS: Si el resultado tiene "slots_12h" con múltiples horarios, muestra TODOS en una lista numerada.

PASO 4: CONFIRMAR Y AGENDAR
- Usuario elige hora → confirmar
- Usuario dice "sí" o confirma → agendar_cita con la hora correcta

REGLA DE ORO: 
- Si el usuario pide un servicio → LLAMA buscar_servicio INMEDIATAMENTE
- ⚠️ Si el usuario menciona TODO de una vez (servicio + estilista + fecha + hora) → Llama buscar_servicio PERO NO muestres la lista de estilistas, ve directo a verificar_disponibilidad
- Si tienes servicio + estilista + fecha en contexto → LLAMA verificar_disponibilidad AUTOMÁTICAMENTE
- Si el usuario menciona una hora después de elegir estilista → LLAMA verificar_disponibilidad con la hora
- SIEMPRE di el resultado directamente, NO digas "Voy a verificar" ni "Un momento"
- ⚠️ NO muestres listas de estilistas si el usuario ya especificó qué estilista quiere`;

    const FUNCTIONS = [
        {
            type: "function",
            function: {
                name: "buscar_servicio",
                description: "Busca un servicio y devuelve los estilistas que lo ofrecen.",
                parameters: {
                    type: "object",
                    properties: {
                        service: { type: "string", description: "Nombre del servicio" }
                    },
                    required: ["service"]
                }
            }
        },
        {
            type: "function",
            function: {
                name: "verificar_disponibilidad",
                description: "Verifica horarios disponibles. REQUIERE fecha.",
                parameters: {
                    type: "object",
                    properties: {
                        serviceId: { type: "string", description: "UUID del servicio (OBLIGATORIO)" },
                        stylistId: { type: "string", description: "UUID del estilista (opcional)" },
                        stylistName: { type: "string", description: "Nombre del estilista" },
                        date: { type: "string", description: "Fecha en formato YYYY-MM-DD (OBLIGATORIO)" },
                        time: { type: "string", description: "Hora en formato HH:mm (opcional)" }
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
                        serviceId: { type: "string", description: "UUID del servicio" },
                        stylistId: { type: "string", description: "UUID del estilista" },
                        stylistName: { type: "string", description: "Nombre del estilista" },
                        date: { type: "string", description: "Fecha YYYY-MM-DD" },
                        time: { type: "string", description: "Hora HH:mm" }
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

    if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
        const toolCall = assistantMessage.tool_calls[0];
        const functionName = toolCall.function.name;
        const functionArgs = JSON.parse(toolCall.function.arguments || '{}');

        console.log(`\n🔧 [FUNCIÓN] ${functionName} llamada`);
        console.log(`📦 [ARGS]:`, JSON.stringify(functionArgs, null, 2));

        let functionResult;
        let updatedContext = {};

        if (functionName === 'buscar_servicio') {
            const searchDate = bookingContext.date || extractedDateTime.date || null;
            const searchTime = bookingContext.time || extractedDateTime.time || null;
            functionResult = await callSearchService(tenantId, functionArgs.service, searchDate, searchTime);

            if (functionResult.found && functionResult.service && !functionResult.multiple) {
                updatedContext.service = functionResult.service.name;
                updatedContext.service_id = functionResult.service.id;
                console.log(`   ✅ Servicio guardado: ${functionResult.service.name} (${functionResult.service.id})`);
                
                if (bookingContext.date && functionResult.stylists && functionResult.stylists.length > 0) {
                    console.log(`   📅 Fecha ya existe en contexto: ${bookingContext.date}`);
                    functionResult.date_in_context = bookingContext.date;
                    functionResult.hint = `Nota: Ya tienes fecha guardada (${bookingContext.date}). Cuando el usuario elija estilista, usa esa fecha para verificar disponibilidad.`;
                }
            }
            
            if (functionResult.found && functionResult.multiple && functionResult.options) {
                console.log(`   📋 Servicios encontrados (múltiples): ${functionResult.options.map(o => o.name).join(', ')}`);
                functionResult.hint = 'Muestra estas opciones al usuario para que elija.';
            }
        }
        else if (functionName === 'verificar_disponibilidad') {
            const checkParams = {
                serviceId: functionArgs.serviceId || bookingContext.service_id,
                stylistId: functionArgs.stylistId || bookingContext.stylist_id,
                stylistName: functionArgs.stylistName || bookingContext.stylist,
                date: functionArgs.date || bookingContext.date,
                time: functionArgs.time || bookingContext.time
            };

            console.log(`   📋 Params finales:`, JSON.stringify(checkParams));
            functionResult = await callCheckAvailability(tenantId, checkParams);

            if (functionResult.stylist && functionResult.stylist.id) {
                updatedContext.stylist = functionResult.stylist.name;
                updatedContext.stylist_id = functionResult.stylist.id;
                console.log(`   ✅ Estilista guardado: ${functionResult.stylist.name} (${functionResult.stylist.id})`);
            }

            if (functionResult.needsDate && functionResult.stylist) {
                updatedContext.stylist = functionResult.stylist.name;
                updatedContext.stylist_id = functionResult.stylist.id;
            }

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
                    functionResult.matched_stylist = matchedStylist;
                }
            }

            if (functionResult.date && !bookingContext.date) {
                updatedContext.date = functionResult.date;
            }

            if (functionResult.salonClosed) {
                console.log(`   ⚠️ Salón cerrado ese día`);
                if (functionResult.nextAvailableDay) {
                    console.log(`   📅 Siguiente día disponible: ${functionResult.nextAvailableDay}`);
                }
                functionResult.can_book = false;
                functionResult.reason = 'salon_closed';
            }
        }
        else if (functionName === 'agendar_cita') {
            const bookParams = {
                serviceId: functionArgs.serviceId || bookingContext.service_id,
                stylistId: functionArgs.stylistId || bookingContext.stylist_id,
                stylistName: functionArgs.stylistName || bookingContext.stylist,
                date: functionArgs.date || bookingContext.date,
                time: functionArgs.time || bookingContext.time
            };

            console.log(`\n📝 [AGENDAR CITA] Preparando reserva`);
            console.log(`   ClientId: ${clientId}`);
            console.log(`   Params finales:`, JSON.stringify(bookParams, null, 2));

            if (!clientId) {
                console.log(`   ❌ Error: clientId es null o undefined`);
                functionResult = {
                    booked: false,
                    error: 'No se pudo identificar tu número de teléfono. Por favor, asegúrate de que tu número esté registrado en nuestro sistema o contacta directamente con el salón.'
                };
            } else {
                functionResult = await callBookAppointment(tenantId, clientId, bookParams);
            }

            if (functionResult.booked) {
                updatedContext.booked = true;
                console.log(`   ✅ Cita agendada exitosamente`);
            } else {
                console.log(`   ❌ Error al agendar:`, functionResult.error || functionResult.message);
            }
        }

        console.log('\n📋 [FUNCTION RESULT]:', JSON.stringify(functionResult, null, 2).substring(0, 800));

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

    return { response: assistantMessage.content, updatedContext: null };
}

/* =================================================================== */
/* ==============   LLAMADAS A LOS ENDPOINTS   ======================= */
/* =================================================================== */

async function callSearchService(tenantId, service, date = null, time = null) {
    try {
        const whatsappBookingController = require('./Whatsappbookingcontroller');
        const mockReq = { body: { tenantId, service, date, time } };
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
        const mockReq = { body: { tenantId, ...params } };
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

        if (!clientId) {
            console.log('   ❌ Error: clientId no proporcionado');
            return { booked: false, error: 'No se pudo identificar al cliente.' };
        }
        if (!params.serviceId) return { booked: false, error: 'No se ha seleccionado un servicio.' };
        if (!params.stylistId && !params.stylistName) return { booked: false, error: 'No se ha seleccionado un estilista.' };
        if (!params.date) return { booked: false, error: 'No se ha indicado la fecha.' };
        if (!params.time) return { booked: false, error: 'No se ha indicado la hora.' };

        const mockReq = { body: { tenantId, clientId, ...params } };
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
/* ==============   OTROS ENDPOINTS   ================================ */
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