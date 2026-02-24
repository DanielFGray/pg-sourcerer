/**
 * Effect Plugin Preset
 *
 * Generates @effect/sql Model classes, Effect Schema for enums,
 * and repository services for tables with single-column primary keys.
 *
 * This is a preset that returns multiple focused plugins:
 * - effect-schemas: S.Union(S.Literal(...)) for enums
 * - effect-models: Model.Class for table entities
 * - effect-repos: Repository services for tables with single-col PKs
 */
import { Schema as S } from "effect";

import type { Plugin } from "../../runtime/types.js";
import { normalizeFileNaming } from "../../runtime/file-assignment.js";
import {
  EffectConfigSchema,
  type EffectConfig,
  type ParsedEffectConfig,
  type ParsedHttpConfig,
} from "./shared.js";
import { effectSchemas } from "./schemas.js";
import { effectModels } from "./models.js";
import { effectRepos } from "./repos.js";
import { effectHttp } from "./http.js";

// Re-export config type for users
export type { EffectConfig } from "./shared.js";

const DEFAULT_SERVER_FILE = "server.ts";

/**
 * Parse and normalize the effect config
 */
const parseConfig = (config?: EffectConfig): ParsedEffectConfig => {
  const schemaValidated = S.decodeSync(EffectConfigSchema)(config ?? {});
  const repoModel = config?.repos === false ? false : (config?.repoModel ?? schemaValidated.repoModel);
  const reposEnabled = config?.repos === false ? false : schemaValidated.repos;

  return {
    ...schemaValidated,
    repos: reposEnabled,
    repoModel,
    http:
      schemaValidated.http === false
        ? false
        : {
            ...schemaValidated.http,
            serverFile: normalizeFileNaming(
              config?.http !== false ? config?.http?.serverFile : undefined,
              DEFAULT_SERVER_FILE,
            ),
            sqlClientLayer: config?.http !== false ? config?.http?.sqlClientLayer : undefined,
          },
  };
};

/**
 * Determine if HTTP plugin should be included
 */
const shouldIncludeHttp = (parsed: ParsedEffectConfig): boolean =>
  parsed.repos && parsed.http !== false && (parsed.http as ParsedHttpConfig).enabled;

/**
 * Effect plugin preset for @effect/sql code generation.
 *
 * Generates:
 * - Model.Class for table/view entities
 * - S.Union(S.Literal(...)) for enum entities
 * - Repository services for tables with single-column primary keys
 *
 * @example
 * ```typescript
 * import { defineConfig, effect } from "pg-sourcerer"
 *
 * export default defineConfig({
 *   plugins: [effect()],
 * })
 * ```
 */
export function effect(config?: EffectConfig): Plugin[] {
  const parsed = parseConfig(config);

  // Base plugins: schemas first (models depend on enum schemas), then models
  // Tell schemas that models are active so it skips row shapes (Model.Class covers them)
  const basePlugins: Plugin[] = [effectSchemas({ ...parsed, modelsEnabled: true }), effectModels()];

  // Conditional plugins based on config
  const repoPlugins = parsed.repos ? [effectRepos(parsed)] : [];
  const httpPlugins = shouldIncludeHttp(parsed) ? [effectHttp(parsed)] : [];

  return [...basePlugins, ...repoPlugins, ...httpPlugins];
}
