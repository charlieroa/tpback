require('dotenv').config();
const db = require('./src/config/db');
const bcrypt = require('bcryptjs');

async function checkUserPassword() {
  try {
    const email = 'test.estilista@example.com';
    const password = 'test123456';
    
    console.log(`\n=== Verificando usuario: ${email} ===\n`);
    
    const result = await db.query(
      `SELECT id, first_name, last_name, email, password_hash, role_id, tenant_id, status
       FROM users
       WHERE LOWER(email) = $1`,
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      console.log('❌ Usuario no encontrado en la base de datos.');
      console.log('\n¿Quieres crear este usuario?');
      return;
    }

    const user = result.rows[0];
    console.log(`✅ Usuario encontrado:`);
    console.log(`   Nombre: ${user.first_name} ${user.last_name || ''}`);
    console.log(`   Email: ${user.email}`);
    console.log(`   Role ID: ${user.role_id}`);
    console.log(`   Status: ${user.status || 'active'}`);
    console.log(`   Tenant ID: ${user.tenant_id}`);
    
    if (user.role_id !== 3) {
      console.log(`\n⚠️  ADVERTENCIA: Este usuario NO es un estilista (role_id = ${user.role_id}, debería ser 3)`);
    }
    
    console.log(`\n🔐 Verificando contraseña...`);
    const isMatch = await bcrypt.compare(password, user.password_hash);
    
    if (isMatch) {
      console.log(`✅ Contraseña CORRECTA`);
    } else {
      console.log(`❌ Contraseña INCORRECTA`);
      console.log(`\nLa contraseña en la base de datos está hasheada.`);
      console.log(`Si necesitas cambiar la contraseña, puedes usar:`);
      console.log(`PUT /api/users/${user.id}`);
      console.log(`Body: { "password": "test123456" }`);
    }
    
    await db.pool.end();
    process.exit(0);
  } catch (error) {
    console.error('Error al verificar usuario:', error);
    await db.pool.end();
    process.exit(1);
  }
}

checkUserPassword();
