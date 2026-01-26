// Script para ejecutar migraciones de base de datos
require('dotenv').config();
const db = require('../src/config/db');
const fs = require('fs');
const path = require('path');

async function runMigration() {
    const client = await db.getClient();
    
    try {
        await client.query('BEGIN');
        
        console.log('🔄 Ejecutando migración: add_geofence_columns_to_users.sql');
        
        // Leer el archivo SQL
        const sqlFile = path.join(__dirname, 'add_geofence_columns_to_users.sql');
        const sql = fs.readFileSync(sqlFile, 'utf8');
        
        // Ejecutar el SQL
        await client.query(sql);
        
        await client.query('COMMIT');
        
        console.log('✅ Migración completada exitosamente');
        console.log('   Columnas agregadas:');
        console.log('   - current_lat (DECIMAL)');
        console.log('   - current_lng (DECIMAL)');
        console.log('   - is_inside_geofence (BOOLEAN)');
        console.log('   - last_location_update (TIMESTAMP)');
        console.log('   Índices creados para optimización');
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Error ejecutando migración:', error.message);
        
        // Si las columnas ya existen, no es un error crítico
        if (error.message.includes('already exists') || error.message.includes('duplicate')) {
            console.log('⚠️  Algunas columnas ya existen. Continuando...');
        } else {
            throw error;
        }
    } finally {
        client.release();
        await db.pool.end();
        process.exit(0);
    }
}

runMigration().catch(error => {
    console.error('❌ Error fatal:', error);
    process.exit(1);
});
