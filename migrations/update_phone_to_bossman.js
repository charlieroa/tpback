// Script para actualizar/crear usuario con número de teléfono y nombre BOSSMAN
// Uso: node migrations/update_phone_to_bossman.js

require('dotenv').config();
const db = require('../src/config/db');

// Número de teléfono a buscar/actualizar
const PHONE_NUMBER = '3044180748';
// Nombre a asignar
const FIRST_NAME = 'BOSSMAN';
const LAST_NAME = null;

async function updatePhoneToBossman() {
    const client = await db.getClient();
    
    try {
        await client.query('BEGIN');
        
        console.log('🔍 Buscando usuario con teléfono:', PHONE_NUMBER);
        console.log(`   (También buscará: 304 4180748, +573044180748, etc.)`);
        console.log(`   📝 Nombre a asignar: ${FIRST_NAME}`);
        console.log('');
        
        // 1. Buscar el usuario con diferentes variaciones del número
        const findUser = await db.query(`
            SELECT 
                id,
                first_name,
                last_name,
                phone,
                email,
                tenant_id,
                role_id,
                created_at
            FROM users
            WHERE phone = $1
               OR phone = $2
               OR phone = $3
               OR phone = $4
               OR phone LIKE $5
               OR phone LIKE $6
            ORDER BY created_at DESC
            LIMIT 1
        `, [
            PHONE_NUMBER,                                    // 3044180748
            PHONE_NUMBER.replace(/(\d{3})(\d{7})/, '$1 $2'), // 304 4180748
            `+57${PHONE_NUMBER}`,                            // +573044180748
            `+${PHONE_NUMBER}`,                              // +3044180748
            `%${PHONE_NUMBER}%`,                             // Contiene el número
            `%${PHONE_NUMBER.slice(-10)}%`                    // Últimos 10 dígitos
        ]);
        
        if (findUser.rows.length > 0) {
            // Usuario existe, actualizar
            const user = findUser.rows[0];
            console.log('📋 Usuario encontrado:');
            console.log(`   ID: ${user.id}`);
            console.log(`   Nombre actual: ${user.first_name || '(sin nombre)'} ${user.last_name || ''}`);
            console.log(`   Teléfono: ${user.phone}`);
            console.log(`   Tenant: ${user.tenant_id}`);
            console.log(`   Email: ${user.email || '(sin email)'}`);
            console.log('');
            
            // Actualizar el nombre
            const updateResult = await db.query(`
                UPDATE users
                SET first_name = $1,
                    last_name = $2,
                    updated_at = NOW()
                WHERE id = $3
                RETURNING id, first_name, last_name, phone, tenant_id
            `, [FIRST_NAME, LAST_NAME, user.id]);
            
            if (updateResult.rows.length > 0) {
                const updated = updateResult.rows[0];
                await client.query('COMMIT');
                console.log('✅ Usuario actualizado exitosamente:');
                console.log(`   ID: ${updated.id}`);
                console.log(`   Nombre: ${updated.first_name} ${updated.last_name || ''}`);
                console.log(`   Teléfono: ${updated.phone}`);
                console.log(`   Tenant: ${updated.tenant_id}`);
                console.log('');
                console.log('✅ Proceso completado.');
            } else {
                await client.query('ROLLBACK');
                console.log('❌ Error: No se pudo actualizar el usuario.');
            }
        } else {
            // Usuario no existe, necesitamos crear uno
            console.log('ℹ️  No se encontró ningún usuario con ese número de teléfono.');
            console.log('💡 Necesito crear un nuevo usuario.');
            console.log('');
            
            // Buscar si hay algún usuario "BOSSMAN" existente para usar su tenant
            const bossmanResult = await db.query(`
                SELECT tenant_id, COUNT(*) as count
                FROM users
                WHERE LOWER(first_name) = 'bossman'
                GROUP BY tenant_id
                ORDER BY count DESC
                LIMIT 1
            `);
            
            let tenantId;
            let tenantName;
            
            if (bossmanResult.rows.length > 0) {
                // Usar el tenant donde ya hay un BOSSMAN
                tenantId = bossmanResult.rows[0].tenant_id;
                const tenantInfo = await db.query('SELECT id, name FROM tenants WHERE id = $1', [tenantId]);
                tenantName = tenantInfo.rows[0]?.name || tenantId;
                console.log(`📋 Usando tenant del BOSSMAN existente: ${tenantName} (${tenantId})`);
            } else {
                // Buscar el primer tenant disponible
                const tenantResult = await db.query(`
                    SELECT id, name FROM tenants 
                    ORDER BY created_at ASC 
                    LIMIT 1
                `);
                
                if (tenantResult.rows.length === 0) {
                    await client.query('ROLLBACK');
                    console.log('❌ Error: No hay tenants disponibles en la base de datos.');
                    console.log('   Por favor, crea un tenant primero.');
                    return;
                }
                
                tenantId = tenantResult.rows[0].id;
                tenantName = tenantResult.rows[0].name;
                console.log(`📋 Usando primer tenant disponible: ${tenantName} (${tenantId})`);
            }
            console.log('');
            
            // Crear el nuevo usuario
            const crypto = require('crypto');
            let newUser;
            
            try {
                // Intentar INSERT sin especificar id (usará el DEFAULT)
                newUser = await db.query(
                    `INSERT INTO users (tenant_id, role_id, first_name, last_name, phone, email, password_hash)
                     VALUES ($1, 4, $2, $3, $4, $5, 'whatsapp')
                     RETURNING id, first_name, last_name, phone, tenant_id`,
                    [tenantId, FIRST_NAME, LAST_NAME, PHONE_NUMBER, `${PHONE_NUMBER}@whatsapp.temp`]
                );
            } catch (defaultError) {
                // Si el DEFAULT no funciona, generar UUID explícitamente
                if (defaultError.message.includes('null value') || defaultError.message.includes('id')) {
                    console.log(`   ⚠️ DEFAULT no funcionó, generando UUID explícitamente`);
                    try {
                        // Intentar usar gen_random_uuid() de PostgreSQL
                        newUser = await db.query(
                            `INSERT INTO users (id, tenant_id, role_id, first_name, last_name, phone, email, password_hash)
                             VALUES (gen_random_uuid(), $1, 4, $2, $3, $4, $5, 'whatsapp')
                             RETURNING id, first_name, last_name, phone, tenant_id`,
                            [tenantId, FIRST_NAME, LAST_NAME, PHONE_NUMBER, `${PHONE_NUMBER}@whatsapp.temp`]
                        );
                    } catch (genUuidError) {
                        // Si gen_random_uuid() no está disponible, usar crypto.randomUUID()
                        console.log(`   ⚠️ gen_random_uuid() no disponible, usando crypto.randomUUID()`);
                        const newUserId = crypto.randomUUID();
                        newUser = await db.query(
                            `INSERT INTO users (id, tenant_id, role_id, first_name, last_name, phone, email, password_hash)
                             VALUES ($1, $2, 4, $3, $4, $5, $6, 'whatsapp')
                             RETURNING id, first_name, last_name, phone, tenant_id`,
                            [newUserId, tenantId, FIRST_NAME, LAST_NAME, PHONE_NUMBER, `${PHONE_NUMBER}@whatsapp.temp`]
                        );
                    }
                } else {
                    throw defaultError;
                }
            }
            
            if (newUser.rows.length > 0) {
                const created = newUser.rows[0];
                await client.query('COMMIT');
                console.log('✅ Usuario creado exitosamente:');
                console.log(`   ID: ${created.id}`);
                console.log(`   Nombre: ${created.first_name} ${created.last_name || ''}`);
                console.log(`   Teléfono: ${created.phone}`);
                console.log(`   Tenant: ${created.tenant_id}`);
                console.log('');
                console.log('✅ Proceso completado.');
            } else {
                await client.query('ROLLBACK');
                console.log('❌ Error: No se pudo crear el usuario.');
            }
        }
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('\n❌ Error:', error.message);
        console.error('Stack:', error.stack);
        throw error;
    } finally {
        client.release();
        await db.pool.end();
    }
}

// Ejecutar solo si se llama directamente
if (require.main === module) {
    updatePhoneToBossman()
        .then(() => {
            console.log('\n✅ Script completado');
            process.exit(0);
        })
        .catch((error) => {
            console.error('\n❌ Error fatal:', error);
            process.exit(1);
        });
}

module.exports = { updatePhoneToBossman };
