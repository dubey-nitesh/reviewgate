// Shared Postgres connection pool for src/metrics/store.ts.
//
// SECURITY-12 (credential management): connection details come from the
// DATABASE_URL environment variable — never hardcoded.
// SECURITY-01 (encryption in transit): TLS is enabled by default; set
// DATABASE_SSL=false to opt out for local/self-hosted Postgres instances
// that don't terminate TLS (e.g. a plain Docker Postgres in local dev).

import { Pool } from "pg";

let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL environment variable is not set");
    }
    const sslDisabled = process.env.DATABASE_SSL === "false";
    pool = new Pool({
      connectionString,
      ssl: sslDisabled ? false : { rejectUnauthorized: true },
    });
    // pg-pool emits 'error' on the pool itself (not via any query()/connect()
    // promise) whenever a currently-idle pooled client's connection drops —
    // routine on a managed-Postgres restart/failover or a transient network
    // blip. Node's EventEmitter throws synchronously on an unhandled 'error'
    // event, which would otherwise crash this entire process (not just the
    // in-flight metrics write) — found during a code-review pass; verified
    // directly via pool.emit('error', ...) with no listener attached.
    pool.on("error", (err) => {
      // No app-level logger is wired to this module (getPool() has no
      // per-request context) — this is a last-resort visibility path for an
      // event that must never go unhandled.
      console.error("reviewgate: idle Postgres client error", err);
    });
  }
  return pool;
}

// Closes the shared pool created by getPool() and clears the module-level
// reference, so a subsequent getPool() call creates a fresh one. No-op if
// getPool() was never called. Exists for test teardown (integration tests
// call this in afterAll so the pool doesn't keep the process alive/leak
// connections after the suite finishes) — the running application itself
// has no reason to call this, since the pool should live for the process's
// lifetime.
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
