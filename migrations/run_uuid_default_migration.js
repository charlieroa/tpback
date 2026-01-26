// Script para ejecutar migración: Agregar DEFAULT UUID a users.id
require('dotenv').config();
const db = require('../src/config/db');
const fs = require('fs');
const path = require('path');

async function runMigration() {
    const client = await db.getClient();
    
    try {
        await client.query('BEGIN');
        
        console.log('🔄 Ejecutando migración: add_default_uuid_to_users_id.sql\n');
        
        // Leer el archivo SQL
        const sqlFile = path.join(__dirname, 'add_default_uuid_to_users_id.sql');
        const sql = fs.readFileSync(sqlFile, 'utf8');
        
        // Ejecutar el SQL
        await client.query(sql);
        
        await client.query('COMMIT');
        console.log('\n✅ Migración completada exitosamente\n');

        // Verificar el resultado
        const result = await client.query(`
            SELECT 
                column_name,
                column_default,
                is_nullable,
                data_type
            FROM information_schema.columns
            WHERE table_schema = 'public' 
              AND table_name = 'users' 
              AND column_name = 'id'
        `);

        if (result.rows.length > 0) {
            const col = result.rows[0];
            console.log('📋 Estado de la columna users.id:');
            console.log(`   Column: ${col.column_name}`);
            console.log(`   Type: ${col.data_type}`);
            console.log(`   Nullable: ${col.is_nullable}`);
            console.log(`   Default: ${col.column_default || '(sin default)'}`);
            
            if (col.column_default) {
                console.log('\n✅ La columna users.id ahora tiene un DEFAULT configurado');
                console.log(`   Default: ${col.column_default}`);
            } else {
                console.log('\n⚠️ La columna users.id NO tiene DEFAULT. Puede haber un problema.');
            }
        }
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('\n❌ Error en la migración:', error.message);
        
        // Si el error es porque ya tiene default, informar pero no fallar
        if (error.message.includes('already') || error.message.includes('ya tiene')) {
            console.log('\nℹ️ La migración puede que ya se haya ejecutado anteriormente.');
            console.log('Verificando estado actual...\n');
            
            try {
                const result = await client.query(`
                    SELECT column_default
                    FROM information_schema.columns
                    WHERE table_schema = 'public' 
                      AND table_name = 'users' 
                      AND column_name = 'id'
                `);
                
                if (result.rows.length > 0 && result.rows[0].column_default) {
                    console.log('✅ La columna users.id ya tiene DEFAULT configurado:');
                    console.log(`   ${result.rows[0].column_default}`);
                    console.log('\n✅ No es necesario ejecutar la migración nuevamente.');
                }
            } catch (checkError) {
                console.error('Error al verificar:', checkError.message);
            }
        } else {
            throw error;
        }
    } finally {
        client.release();
        await db.pool.end();
    }
}

runMigration();
