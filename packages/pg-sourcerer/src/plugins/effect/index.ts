/**
 * Effect Plugin Preset
 * 
 * Generates @effect/sql Model classes, Effect Schema for enums,
 * and Model.makeRepository for tables with single-column primary keys.
 * 
 * This is a preset that returns multiple focused plugins:
 * - effect-schemas: S.Union(S.Literal(...)) for enums
 * - effect-models: Model.Class for table entities  
 * - effect-repos: Model.makeRepository for tables with single-col PKs
 */
import { Schema as S } from "effect";

import type { Plugin } from "../../runtime/types.js";
import { normalizeFileNaming } from "../../runtime/file-assignment.js";
import { EffectConfigSchema, type EffectConfig, type ParsedEffectConfig, type ParsedHttpConfig } from "./shared.js";
import { effectSchemas } from "./schemas.js";
import { effectModels } from "./models.js";
import { effectRepos } from "./repos.js";
import { effectHttp } from "./http.js";

// Re-export config type for users
export type { EffectConfig } from "./shared.js";

const DEFAULT_SERVER_FILE = "server.ts";

/**
 * Effect plugin preset for @effect/sql code generation.
 * 
 * Generates:
 * - Model.Class for table/view entities
 * - S.Union(S.Literal(...)) for enum entities
 * - Model.makeRepository for tables with single-column primary keys
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
  const schemaValidated = S.decodeSync(EffectConfigSchema)(config ?? {});

  // Resolve FileNaming for HTTP config (Schema can't validate functions)
  const parsed: ParsedEffectConfig = {
    ...schemaValidated,
    http: schemaValidated.http === false 
      ? false 
      : {
          ...schemaValidated.http,
          serverFile: normalizeFileNaming(config?.http !== false ? config?.http?.serverFile : undefined, DEFAULT_SERVER_FILE),
        },
  };

  const plugins: Plugin[] = [
    // Schemas first - models depend on enum schemas
    effectSchemas(parsed),
    // Models - table entities as Model.Class
    effectModels(),
  ];

  // Optionally add repos
  if (parsed.repos) {
    plugins.push(effectRepos());
  }

  // HTTP requires repos - only add if repos are enabled and http is not disabled
  if (parsed.repos && parsed.http !== false && (parsed.http as ParsedHttpConfig).enabled) {
    plugins.push(effectHttp(parsed));
  }

  return plugins;
}
