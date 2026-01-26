// Script para crear usuario cliente "Fredy Castellanos" con teléfono 304 4180748
// Uso: node migrations/create_fredy_client.js

require('dotenv').config();
const db = require('../src/config/db');
const crypto = require('crypto');

// Datos del cliente
const FIRST_NAME = 'Fredy';
const LAST_NAME = 'Castellanos';
const PHONE_NUMBER = '3044180748'; // Sin espacios para normalizar

async function createFredyClient() {
    const client = await db.getClient();
    
    try {
        await client.query('BEGIN');
        
        console.log('🔍 Verificando si ya existe un cliente con estos datos...\n');
        
        // Normalizar el número de teléfono
        const normalizedPhone = PHONE_NUMBER.replace(/\s+/g, '').replace(/^\+/, '');
        const phoneWithoutCountry = normalizedPhone.replace(/^57/, '');
        
        // 1. Buscar si ya existe un cliente con este teléfono
        const existingClient = await client.query(`
            SELECT 
                id,
                first_name,
                last_name,
                phone,
                tenant_id,
                role_id
            FROM users
            WHERE role_id = 4
              AND (
                phone = $1
                OR phone = $2
                OR phone = $3
                OR phone = $4
                OR REPLACE(REPLACE(phone, ' ', ''), '+', '') = $5
              )
            ORDER BY created_at DESC
            LIMIT 1
        `, [
            PHONE_NUMBER,                                    // 3044180748
            PHONE_NUMBER.replace(/(\d{3})(\d{7})/, '$1 $2'), // 304 4180748
            `+57${phoneWithoutCountry}`,                     // +573044180748
            `57${phoneWithoutCountry}`,                      // 573044180748
            normalizedPhone                                  // Para REPLACE
        ]);
        
        if (existingClient.rows.length > 0) {
            const user = existingClient.rows[0];
            console.log('ℹ️  Ya existe un cliente con este teléfono:');
            console.log(`   ID: ${user.id}`);
            console.log(`   Nombre: ${user.first_name || '(sin nombre)'} ${user.last_name || ''}`.trim());
            console.log(`   Teléfono: ${user.phone}`);
            console.log(`   Tenant: ${user.tenant_id}`);
            console.log('\n💡 Actualizando el nombre si es necesario...\n');
            
            // Actualizar el nombre si es diferente
            if (user.first_name !== FIRST_NAME || user.last_name !== LAST_NAME) {
                await client.query(`
                    UPDATE users
                    SET first_name = $1,
                        last_name = $2,
                        updated_at = NOW()
                    WHERE id = $3
                `, [FIRST_NAME, LAST_NAME, user.id]);
                
                console.log(`✅ Nombre actualizado a: ${FIRST_NAME} ${LAST_NAME}`);
            } else {
                console.log('✅ El nombre ya está correcto.');
            }
            
            await client.query('COMMIT');
            console.log(`\n✅ Cliente existente encontrado y actualizado: ${user.id}`);
            return;
        }
        
        // 2. Buscar si existe un cliente con este nombre (pero diferente teléfono)
        const existingByName = await client.query(`
            SELECT 
                id,
                first_name,
                last_name,
                phone,
                tenant_id
            FROM users
            WHERE role_id = 4
              AND LOWER(first_name) = LOWER($1)
              AND LOWER(COALESCE(last_name, '')) = LOWER($2)
            ORDER BY created_at DESC
            LIMIT 1
        `, [FIRST_NAME, LAST_NAME]);
        
        if (existingByName.rows.length > 0) {
            const user = existingByName.rows[0];
            console.log('ℹ️  Se encontró un cliente con este nombre pero diferente teléfono:');
            console.log(`   ID: ${user.id}`);
            console.log(`   Nombre: ${user.first_name} ${user.last_name}`);
            console.log(`   Teléfono actual: ${user.phone}`);
            console.log(`   Teléfono nuevo: ${PHONE_NUMBER}`);
            console.log('\n💡 Actualizando el teléfono...\n');
            
            await client.query(`
                UPDATE users
                SET phone = $1,
                    updated_at = NOW()
                WHERE id = $2
            `, [PHONE_NUMBER, user.id]);
            
            await client.query('COMMIT');
            console.log(`✅ Teléfono actualizado. Cliente: ${user.id}`);
            return;
        }
        
        // 3. Obtener el primer tenant disponible (o usar uno específico)
        const tenantResult = await client.query(`
            SELECT id, name
            FROM tenants
            ORDER BY created_at ASC
            LIMIT 1
        `);
        
        if (tenantResult.rows.length === 0) {
            throw new Error('No hay tenants disponibles en la base de datos');
        }
        
        const tenantId = tenantResult.rows[0].id;
        const tenantName = tenantResult.rows[0].name;
        
        console.log(`📋 Creando nuevo cliente en tenant: ${tenantName} (${tenantId})\n`);
        
        // 4. Crear el nuevo cliente (usando el mismo formato que whatsappController.js)
        const userId = crypto.randomUUID();
        const clientEmail = `${PHONE_NUMBER}@whatsapp.temp`; // Mismo formato que whatsappController
        const insertResult = await client.query(`
            INSERT INTO users (
                id,
                tenant_id,
                role_id,
                first_name,
                last_name,
                phone,
                email,
                password_hash
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'whatsapp')
            RETURNING id, first_name, last_name, phone, tenant_id, email
        `, [
            userId,
            tenantId,
            4, // role_id = 4 (cliente)
            FIRST_NAME,
            LAST_NAME,
            PHONE_NUMBER,
            clientEmail
        ]);
        
        await client.query('COMMIT');
        
        const newUser = insertResult.rows[0];
        console.log('✅ Cliente creado exitosamente:');
        console.log(`   ID: ${newUser.id}`);
        console.log(`   Nombre: ${newUser.first_name} ${newUser.last_name}`);
        console.log(`   Teléfono: ${newUser.phone}`);
        console.log(`   Tenant: ${newUser.tenant_id}`);
        console.log(`   Role: Cliente (role_id = 4)`);
        console.log('\n✅ El bot de WhatsApp ahora podrá identificar a este cliente correctamente.');
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('\n❌ Error al crear/actualizar cliente:', error.message);
        console.error('Stack:', error.stack);
        throw error;
    } finally {
        client.release();
        await db.pool.end();
    }
}

// Ejecutar solo si se llama directamente
if (require.main === module) {
    createFredyClient()
        .then(() => {
            console.log('\n✅ Proceso completado');
            process.exit(0);
        })
        .catch((error) => {
            console.error('\n❌ Error fatal:', error);
            process.exit(1);
        });
}

module.exports = { createFredyClient };
