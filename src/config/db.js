// Este archivo NO debe cargar dotenv. Esa es responsabilidad del punto de entrada de la aplicación (ej: index.js).
// Al hacerlo así, nos aseguramos que las variables de entorno siempre estén disponibles antes de que este módulo se ejecute.

const { Pool } = require('pg');

/**
 * Permite conectarse de dos formas:
 * 1) Usando DATABASE_URL   (recomendado; maneja caracteres especiales en el password)
 * 2) Usando PGUSER/PGHOST/PGDATABASE/PGPASSWORD/PGPORT por separado
 *
 * SSL:
 * - Local: ssl: false
 * - Neon/Cloud: setea PGSSL=true (o DATABASE_SSL=true) para activar { rejectUnauthorized: false }
 */

const useConnStr = !!process.env.DATABASE_URL;
const useSSL =
  (process.env.PGSSL && process.env.PGSSL.toLowerCase() === 'true') ||
  (process.env.DATABASE_SSL && process.env.DATABASE_SSL.toLowerCase() === 'true');

const baseConfig = useConnStr
  ? {
      connectionString: process.env.DATABASE_URL,
    }
  : {
      user: process.env.PGUSER,
      host: process.env.PGHOST,
      database: process.env.PGDATABASE,
      password: process.env.PGPASSWORD,
      port: Number(process.env.PGPORT || 5432),
    };

const pool = new Pool({
  ...baseConfig,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
  // Ajustes opcionales de rendimiento y timeouts:
  // connectionTimeoutMillis: 10_000,
  // idleTimeoutMillis: 30_000,
  // max: 10,
});

// Logs mínimos de diagnóstico al arrancar (no imprime contraseñas)
(() => {
  const mode = useConnStr ? 'DATABASE_URL' : 'PG vars';
  const host = useConnStr ? '(in URL)' : baseConfig.host;
  const db   = useConnStr ? '(in URL)' : baseConfig.database;
  const port = useConnStr ? '(in URL)' : baseConfig.port;
  // eslint-disable-next-line no-console
  console.log(`[DB] Modo=${mode} host=${host} db=${db} port=${port} ssl=${!!useSSL}`);
})();

// Helper para ejecutar una consulta simple con el pool
const query = (text, params) => pool.query(text, params);

// Helper de transacciones (BEGIN/COMMIT/ROLLBACK en la MISMA conexión)
const withTransaction = async (callback) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    // Si hay un error, intenta hacer rollback antes de propagar el error
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    // Asegura que la conexión siempre se libere de vuelta al pool
    client.release();
  }
};

// Si se necesita manejar manualmente un cliente (ej. para transacciones complejas)
const getClient = () => pool.connect();

// Health check sencillo para una ruta de estado (ej. /health)
const healthCheck = async () => {
  try {
    await pool.query('SELECT 1');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
};

module.exports = { pool, query, withTransaction, getClient, healthCheck };