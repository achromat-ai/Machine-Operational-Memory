import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Idempotent: records applied migrations in d1_migrations.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
import { MCP_VERSIONS_FALLBACK, primeMcpVersions } from "../src/discovery";

// The catalog and the MCP server card read their version from the Official MCP Registry. Tests never reach it:
// the cache is primed with the fallback, and test/discovery.test.ts drives the lookup itself with a mocked fetch.
primeMcpVersions(MCP_VERSIONS_FALLBACK, Number.POSITIVE_INFINITY);
