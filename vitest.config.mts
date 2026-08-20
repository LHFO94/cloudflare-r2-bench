import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

// Tests run against the real migration files rather than a hand-maintained
// copy of the DDL, so a schema change that breaks a query fails the suite
// instead of passing against a stale test-only schema.
const migrations = await readD1Migrations(path.join(rootDir, "migrations"));

export default defineWorkersConfig({
	test: {
		setupFiles: ["./test/apply-migrations.ts"],
		poolOptions: {
			workers: {
				singleWorker: true,
				wrangler: { configPath: "./wrangler.jsonc" },
				miniflare: {
					bindings: {
						TEST_MIGRATIONS: migrations,
						// Secrets are not in wrangler.jsonc; supply test values.
						AGENT_TOKEN: "test-agent-token",
						ADMIN_TOKEN: "",
					},
				},
			},
		},
	},
});
