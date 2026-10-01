import { afterEach, describe, expect, it, vi } from "vitest";

// Regression test (code-review pass): pg-pool emits 'error' on the pool
// itself — not via any query()/connect() promise — whenever a currently
// idle pooled client's connection drops (routine on a Postgres
// restart/failover or a transient network blip). Node's EventEmitter throws
// synchronously on an unhandled 'error' event, which would otherwise crash
// this entire process. getPool() must attach a listener so this becomes a
// no-op (from the process's perspective) instead of fatal. No real Postgres
// connection is required to reproduce this — it's a property of
// EventEmitter, not of a live connection (pg.Pool connects lazily).
describe("getPool", () => {
  const originalUrl = process.env.DATABASE_URL;
  const originalSsl = process.env.DATABASE_SSL;

  afterEach(async () => {
    process.env.DATABASE_URL = originalUrl;
    process.env.DATABASE_SSL = originalSsl;
    vi.resetModules();
  });

  it("attaches an error listener so an idle-client error does not crash the process", async () => {
    process.env.DATABASE_URL = "postgres://user:pass@localhost:1/testdb";
    process.env.DATABASE_SSL = "false";
    vi.resetModules();
    const { getPool, closePool } = await import("../src/metrics/db");

    const pool = getPool();
    expect(() => pool.emit("error", new Error("simulated idle client error"))).not.toThrow();

    await closePool();
  });
});
