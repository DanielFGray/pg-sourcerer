/**
 * Config Provider Tests
 *
 * Tests for the Effect-based config patterns:
 * - ConfigProvider interface and implementations
 * - withFallback composition
 * - Layer constructors
 */
import { describe, it, expect } from "@effect/vitest";
import { Effect, Exit, Cause } from "effect";

import type { ResolvedConfig } from "../config.js";
import { ConfigNotFound, ConfigInvalid } from "../errors.js";
import {
  type ConfigProvider,
  InMemoryConfigProvider,
  withFallback,
  ConfigService,
  ConfigWithFallback,
} from "../services/config.js";

// ============================================================================
// Test Fixtures
// ============================================================================

const testConfig: ResolvedConfig = {
  connectionString: "postgres://localhost/test",
  schemas: ["public"],
  outputDir: "src/generated",
  typeHints: [],
  plugins: [],
};

const fallbackConfig: ResolvedConfig = {
  connectionString: "postgres://localhost/fallback",
  schemas: ["app"],
  outputDir: "src/fallback",
  typeHints: [],
  plugins: [],
};

// ============================================================================
// Mock Providers for Testing
// ============================================================================

const SuccessProvider = (config: ResolvedConfig): ConfigProvider => ({
  load: Effect.succeed(config),
});

const NotFoundProvider = (): ConfigProvider => ({
  load: Effect.fail(
    new ConfigNotFound({
      message: "Config not found",
      searchPaths: ["/test/pgsourcerer.config.ts"],
    }),
  ),
});

const InvalidProvider = (): ConfigProvider => ({
  load: Effect.fail(
    new ConfigInvalid({
      message: "Invalid config",
      path: "/test/pgsourcerer.config.ts",
      errors: ["connectionString is required"],
    }),
  ),
});

// ============================================================================
// Tests
// ============================================================================

describe("ConfigProvider", () => {
  describe("InMemoryConfigProvider", () => {
    it.effect("returns provided config", () =>
      Effect.gen(function* () {
        const provider = InMemoryConfigProvider(testConfig);
        const result = yield* provider.load;
        expect(result).toEqual(testConfig);
      }),
    );
  });

  describe("withFallback", () => {
    it.effect("returns primary config when available", () =>
      Effect.gen(function* () {
        const provider = withFallback(SuccessProvider(testConfig), () =>
          SuccessProvider(fallbackConfig),
        );
        const result = yield* provider.load;
        expect(result.connectionString).toBe("postgres://localhost/test");
      }),
    );

    it.effect("falls back on ConfigNotFound", () =>
      Effect.gen(function* () {
        const provider = withFallback(NotFoundProvider(), () => SuccessProvider(fallbackConfig));
        const result = yield* provider.load;
        expect(result.connectionString).toBe("postgres://localhost/fallback");
      }),
    );

    it.effect("propagates ConfigInvalid (no fallback)", () =>
      Effect.gen(function* () {
        const provider = withFallback(InvalidProvider(), () => SuccessProvider(fallbackConfig));
        const exit = yield* Effect.exit(provider.load);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const failure = Cause.failureOption(exit.cause);
          expect(failure._tag).toBe("Some");
          if (failure._tag === "Some") {
            expect(failure.value).toBeInstanceOf(ConfigInvalid);
          }
        }
      }),
    );

    it.effect("chains multiple fallbacks", () =>
      Effect.gen(function* () {
        const thirdConfig: ResolvedConfig = {
          ...testConfig,
          connectionString: "postgres://localhost/third",
        };

        const provider = withFallback(NotFoundProvider(), () =>
          withFallback(NotFoundProvider(), () => SuccessProvider(thirdConfig)),
        );
        const result = yield* provider.load;
        expect(result.connectionString).toBe("postgres://localhost/third");
      }),
    );
  });
});

describe("ConfigWithFallback Layer", () => {
  it.effect("uses primary when available", () =>
    Effect.gen(function* () {
      const config = yield* ConfigService;
      expect(config.connectionString).toBe("postgres://localhost/test");
    }).pipe(
      Effect.provide(
        ConfigWithFallback(SuccessProvider(testConfig), () => SuccessProvider(fallbackConfig)),
      ),
    ),
  );

  it.effect("uses fallback on ConfigNotFound", () =>
    Effect.gen(function* () {
      const config = yield* ConfigService;
      expect(config.connectionString).toBe("postgres://localhost/fallback");
    }).pipe(
      Effect.provide(ConfigWithFallback(NotFoundProvider(), () => SuccessProvider(fallbackConfig))),
    ),
  );
});
