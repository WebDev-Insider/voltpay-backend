const { Pool } = require('pg');
require('dotenv').config();

// PostgreSQL connection configuration
const connectionString = String(process.env.DATABASE_URL || '').trim();

const pool = connectionString
  ? new Pool({
    connectionString,
    ssl: connectionString && /(?:sslmode=require|\bssl=1\b|\bssl=true\b)/i.test(connectionString) ? { rejectUnauthorized: false } : false,
    max: Number(process.env.PG_POOL_MAX || 20),
    idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30_000),
    connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT_MS || 2_000),
  })
  : new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'ovopay_db',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    max: Number(process.env.PG_POOL_MAX || 20), // Maximum number of connections in the pool
    idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30_000), // Close idle connections after 30 seconds
    connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT_MS || 2_000), // Return error after 2 seconds if connection could not be established
  });

// Test database connection
pool.on('connect', () => {
  console.log('Connected to PostgreSQL database');
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

module.exports = pool;
