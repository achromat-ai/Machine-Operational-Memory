import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Idempotent: records applied migrations in d1_migrations.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
