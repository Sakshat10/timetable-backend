// Safety guard for the disposable dashboard e2e environment. EVERY script that touches the database imports this FIRST.
//
// It refuses (throws) unless the connection target is exactly: a loopback host, no query string, and the database
// named below. Error messages never contain the connection string, a password or a host other than a loopback name.
//
// Nothing here reads .env. The caller must pass DATABASE_URL explicitly (e2e.sh builds it).

export const E2E_DB_NAME = 'timetable_dashboard_e2e_test';
/** Stored with COMMENT ON DATABASE at creation. Reset/cleanup refuse a database that does not carry it. */
export const E2E_DB_MARKER = 'timetable-dashboard-e2e: disposable local database, safe to reset';
export const E2E_PORT = 4010;
export const FORBIDDEN_PORT = 4000;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export interface Target {
  host: string;
  port: number;
  database: string;
  user: string;
}

/** Throws unless `raw` points at the disposable e2e database on this machine. Returns the (credential-free) target. */
export function assertDisposableUrl(raw: string | undefined): Target {
  if (!raw) throw new Error('E2E GUARD: DATABASE_URL is not set. Pass it explicitly (e2e.sh does); .env is never used.');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('E2E GUARD: DATABASE_URL is not a valid URL.');
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') throw new Error('E2E GUARD: DATABASE_URL is not a PostgreSQL URL.');
  const host = url.hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) throw new Error('E2E GUARD: refusing a non-loopback database host. Only localhost / 127.0.0.1 / ::1 are allowed.');
  if (url.search !== '' || url.hash !== '') throw new Error('E2E GUARD: refusing a DATABASE_URL with query parameters (they can redirect the connection).');
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (database !== E2E_DB_NAME) throw new Error(`E2E GUARD: the database must be named exactly "${E2E_DB_NAME}".`);
  const port = url.port === '' ? 5432 : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('E2E GUARD: invalid database port.');
  return { host, port, database, user: decodeURIComponent(url.username) };
}

export interface Queryable {
  query: (text: string) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** Proves, from the server's own answers, that the live connection is the disposable database. Throws otherwise. */
export async function assertDisposableIdentity(client: Queryable): Promise<void> {
  const who = await client.query(`SELECT current_database() AS db, coalesce(host(inet_server_addr()), 'socket') AS addr, shobj_description((SELECT oid FROM pg_database WHERE datname = current_database()), 'pg_database') AS marker`);
  const row = who.rows[0] as { db: string; addr: string; marker: string | null } | undefined;
  if (!row || row.db !== E2E_DB_NAME) throw new Error('E2E GUARD: the connected database is not the disposable e2e database.');
  if (!['127.0.0.1', '::1', 'socket'].includes(row.addr)) throw new Error('E2E GUARD: the database server is not on this machine.');
  if (row.marker !== E2E_DB_MARKER) throw new Error('E2E GUARD: the database does not carry the disposable-database marker (created by "e2e.sh create").');
}

/** The port the backend under test must use. Never 4000 (the developer's own server). */
export function assertTestPort(port: number): void {
  if (port === FORBIDDEN_PORT) throw new Error(`E2E GUARD: port ${FORBIDDEN_PORT} belongs to the developer's server and is never used.`);
  if (port !== E2E_PORT) throw new Error(`E2E GUARD: the e2e backend runs on port ${E2E_PORT} only.`);
}
