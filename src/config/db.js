// src/config/db.js

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  user: process.env.PGUSER,
  host: process.env.PGHOST,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: Number(process.env.PGPORT),
  // Opcional según proveedor:
  // ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
  // connectionTimeoutMillis: 10000,
  // idleTimeoutMillis: 30000,
  // max: 10,
});

// Consulta simple (usa el pool normalmente)
const query = (text, params) => pool.query(text, params);

// Helper para ejecutar un bloque en UNA MISMA conexión con BEGIN/COMMIT/ROLLBACK
// Uso en controllers (batch):
// await db.withTransaction(async (client) => {
//   await client.query('INSERT ...');
//   await client.query('UPDATE ...');
//   return true;
// });
const withTransaction = async (callback) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
};

// Si alguna vez quieres manejar manualmente el cliente fuera de withTransaction
const getClient = () => pool.connect();

module.exports = { pool, query, withTransaction, getClient };
