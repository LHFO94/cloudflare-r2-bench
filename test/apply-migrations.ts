import { applyD1Migrations, env } from "cloudflare:test";

// Each test file gets an isolated D1 instance, so the schema has to be built
// before any test runs.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
