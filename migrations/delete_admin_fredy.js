// Script para eliminar usuarios administradores duplicados de "fredy"
// Uso: node migrations/delete_admin_fredy.js

require('dotenv').config();
const db = require('../src/config/db');

async function deleteAdminFredy() {
    const client = await db.getClient();
    
    try {
        await client.query('BEGIN');
        
        console.log('🔍 Buscando usuarios administradores con nombre "fredy"...\n');
        
        // 1. Buscar usuarios administradores con nombre "fredy"
        const findAdmins = await client.query(`
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
            WHERE role_id = 1
              AND LOWER(first_name) LIKE '%fredy%'
            ORDER BY created_at DESC
        `);
        
        if (findAdmins.rows.length === 0) {
            console.log('ℹ️  No se encontraron usuarios administradores con nombre "fredy".');
            await client.query('COMMIT');
            return;
        }
        
        console.log(`📋 Usuarios administradores encontrados: ${findAdmins.rows.length}\n`);
        console.log('═'.repeat(80));
        
        findAdmins.rows.forEach((user, idx) => {
            console.log(`\n${idx + 1}. Usuario ID: ${user.id}`);
            console.log(`   📛 Nombre: ${user.first_name || '(sin nombre)'} ${user.last_name || ''}`.trim());
            console.log(`   📱 Teléfono: ${user.phone || '(sin teléfono)'}`);
            console.log(`   📧 Email: ${user.email || '(sin email)'}`);
            console.log(`   🏢 Tenant ID: ${user.tenant_id}`);
            console.log(`   👤 Role ID: ${user.role_id} (Administrador)`);
            console.log(`   📅 Creado: ${new Date(user.created_at).toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`);
        });
        
        console.log('\n' + '═'.repeat(80));
        
        // 2. Verificar si tienen citas relacionadas
        const userIds = findAdmins.rows.map(u => u.id);
        const appointments = await client.query(`
            SELECT 
                COUNT(*) as total,
                COUNT(CASE WHEN status IN ('scheduled', 'confirmed', 'pending_approval', 'rescheduled', 'checked_in') THEN 1 END) as activas
            FROM appointments
            WHERE client_id = ANY($1::uuid[])
               OR stylist_id = ANY($1::uuid[])
        `, [userIds]);
        
        const totalAppointments = parseInt(appointments.rows[0].total || 0);
        const activeAppointments = parseInt(appointments.rows[0].activas || 0);
        
        console.log(`\n📋 Citas relacionadas:`);
        console.log(`   Total: ${totalAppointments}`);
        console.log(`   Activas: ${activeAppointments}\n`);
        
        if (totalAppointments > 0) {
            console.log('⚠️  ADVERTENCIA: Estos usuarios tienen citas asociadas.');
            console.log('   Se eliminarán las citas también.\n');
            
            // Mostrar detalles de las citas
            const appointmentDetails = await client.query(`
                SELECT 
                    a.id,
                    a.start_time,
                    a.status,
                    client.first_name || ' ' || COALESCE(client.last_name, '') as client_name,
                    stylist.first_name || ' ' || COALESCE(stylist.last_name, '') as stylist_name
                FROM appointments a
                LEFT JOIN users client ON a.client_id = client.id
                LEFT JOIN users stylist ON a.stylist_id = stylist.id
                WHERE a.client_id = ANY($1::uuid[])
                   OR a.stylist_id = ANY($1::uuid[])
                ORDER BY a.start_time DESC
                LIMIT 10
            `, [userIds]);
            
            if (appointmentDetails.rows.length > 0) {
                console.log('   Detalles de citas (últimas 10):');
                appointmentDetails.rows.forEach((apt, idx) => {
                    const startTime = new Date(apt.start_time).toLocaleString('es-CO', { timeZone: 'America/Bogota' });
                    console.log(`   ${idx + 1}. Cita ID: ${apt.id} - ${startTime} - Estado: ${apt.status}`);
                    if (apt.client_name) console.log(`      Cliente: ${apt.client_name}`);
                    if (apt.stylist_name) console.log(`      Estilista: ${apt.stylist_name}`);
                });
                console.log('');
            }
        }
        
        // 3. Verificar si son los únicos administradores de sus tenants
        console.log('🔍 Verificando si son los únicos administradores de sus tenants...\n');
        for (const user of findAdmins.rows) {
            const otherAdmins = await client.query(`
                SELECT COUNT(*) as total
                FROM users
                WHERE tenant_id = $1
                  AND role_id = 1
                  AND id != $2
            `, [user.tenant_id, user.id]);
            
            const otherAdminsCount = parseInt(otherAdmins.rows[0].total || 0);
            if (otherAdminsCount === 0) {
                console.log(`⚠️  ADVERTENCIA: El usuario ${user.id} es el ÚNICO administrador del tenant ${user.tenant_id}`);
                console.log(`   Si lo eliminas, ese tenant quedará sin administradores.\n`);
            }
        }
        
        // 4. Preguntar confirmación (en producción, esto se haría manualmente)
        console.log('═'.repeat(80));
        console.log('\n⚠️  IMPORTANTE: Este script ELIMINARÁ estos usuarios y sus citas asociadas.');
        console.log('   Si alguno es el único administrador de su tenant, ese tenant quedará sin administradores.');
        console.log('\n💡 Para eliminar, descomenta las líneas de eliminación al final del script.');
        console.log('   O ejecuta manualmente las consultas SQL.\n');
        
        // 5. Mostrar las consultas SQL que se ejecutarían
        console.log('📝 Consultas SQL que se ejecutarían:\n');
        console.log('-- Eliminar citas:');
        console.log(`DELETE FROM appointments WHERE client_id = ANY(ARRAY[${userIds.map(id => `'${id}'`).join(', ')}]::uuid[]) OR stylist_id = ANY(ARRAY[${userIds.map(id => `'${id}'`).join(', ')}]::uuid[]);\n`);
        console.log('-- Eliminar usuarios:');
        console.log(`DELETE FROM users WHERE id = ANY(ARRAY[${userIds.map(id => `'${id}'`).join(', ')}]::uuid[]);\n`);
        
        // IDs específicos a eliminar
        const specificIds = [
            'c01e60fc-96ad-4d6c-a722-ce2916511c3d', // fredy@castellanos.com
            '2c304e7e-f345-4022-8b31-2e8bd1493753'  // fredy@fredy.com.co
        ];
        
        // Filtrar solo los IDs que queremos eliminar
        const idsToDelete = findAdmins.rows
            .filter(u => specificIds.includes(u.id))
            .map(u => u.id);
        
        if (idsToDelete.length === 0) {
            console.log('ℹ️  No se encontraron los IDs específicos para eliminar.');
            await client.query('COMMIT');
            return;
        }
        
        console.log(`\n🗑️  Eliminando ${idsToDelete.length} usuario(s) específico(s)...\n`);
        
        // Verificar citas de estos usuarios específicos
        const specificAppointments = await client.query(`
            SELECT COUNT(*) as total
            FROM appointments
            WHERE client_id = ANY($1::uuid[])
               OR stylist_id = ANY($1::uuid[])
        `, [idsToDelete]);
        
        const specificTotalAppointments = parseInt(specificAppointments.rows[0].total || 0);
        
        // Eliminar citas primero (si las hay)
        if (specificTotalAppointments > 0) {
            const deleteAppointments = await client.query(`
                DELETE FROM appointments
                WHERE client_id = ANY($1::uuid[])
                   OR stylist_id = ANY($1::uuid[])
                RETURNING id
            `, [idsToDelete]);
            
            console.log(`✅ ${deleteAppointments.rowCount} cita(s) eliminada(s)\n`);
        }
        
        // Eliminar los usuarios
        const deleteUsers = await client.query(`
            DELETE FROM users
            WHERE id = ANY($1::uuid[])
            RETURNING id, first_name, last_name, email, tenant_id
        `, [idsToDelete]);
        
        await client.query('COMMIT');
        
        console.log(`✅ ${deleteUsers.rowCount} usuario(s) eliminado(s) exitosamente\n`);
        deleteUsers.rows.forEach((user, idx) => {
            const fullName = `${user.first_name || '(sin nombre)'} ${user.last_name || ''}`.trim();
            console.log(`${idx + 1}. Eliminado: ${fullName} (${user.email || 'sin email'}) - ID: ${user.id}`);
            console.log(`   Tenant ID: ${user.tenant_id} (ahora sin administrador)`);
        });
        
        console.log('\n⚠️  NOTA: Estos tenants ahora están sin administradores.');
        console.log('   Si necesitas administradores para estos tenants, créalos desde el dashboard web.\n');
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('\n❌ Error al buscar/eliminar usuarios:', error.message);
        console.error('Stack:', error.stack);
        throw error;
    } finally {
        client.release();
        await db.pool.end();
    }
}

// Ejecutar solo si se llama directamente
if (require.main === module) {
    deleteAdminFredy()
        .then(() => {
            console.log('\n✅ Proceso completado');
            process.exit(0);
        })
        .catch((error) => {
            console.error('\n❌ Error fatal:', error);
            process.exit(1);
        });
}

module.exports = { deleteAdminFredy };
