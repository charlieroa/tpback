// Script para buscar usuario por número de teléfono y/o nombre
// Uso: node migrations/search_user.js

require('dotenv').config();
const db = require('../src/config/db');

// Número de teléfono a buscar (puede tener espacios o formato internacional)
const PHONE_NUMBER = '304 4180748'; // También buscará: 3044180748, +573044180748, etc.
// Nombre a buscar (opcional)
const SEARCH_NAME = 'Fredy Castellanos';

async function searchUser() {
    const client = await db.getClient();
    
    try {
        // Normalizar el número de teléfono (quitar espacios, +, etc.)
        const normalizedPhone = PHONE_NUMBER.replace(/\s+/g, '').replace(/^\+/, '');
        const phoneWithoutCountry = normalizedPhone.replace(/^57/, ''); // Quitar código de país si existe
        
        console.log('🔍 Buscando usuarios:');
        console.log(`   📱 Teléfono: ${PHONE_NUMBER}`);
        console.log(`   👤 Nombre: ${SEARCH_NAME}`);
        console.log(`   🔧 Búsqueda normalizada: ${normalizedPhone} (sin código país: ${phoneWithoutCountry})`);
        console.log('');
        
        // 1. Buscar el usuario por número de teléfono Y/O por nombre
        const findUser = await client.query(`
            SELECT 
                id,
                first_name,
                last_name,
                phone,
                email,
                tenant_id,
                role_id,
                created_at,
                updated_at
            FROM users
            WHERE (
                -- Búsqueda por teléfono (múltiples formatos)
                phone = $1
                OR phone = $2
                OR phone = $3
                OR phone = $4
                OR phone = $5
                OR phone = $6
                OR phone = $7
                OR phone LIKE $8
                OR phone LIKE $9
                OR REPLACE(REPLACE(phone, ' ', ''), '+', '') = $10
                OR REPLACE(REPLACE(phone, ' ', ''), '+', '') LIKE $11
            )
            OR (
                -- Búsqueda por nombre
                (LOWER(first_name) = LOWER($12) AND LOWER(COALESCE(last_name, '')) = LOWER($13))
                OR LOWER(first_name || ' ' || COALESCE(last_name, '')) LIKE LOWER($14)
                OR LOWER(COALESCE(last_name, '') || ' ' || first_name) LIKE LOWER($14)
            )
            ORDER BY created_at DESC
        `, [
            PHONE_NUMBER,                                    // 304 4180748
            PHONE_NUMBER.replace(/\s+/g, ''),                // 3044180748
            normalizedPhone,                                 // 3044180748 (sin +)
            `+57${phoneWithoutCountry}`,                     // +573044180748
            `+${phoneWithoutCountry}`,                       // +3044180748
            `57${phoneWithoutCountry}`,                      // 573044180748
            phoneWithoutCountry,                             // 3044180748
            `%${phoneWithoutCountry}%`,                      // Contiene el número
            `%${phoneWithoutCountry.slice(-10)}%`,          // Últimos 10 dígitos
            normalizedPhone,                                 // Para REPLACE
            `%${phoneWithoutCountry}%`,                      // Para REPLACE LIKE
            SEARCH_NAME.split(' ')[0] || '',                // Fredy
            SEARCH_NAME.split(' ').slice(1).join(' ') || '', // Castellanos
            `%${SEARCH_NAME}%`                              // Contiene el nombre completo
        ]);
        
        if (findUser.rows.length === 0) {
            console.log('ℹ️  No se encontró ningún usuario con ese número de teléfono o nombre exacto.');
            console.log('💡 Intentando búsqueda más flexible...\n');
            
            // Búsqueda más flexible (solo últimos dígitos del teléfono o parte del nombre)
            // Priorizar clientes (role_id = 4) pero también mostrar otros roles
            const flexibleSearch = await client.query(`
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
                WHERE (
                    phone LIKE $1
                    OR phone LIKE $2
                    OR phone LIKE $3
                    OR phone LIKE $4
                    OR REPLACE(REPLACE(phone, ' ', ''), '+', '') LIKE $5
                )
                OR (
                    role_id = 4 AND (
                        LOWER(first_name) LIKE $6
                        OR LOWER(last_name) LIKE $7
                        OR LOWER(first_name || ' ' || COALESCE(last_name, '')) LIKE $8
                    )
                )
                ORDER BY 
                    CASE WHEN phone LIKE $1 OR phone LIKE $2 THEN 1 ELSE 2 END,
                    role_id = 4 DESC,
                    created_at DESC
                LIMIT 20
            `, [
                `%${phoneWithoutCountry.slice(-8)}%`,  // Últimos 8 dígitos
                `%${phoneWithoutCountry.slice(-7)}%`,  // Últimos 7 dígitos
                `%${phoneWithoutCountry.slice(-6)}%`,  // Últimos 6 dígitos
                `%4180748%`,  // Parte del número
                `%${phoneWithoutCountry}%`,  // Número completo sin espacios
                `%${SEARCH_NAME.split(' ')[0].toLowerCase()}%`,  // Fredy
                `%${SEARCH_NAME.split(' ').slice(1).join(' ').toLowerCase()}%`,  // Castellanos
                `%${SEARCH_NAME.toLowerCase()}%`  // Fredy Castellanos
            ]);
            
            if (flexibleSearch.rows.length > 0) {
                console.log(`📋 Usuarios encontrados con búsqueda flexible: ${flexibleSearch.rows.length}\n`);
                console.log('═'.repeat(80));
                
                flexibleSearch.rows.forEach((user, idx) => {
                    console.log(`\n${idx + 1}. Usuario ID: ${user.id}`);
                    console.log(`   📛 Nombre: ${user.first_name || '(sin nombre)'} ${user.last_name || ''}`.trim());
                    console.log(`   📱 Teléfono: ${user.phone || '(sin teléfono)'}`);
                    console.log(`   📧 Email: ${user.email || '(sin email)'}`);
                    console.log(`   🏢 Tenant ID: ${user.tenant_id}`);
                    console.log(`   👤 Role ID: ${user.role_id}`);
                    console.log(`   📅 Creado: ${new Date(user.created_at).toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`);
                });
                
                console.log('\n' + '═'.repeat(80));
                return;
            }
            
            console.log('ℹ️  No se encontró ningún usuario con búsqueda flexible tampoco.');
            console.log('💡 Verifica que el número/nombre esté correcto o que el formato en la BD sea diferente.');
            console.log('');
            console.log('💡 Prueba buscar manualmente con SQL:');
            console.log(`   SELECT * FROM users WHERE phone LIKE '%${phoneWithoutCountry.slice(-8)}%' OR LOWER(first_name) LIKE '%${SEARCH_NAME.split(' ')[0].toLowerCase()}%';`);
            return;
        }
        
        console.log(`📋 Usuarios encontrados: ${findUser.rows.length}\n`);
        console.log('═'.repeat(80));
        
        findUser.rows.forEach((user, idx) => {
            console.log(`\n${idx + 1}. Usuario ID: ${user.id}`);
            console.log(`   📛 Nombre: ${user.first_name || '(sin nombre)'} ${user.last_name || ''}`.trim());
            console.log(`   📱 Teléfono: ${user.phone || '(sin teléfono)'}`);
            console.log(`   📧 Email: ${user.email || '(sin email)'}`);
            console.log(`   🏢 Tenant ID: ${user.tenant_id}`);
            console.log(`   👤 Role ID: ${user.role_id}`);
            console.log(`   📅 Creado: ${new Date(user.created_at).toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`);
            console.log(`   🔄 Actualizado: ${new Date(user.updated_at).toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`);
        });
        
        console.log('\n' + '═'.repeat(80));
        
        // 2. Verificar citas relacionadas
        const userIds = findUser.rows.map(u => u.id);
        const appointments = await client.query(`
            SELECT 
                a.id,
                a.start_time,
                a.end_time,
                a.status,
                a.service_id,
                a.client_id,
                a.stylist_id,
                s.name as service_name,
                client.first_name || ' ' || COALESCE(client.last_name, '') as client_name,
                stylist.first_name || ' ' || COALESCE(stylist.last_name, '') as stylist_name
            FROM appointments a
            LEFT JOIN services s ON a.service_id = s.id
            LEFT JOIN users client ON a.client_id = client.id
            LEFT JOIN users stylist ON a.stylist_id = stylist.id
            WHERE a.client_id = ANY($1::uuid[])
               OR a.stylist_id = ANY($1::uuid[])
            ORDER BY a.start_time DESC
            LIMIT 20
        `, [userIds]);
        
        if (appointments.rows.length > 0) {
            console.log(`\n📋 Citas relacionadas (mostrando últimas 20):\n`);
            appointments.rows.forEach((apt, idx) => {
                const startTime = new Date(apt.start_time).toLocaleString('es-CO', { timeZone: 'America/Bogota' });
                console.log(`${idx + 1}. Cita ID: ${apt.id}`);
                console.log(`   📅 Fecha/Hora: ${startTime}`);
                console.log(`   📊 Estado: ${apt.status}`);
                console.log(`   💇 Servicio: ${apt.service_name || '(sin servicio)'}`);
                if (apt.client_name) console.log(`   👤 Cliente: ${apt.client_name}`);
                if (apt.stylist_name) console.log(`   ✂️ Estilista: ${apt.stylist_name}`);
                console.log('');
            });
            
            const totalCount = await client.query(`
                SELECT COUNT(*) as total
                FROM appointments
                WHERE client_id = ANY($1::uuid[])
                   OR stylist_id = ANY($1::uuid[])
            `, [userIds]);
            
            const total = parseInt(totalCount.rows[0].total || 0);
            if (total > 20) {
                console.log(`   ... y ${total - 20} citas más\n`);
            }
        } else {
            console.log('\n📋 No hay citas relacionadas con este usuario.\n');
        }
        
    } catch (error) {
        console.error('\n❌ Error al buscar usuario:', error.message);
        console.error('Stack:', error.stack);
        throw error;
    } finally {
        client.release();
        await db.pool.end();
    }
}

// Ejecutar solo si se llama directamente
if (require.main === module) {
    searchUser()
        .then(() => {
            console.log('\n✅ Búsqueda completada');
            process.exit(0);
        })
        .catch((error) => {
            console.error('\n❌ Error fatal:', error);
            process.exit(1);
        });
}

module.exports = { searchUser };
