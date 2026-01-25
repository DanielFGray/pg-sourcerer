import type { SchemaBuilder } from "../../ir/extensions/schema-builder.js";
import type { SymbolRegistryService } from "../../runtime/registry.js";

export function getSchemaBuilder(registry: SymbolRegistryService): SchemaBuilder | undefined {
  const schemaBuilders = registry.query("schema:").filter(decl => decl.capability.endsWith(":builder"));
  if (schemaBuilders.length === 0) return undefined;

  const metadata = registry.getMetadata(schemaBuilders[0]!.capability);
  if (metadata && typeof metadata === "object" && "builder" in metadata) {
    return (metadata as { builder: SchemaBuilder }).builder;
  }
  return undefined;
}
