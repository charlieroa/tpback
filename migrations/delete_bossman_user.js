// Script para eliminar el usuario BOSSMAN de la base de datos
require('dotenv').config();
const db = require('../src/config/db');

async function deleteBossmanUser() {
    const client = await db.getClient();
    
    try {
        await client.query('BEGIN');
        
        console.log('🔍 Buscando usuario BOSSMAN...\n');
        
        // 1. Buscar el usuario
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
            WHERE LOWER(first_name) = 'bossman'
               OR phone = '84366076207203'
            ORDER BY created_at DESC
        `);
        
        if (findUser.rows.length === 0) {
            console.log('ℹ️  No se encontró ningún usuario BOSSMAN o con el teléfono 84366076207203');
            await client.query('COMMIT');
            return;
        }
        
        console.log(`📋 Usuarios encontrados: ${findUser.rows.length}\n`);
        findUser.rows.forEach((user, idx) => {
            console.log(`${idx + 1}. ID: ${user.id}`);
            console.log(`   Nombre: ${user.first_name} ${user.last_name || ''}`);
            console.log(`   Teléfono: ${user.phone}`);
            console.log(`   Email: ${user.email}`);
            console.log(`   Tenant: ${user.tenant_id}`);
            console.log(`   Creado: ${user.created_at}`);
            console.log('');
        });
        
        // 2. Verificar citas relacionadas
        const appointments = await client.query(`
            SELECT 
                COUNT(*) as total,
                COUNT(CASE WHEN status IN ('scheduled', 'confirmed', 'pending_approval') THEN 1 END) as activas
            FROM appointments
            WHERE client_id = ANY($1::uuid[])
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
                RETURNING id
            `, [findUser.rows.map(u => u.id)]);
            
            console.log(`✅ ${deleteAppointments.rowCount} cita(s) eliminada(s)\n`);
        }
        
        // 4. Eliminar el usuario
        const deleteUsers = await client.query(`
            DELETE FROM users
            WHERE LOWER(first_name) = 'bossman'
               OR phone = '84366076207203'
            RETURNING id, first_name, phone
        `);
        
        await client.query('COMMIT');
        
        console.log(`✅ ${deleteUsers.rowCount} usuario(s) eliminado(s) exitosamente\n`);
        deleteUsers.rows.forEach((user, idx) => {
            console.log(`${idx + 1}. Eliminado: ${user.first_name} (${user.phone}) - ID: ${user.id}`);
        });
        
        console.log('\n✅ Proceso completado. El usuario será recreado automáticamente con el display name correcto cuando envíe un mensaje.');
        
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
    deleteBossmanUser()
        .then(() => {
            console.log('\n✅ Script completado');
            process.exit(0);
        })
        .catch((error) => {
            console.error('\n❌ Error fatal:', error);
            process.exit(1);
        });
}

module.exports = { deleteBossmanUser };
