import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

const { Pool } = pg;

// Connection string and SSL behaviour come from DATABASE_URL, unchanged.
//
// Pool hardening (pg defaults leave all of these off):
// - connectionTimeoutMillis: pg waits forever by default, so a stalled connect (e.g. after the
//   machine wakes from sleep) hung a request for ~15 minutes. Fail after 20s instead, which is
//   still far above a Neon cold start.
// - keepAlive: send TCP keepalive probes so a dead peer (sleep/wake, dropped NAT or pooler
//   connection) is detected by the OS and surfaces as an error rather than a silent hang.
// - maxLifetimeSeconds: recycle connections after 30 minutes. pg-pool only retires a connection
//   when it is idle or released, so in-flight queries are never interrupted.
// pg's other defaults are kept on purpose: max 10 connections, 10s idle timeout. No
// statement/query timeout is set, so legitimate long-running queries are not cut off.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 20_000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  maxLifetimeSeconds: 1800,
});

// An idle pooled client can error (server restart, network drop). Without a listener, an
// 'error' event on the pool is an uncaught exception that crashes the process. pg removes
// the broken client and the pool opens a fresh one on the next query. Log only the message,
// never the error object, which may carry connection details.
pool.on('error', (error: Error) => {
  console.error('Unexpected PostgreSQL pool error:', error.message);
});

const adapter = new PrismaPg(pool);

const prisma = new PrismaClient({
  adapter,
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
});

export default prisma;
