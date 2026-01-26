// Script para eliminar usuario por nombre
// Uso: node migrations/delete_phone_user.js

require('dotenv').config();
const db = require('../src/config/db');

// Nombre a buscar
const FIRST_NAME = 'Fredy';
const LAST_NAME = 'Castellanos';

async function deleteUserByPhone() {
    const client = await db.getClient();
    
    try {
        await client.query('BEGIN');
        
        console.log('🔍 Buscando usuario:', `${FIRST_NAME} ${LAST_NAME}`);
        console.log('   (Buscará variaciones del nombre)\n');
        
        // 1. Buscar el usuario por nombre (case-insensitive, con variaciones)
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
                (LOWER(first_name) = LOWER($1) AND LOWER(last_name) = LOWER($2))
                OR (LOWER(first_name) = LOWER($1) AND (last_name IS NULL OR last_name = ''))
                OR (LOWER(first_name) LIKE LOWER($3) AND LOWER(last_name) LIKE LOWER($4))
                OR (LOWER(first_name || ' ' || COALESCE(last_name, '')) LIKE LOWER($5))
            )
            ORDER BY created_at DESC
        `, [
            FIRST_NAME,                                    // Fredy
            LAST_NAME,                                     // Castellanos
            `%${FIRST_NAME}%`,                             // Contiene Fredy
            `%${LAST_NAME}%`,                              // Contiene Castellanos
            `%${FIRST_NAME}%${LAST_NAME}%`                 // Contiene ambos
        ]);
        
        if (findUser.rows.length === 0) {
            console.log('ℹ️  No se encontró ningún usuario con ese nombre.');
            console.log('💡 Verifica que el nombre esté correcto o que esté escrito de forma diferente en la BD.');
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
        
        console.log('\n✅ Proceso completado. El usuario será recreado automáticamente con el display name correcto cuando envíe un mensaje.');
        console.log(`\n📱 Teléfono(s) eliminado(s): ${deleteUsers.rows.map(u => u.phone).join(', ')}`);
        
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
