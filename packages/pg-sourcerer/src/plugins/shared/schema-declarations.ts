import type { SymbolDeclaration } from "../../runtime/types.js";
import type { EnumEntity, TableEntity } from "../../ir/semantic-ir.js";

export interface ShapeDeclarationOptions {
  readonly includeTypes?: boolean;
  readonly includeRowType?: boolean;
}

export function buildShapeDeclarations(
  entity: TableEntity,
  capabilityPrefix: string,
  options: ShapeDeclarationOptions = {},
): SymbolDeclaration[] {
  const includeTypes = options.includeTypes ?? true;
  const includeRowType = options.includeRowType ?? false;
  const declarations: SymbolDeclaration[] = [];
  const baseEntityName = entity.name;

  const rowName = entity.shapes.row.name;
  declarations.push({
    name: rowName,
    capability: `${capabilityPrefix}:${rowName}`,
    baseEntityName,
  });

  if (includeTypes && includeRowType) {
    declarations.push({
      name: rowName,
      capability: `${capabilityPrefix}:${rowName}:type`,
      baseEntityName,
    });
  }

  if (entity.shapes.insert) {
    const insertName = entity.shapes.insert.name;
    declarations.push({
      name: insertName,
      capability: `${capabilityPrefix}:${insertName}`,
      baseEntityName,
    });
    if (includeTypes) {
      declarations.push({
        name: insertName,
        capability: `${capabilityPrefix}:${insertName}:type`,
        baseEntityName,
      });
    }
  }

  if (entity.shapes.update) {
    const updateName = entity.shapes.update.name;
    declarations.push({
      name: updateName,
      capability: `${capabilityPrefix}:${updateName}`,
      baseEntityName,
    });
    if (includeTypes) {
      declarations.push({
        name: updateName,
        capability: `${capabilityPrefix}:${updateName}:type`,
        baseEntityName,
      });
    }
  }

  return declarations;
}

export function buildEnumDeclarations(
  entity: EnumEntity,
  capabilityPrefix: string,
  includeTypes = true,
): SymbolDeclaration[] {
  const baseEntityName = entity.name;
  const declarations: SymbolDeclaration[] = [
    {
      name: entity.name,
      capability: `${capabilityPrefix}:${entity.name}`,
      baseEntityName,
    },
  ];

  if (includeTypes) {
    declarations.push({
      name: entity.name,
      capability: `${capabilityPrefix}:${entity.name}:type`,
      baseEntityName,
    });
  }

  return declarations;
}

export function buildSchemaBuilderDeclaration(
  name: string,
  capabilityPrefix: string,
): SymbolDeclaration {
  return {
    name,
    capability: `${capabilityPrefix}:builder`,
  };
}
