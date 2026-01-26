require('dotenv').config();
const db = require('./src/config/db');

async function checkStylistUsers() {
  try {
    const result = await db.query(
      `SELECT id, first_name, last_name, email, role_id, tenant_id, status
       FROM users
       WHERE role_id = 3
       ORDER BY created_at DESC
       LIMIT 10`
    );

    console.log('\n=== USUARIOS ESTILISTAS EN LA BASE DE DATOS ===\n');
    
    if (result.rows.length === 0) {
      console.log('No se encontraron usuarios estilistas en la base de datos.');
      console.log('\nPara crear un usuario estilista de prueba, puedes usar:');
      console.log('POST /api/users');
      console.log('Body: {');
      console.log('  "role_id": 3,');
      console.log('  "first_name": "Juan",');
      console.log('  "last_name": "Pérez",');
      console.log('  "email": "estilista@test.com",');
      console.log('  "password": "123456",');
      console.log('  "tenant_id": 1');
      console.log('}');
    } else {
      result.rows.forEach((user, index) => {
        console.log(`${index + 1}. ${user.first_name} ${user.last_name || ''}`);
        console.log(`   Email: ${user.email}`);
        console.log(`   ID: ${user.id}`);
        console.log(`   Tenant ID: ${user.tenant_id}`);
        console.log(`   Status: ${user.status || 'active'}`);
        console.log('');
      });
    }
    
    await db.pool.end();
    process.exit(0);
  } catch (error) {
    console.error('Error al consultar usuarios:', error);
    await db.pool.end();
    process.exit(1);
  }
}

checkStylistUsers();
