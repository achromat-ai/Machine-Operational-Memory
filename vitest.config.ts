import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run inside workerd with the real wrangler.toml bindings: local D1 (with
// both migrations applied by test/setup.ts), the NonceRegistry Durable Object
// and the rate limiter. Overrides below are test-only.
export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        // Never reach the production account from tests (AI and Vectorize are remote-only).
        remoteBindings: false,
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            IP_HMAC_KEY: "test-only-ip-hmac-key-not-a-secret-0123456789",
            POW_CHALLENGE_HMAC_KEY: "test-only-pow-challenge-hmac-key-0123456789",
            // 16 bits (~65k hashes) keeps PoW solving fast; production uses 22.
            POW_DIFFICULTY_BITS: "16",
            // Test-only values. These override anything in .dev.vars, so tests never see real
            // secrets, and upstream fetch is mocked in every /calibrate test.
            RAMEN_API_KEY: "test-only-ramen-api-key",
            MOM_ATTESTATION_PRIVATE_KEY: "MC4CAQAwBQYDK2VwBCIEIO0fsf88oiq8l00hvT7YFE6u3iL3LhI2bFxBXUqPegRO",
            VISIBILITY_KEY: "KbMwRvco4ocXNheokWekSaHne7TLBzTUQ8eGHUGnj0A=",
          },
        },
      }),
    ],
    // Component tests render to a string (react-dom/server), so they need no DOM library.
    esbuild: { jsx: "automatic" },
    test: {
      include: ["test/**/*.test.ts", "ui/src/**/*.test.tsx"],
      setupFiles: ["./test/setup.ts"],
    },
  };
});
