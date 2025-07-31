// src/config/db.js

// Cargar las variables de entorno desde el archivo .env
require('dotenv').config();

// Importar la clase Pool del paquete 'pg'
const { Pool } = require('pg');

// Configurar el pool de conexiones usando TUS variables de entorno
const pool = new Pool({
  user: process.env.PGUSER,       // Cambiado de DB_USER
  host: process.env.PGHOST,       // Cambiado de DB_HOST
  database: process.env.PGDATABASE, // Cambiado de DB_DATABASE
  password: process.env.PGPASSWORD, // Cambiado de DB_PASSWORD
  port: process.env.PGPORT,         // Cambiado de DB_PORT
});

// Exportar una función para hacer consultas.
module.exports = {
  query: (text, params) => pool.query(text, params),
};