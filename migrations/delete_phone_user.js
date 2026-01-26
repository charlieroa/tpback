// Script para eliminar usuario por número de teléfono y/o nombre
// Uso: node migrations/delete_phone_user.js

require('dotenv').config();
const db = require('../src/config/db');

// Número de teléfono a buscar (sin espacios)
const PHONE_NUMBER = '3044180748';
// Nombre a buscar (opcional)
const SEARCH_NAME = 'BOSSMAN';

async function deleteUserByPhone() {
    const client = await db.getClient();
    
    try {
        await client.query('BEGIN');
        
        console.log('🔍 Buscando usuarios:');
        console.log(`   📱 Teléfono: ${PHONE_NUMBER} (también buscará: 304 4180748, +573044180748, etc.)`);
        console.log(`   👤 Nombre: ${SEARCH_NAME} (case-insensitive)`);
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
                created_at
            FROM users
            WHERE (
                -- Búsqueda por teléfono
                phone = $1
                OR phone = $2
                OR phone = $3
                OR phone = $4
                OR phone LIKE $5
                OR phone LIKE $6
            )
            OR (
                -- Búsqueda por nombre
                LOWER(first_name) = LOWER($7)
                OR LOWER(first_name || ' ' || COALESCE(last_name, '')) LIKE LOWER($8)
            )
            ORDER BY created_at DESC
        `, [
            PHONE_NUMBER,                                    // 3044180748
            PHONE_NUMBER.replace(/(\d{3})(\d{7})/, '$1 $2'), // 304 4180748
            `+57${PHONE_NUMBER}`,                            // +573044180748
            `+${PHONE_NUMBER}`,                              // +3044180748
            `%${PHONE_NUMBER}%`,                             // Contiene el número
            `%${PHONE_NUMBER.slice(-10)}%`,                  // Últimos 10 dígitos
            SEARCH_NAME,                                     // BOSSMAN
            `%${SEARCH_NAME}%`                               // Contiene BOSSMAN
        ]);
        
        if (findUser.rows.length === 0) {
            console.log('ℹ️  No se encontró ningún usuario con ese número de teléfono o nombre.');
            console.log('💡 Verifica que el número/nombre esté correcto o que el formato en la BD sea diferente.');
            await client.query('COMMIT');
            return;
        }
        
        console.log(`📋 Usuarios encontrados: ${findUser.rows.length}\n`);
        findUser.rows.forEach((user, idx) => {
            console.log(`${idx + 1}. ID: ${user.id}`);
            console.log(`   Nombre: ${user.first_name || '(sin nombre)'} ${user.last_name || ''}`);
            console.log(`   Teléfono: ${user.phone}`);
            console.log(`   Email: ${user.email || '(sin email)'}`);
            console.log(`   Tenant: ${user.tenant_id}`);
            console.log(`   Creado: ${new Date(user.created_at).toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`);
            console.log('');
        });
        
        // 2. Verificar citas relacionadas
        const appointments = await client.query(`
            SELECT 
                COUNT(*) as total,
                COUNT(CASE WHEN status IN ('scheduled', 'confirmed', 'pending_approval', 'rescheduled', 'checked_in') THEN 1 END) as activas
            FROM appointments
            WHERE client_id = ANY($1::uuid[])
               OR stylist_id = ANY($1::uuid[])
        `, [findUser.rows.map(u => u.id)]);
        
        const totalAppointments = parseInt(appointments.rows[0].total || 0);
        const activeAppointments = parseInt(appointments.rows[0].activas || 0);
        
        console.log(`📋 Citas relacionadas:`);
        console.log(`   Total: ${totalAppointments}`);
        console.log(`   Activas: ${activeAppointments}\n`);
        
        if (totalAppointments > 0) {
            console.log('⚠️  ADVERTENCIA: Este usuario tiene citas asociadas.');
            console.log('   Se eliminarán las citas también.\n');
        }
        
        // 3. Eliminar citas primero
        if (totalAppointments > 0) {
            const deleteAppointments = await client.query(`
                DELETE FROM appointments
                WHERE client_id = ANY($1::uuid[])
                   OR stylist_id = ANY($1::uuid[])
                RETURNING id
            `, [findUser.rows.map(u => u.id)]);
            
            console.log(`✅ ${deleteAppointments.rowCount} cita(s) eliminada(s)\n`);
        }
        
        // 4. Eliminar el usuario
        const deleteUsers = await client.query(`
            DELETE FROM users
            WHERE id = ANY($1::uuid[])
            RETURNING id, first_name, last_name, phone
        `, [findUser.rows.map(u => u.id)]);
        
        await client.query('COMMIT');
        
        console.log(`✅ ${deleteUsers.rowCount} usuario(s) eliminado(s) exitosamente\n`);
        deleteUsers.rows.forEach((user, idx) => {
            const fullName = `${user.first_name || '(sin nombre)'} ${user.last_name || ''}`.trim();
            console.log(`${idx + 1}. Eliminado: ${fullName} (${user.phone}) - ID: ${user.id}`);
        });
        
        console.log('\n✅ Proceso completado. Los usuarios serán recreados automáticamente con el display name correcto cuando envíen un mensaje.');
        if (deleteUsers.rows.length > 0) {
            const phones = deleteUsers.rows.map(u => u.phone).filter(p => p).join(', ');
            if (phones) {
                console.log(`\n📱 Teléfono(s) eliminado(s): ${phones}`);
            }
        }
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('\n❌ Error al eliminar usuario:', error.message);
        console.error('Stack:', error.stack);
        throw error;
    } finally {
        client.release();
        await db.pool.end();
    }
}

// Ejecutar solo si se llama directamente
if (require.main === module) {
    deleteUserByPhone()
        .then(() => {
            console.log('\n✅ Script completado');
            process.exit(0);
        })
        .catch((error) => {
            console.error('\n❌ Error fatal:', error);
            process.exit(1);
        });
}

module.exports = { deleteUserByPhone };
