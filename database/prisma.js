const { PrismaClient } = require('@prisma/client');

const connectionString = String(process.env.DATABASE_URL || '').trim();
const isAccelerateUrl = /^prisma(?:\+postgres)?:\/\//i.test(connectionString);
const directConnectionString = String(process.env.DIRECT_URL || '').trim();

let prisma;

if (isAccelerateUrl) {
  const { withAccelerate } = require('@prisma/extension-accelerate');
  prisma = new PrismaClient({ accelerateUrl: connectionString }).$extends(withAccelerate());

  if (directConnectionString) {
    const { PrismaPg } = require('@prisma/adapter-pg');
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: directConnectionString,
      ssl: directConnectionString && /(?:sslmode=require|\bssl=1\b|\bssl=true\b)/i.test(directConnectionString) ? { rejectUnauthorized: false } : false,
      max: Number(process.env.PG_POOL_MAX || 20),
      idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
      connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT_MS || 2000),
      keepAlive: true,
      keepAliveInitialDelayMillis: Number(process.env.PG_KEEPALIVE_DELAY_MS || 10000),
    });
    const adapter = new PrismaPg(pool);
    prisma.$direct = new PrismaClient({ adapter });
  }
} else {
  const { PrismaPg } = require('@prisma/adapter-pg');
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString,
    ssl: connectionString && /(?:sslmode=require|\bssl=1\b|\bssl=true\b)/i.test(connectionString) ? { rejectUnauthorized: false } : false,
    max: Number(process.env.PG_POOL_MAX || 20),
    idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
    connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT_MS || 2000),
    keepAlive: true,
    keepAliveInitialDelayMillis: Number(process.env.PG_KEEPALIVE_DELAY_MS || 10000),
  });
  const adapter = new PrismaPg(pool);
  prisma = new PrismaClient({ adapter });
  prisma.$direct = prisma;
}

module.exports = prisma;
