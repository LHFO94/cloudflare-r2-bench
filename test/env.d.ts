import type { D1Migration } from "@cloudflare/vitest-pool-workers/config";

declare module "cloudflare:test" {
	interface ProvidedEnv extends Env {
		/** Migrations read from ./migrations by vitest.config.mts. */
		TEST_MIGRATIONS: D1Migration[];
	}
}
