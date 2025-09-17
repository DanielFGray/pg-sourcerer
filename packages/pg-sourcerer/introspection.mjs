import {
  entityPermissions,
  makeIntrospectionQuery,
  parseIntrospectionResults,
} from "pg-introspection";
import invariant from "tiny-invariant";
import pg from "pg";

/** @typedef {{ name: string, schemas: Record<string, DbSchema> }} DbIntrospection */
/** @typedef {import("pg-introspection").Introspection} PgIntrospection */
/** @typedef {import("pg-introspection").PgRoles} PgRoles */
/**
 * @param {PgIntrospection} introspection
 * @returns {DbIntrospection}
 */
export function processIntrospection(introspection) {
  const role = introspection.getCurrentUser();
  invariant(role, "who am i???");
  return {
    name: introspection.database.datname,
    schemas: Object.fromEntries(
      introspection.namespaces.map(schema => [
        schema.nspname,
        processSchema(schema, { introspection, role }),
      ]),
    ),
  };
}

/**
 * @param {import("./index.mjs").Config} userConfig
 */
export async function introspect({ connectionString, role }) {
  const pool = new pg.Pool({ connectionString });
  const client = await pool.connect();
  await client.query("begin");
  if (role) await client.query("select set_config('role', $1, false)", [role]);
  const {
    rows: [{ introspection }],
  } = await client.query(makeIntrospectionQuery());
  await client.query("rollback");
  client.release();
  pool.end();

  return processIntrospection(parseIntrospectionResults(introspection, true));
}

/** @typedef {{
  name: string;
  views: Record<string, DbView>;
  tables: Record<string, DbTable>;
  functions: Record<string, DbFunction>;
  types: Record<string, DbType>;
}} DbSchema */

/**
 * @param {import("pg-introspection").PgNamespace} schema
 * @param {{
     introspection: PgIntrospection;
     role: PgRoles,
   }} deps
 * @returns {DbSchema}
 */
function processSchema(schema, { introspection, role }) {
  return {
    name: schema.nspname,
    views: processViews(schema._id, { introspection, role }),
    tables: processTables(schema._id, { introspection, role }),
    functions: processFunctions(schema._id, { introspection, role }),
    types: processTypes(schema._id, { introspection }),
    // permissions: getPermissions(schema, { introspection, role }),
  };
}

/**@typedef {
 *   | { kind: "domain",    name: string, type: "text" }
 *   | { kind: "enum",      name: string, values: Array<string> }
 *   | { composite: "enum", name: string, type: Array<{ name: string, type: string }> }
 * } DbType
 */

/**
 * @param {string} schemaId
 * @param {{
     introspection: PgIntrospection,
   }} _
 * @returns {Record<string, DbType>} 
 */
function processTypes(schemaId, { introspection }) {
  const domains = introspection.types
    .filter(t => t.typtype === "d" && t.typnamespace === schemaId)
    .map(t => /** @type {const} */ ({ name: t.typname, kind: "domain", type: t.typoutput }));

  const enums = introspection.types
    .filter(t => t.typtype === "e" && t.typnamespace === schemaId)
    .map(t => {
      const values = t.getEnumValues();
      invariant(values, `could not find enum values for ${t.typname}`);
      return /** @type {const} */ ({
        name: t.typname,
        kind: "enum",
        values: values.map(x => x.enumlabel),
      });
    });

  const composites = introspection.classes
    .filter(cls => cls.relnamespace === schemaId && cls.relkind === "c")
    .map(t => ({
      name: t.relname,
      kind: "composite",
      values: t.getAttributes().map(a => {
        const type = a.getType();
        invariant(type, `could not find type for composite attribute ${t.relname}`);
        return /** @type {const} */ ({ name: a.attname, type: getTypeName(type) });
      }),
    }));

  const ts = [...domains, ...enums, ...composites];
  const types = ts.reduce((prev, curr) => {
    prev[curr.name] ||= [];
    prev[curr.name].push(curr);
    return prev;
  }, /** @type {Record<string, typeof ts>} */ ({}));
  return types;
}

/** @typedef {{
  name: string;
  columns: Record<string, DbColumn>;
  constraints: Record<string, DbReference>;
  description: string | undefined;
  permissions: Permissions;
}} DbView */

/**
 * @param {string} schemaId
 * @param {{
     introspection: PgIntrospection,
     role: PgRoles,
   }}
 * @returns {Record<string, DbView>}
 */
function processViews(schemaId, { introspection, role }) {
  const views = Object.fromEntries(
    introspection.classes
      .filter(cls => cls.relnamespace === schemaId && cls.relkind === "v")
      .map(view => [
        view.relname,
        {
          name: view.relname,
          // TODO: any other attributes specific to views? references? pseudo-FKs?
          columns: processColumns(view._id, { introspection, role }),
          constraints: processReferences(view._id, { introspection }),
          description: getDescription(view),
          permissions: getPermissions(view, { introspection, role }),
        },
      ]),
  );
  // console.log(...Object.values(views))
  return views;
}

/** @typedef {{
  name: string;
  columns: Record<string, DbColumn>;
  indexes: Record<string, DbIndex>;
  references: Record<string, DbReference>;
  permissions: Permissions;
  description: string | undefined;
}} DbTable */

/**
 * @param {string} schemaId
 * @param {{
    introspection: PgIntrospection,
    role: PgRoles,
   }}
 * @returns {Record<string, DbTable>}
 */
function processTables(schemaId, { introspection, role }) {
  return Object.fromEntries(
    introspection.classes
      .filter(cls => cls.relnamespace === schemaId && cls.relkind === "r")
      .map(table => {
        const name = table.relname;
        const permissions = getPermissions(table, { introspection, role });
        const description = getDescription(table);
        const references = processReferences(table._id, { introspection });
        const indexes = processIndexes(table._id, { introspection });
        const columns = processColumns(table._id, { introspection, role });
        return [name, { name, columns, indexes, references, permissions, description }];
      }),
  );
}

/** @typedef {{
  name: string;
  identity: string | null;
  type: string;
  nullable: boolean;
  generated: string | boolean;
  isArray: boolean;
  description: string | undefined;
  permissions: Permissions;
}} DbColumn */

/**
 * @param {string} tableId
 * @param {{
 *   introspection: PgIntrospection,
 *   role: PgRoles,
 * }}
 * @returns {Record<string, DbColumn>}
 */
function processColumns(tableId, { introspection, role }) {
  return Object.fromEntries(
    introspection.attributes
      .filter(attr => attr.attrelid === tableId)
      .map(column => {
        const type = column.getType();
        invariant(type, `couldn't find type for column ${column.attname}`);
        const isArray = column.attndims && column.attndims > 0;
        const typeName = isArray ? getTypeName(type.getElemType()) : getTypeName(type);
        return [
          column.attname,
          {
            name: column.attname,
            identity: column.attidentity,
            type: typeName,
            nullable: !column.attnotnull,
            generated: column.attgenerated ? "STORED" : false,
            isArray,
            description: getDescription(column),
            // original: column,
            permissions: getPermissions(column, { introspection, role }),
          },
        ];
      }),
  );
}

/** @typedef {{
  name: string;
  colnames: Array<string>;
  isUnique: boolean | null;
  isPrimary: boolean | null;
  option: Readonly<Array<number>> | null;
  type: string
}} DbIndex */

/**
 * @param {string} tableId
 * @param {{
 *  introspection: PgIntrospection,
 * }}
 * @returns {Record<string, DbIndex>}
 */
function processIndexes(tableId, { introspection }) {
  return Object.fromEntries(
    introspection.indexes
      .filter(index => index.indrelid === tableId)
      .map(index => {
        const cls = index.getIndexClass();
        invariant(cls, `failed to find index class for index ${index.indrelid}`);

        const am = cls.getAccessMethod();
        invariant(am, `failed to find access method for index ${cls.relname}`);

        const keys = index.getKeys();
        invariant(keys, `failed to find keys for index ${cls.relname}`);

        const colnames = keys.filter(Boolean).map(a => a.attname);
        const name = cls.relname;
        // TODO: process index-specific options?
        const option = index.indoption;
        return [
          name,
          /** @type DbIndex */ ({
            name,
            isUnique: index.indisunique,
            isPrimary: index.indisprimary,
            option,
            type: am.amname,
            colnames,
          }),
        ];
      }),
  );
}

/** @typedef {{
  refPath: {
    schema: string;
    table: string;
    column: string;
  };
}} DbReference */

/**
 * @param {string} tableId
 * @param {{introspection: PgIntrospection}}
 * @returns {Record<string, DbReference>}
 */
function processReferences(tableId, { introspection }) {
  return Object.fromEntries(
    introspection.constraints
      .filter(c => c.conrelid === tableId && c.contype === "f")
      .map(constraint => {
        const fkeyAttr = constraint.getForeignAttributes();
        invariant(
          fkeyAttr,
          `failed to get foreign attributes for constraint ${constraint.conname}`,
        );
        const fkeyClass = constraint.getForeignClass();
        invariant(fkeyClass, `failed to get foreign class for constraint ${constraint.conname}`);
        const fkeyNsp = fkeyClass?.getNamespace();
        invariant(fkeyNsp, `failed to get namespace for foreign class ${fkeyClass?.relname}`);
        const refPath = {
          schema: fkeyNsp?.nspname,
          table: fkeyClass?.relname,
          column: fkeyAttr?.[0].attname,
        };
        return [
          constraint.conname,
          {
            name: constraint.conname,
            refPath,
            // original: constraint,
          },
        ];
      }),
  );
}

/** @typedef {{
  permissions: Permissions;
  returnType: string | undefined;
  args: Array<[string | number, { type: string; hasDefault?: boolean }]>;
  volatility: "immutable" | "stable" | "volatile"
}} DbFunction */

/**
 * @param {string} schemaId
 * @param {{
     introspection: PgIntrospection,
     role: PgRoles,
   }} _
 * @returns {Record<string, DbFunction>}
 */
function processFunctions(schemaId, { introspection, role }) {
  return Object.fromEntries(
    introspection.procs
      .filter(proc => proc.pronamespace === schemaId)
      .map(proc => {
        const type = proc.getReturnType();
        invariant(type, `couldn't find type for proc ${proc.proname}`);
        return [
          proc.proname,
          {
            permissions: getPermissions(proc, { introspection, role }),
            returnType: getTypeName(type),
            volatility: { i: "immutable", s: "stable", v: "volatile" }[proc.provolatile],
            // TODO: inflection?
            args: !proc.proargnames
              ? []
              : proc.getArguments().map((a, i) => {
                  /* not every argument is named! */
                  const argName = proc.proargnames?.[i] ?? i + 1;
                  return [
                    argName,
                    {
                      type: getTypeName(a.type),
                      hasDefault: a.hasDefault,
                    },
                  ];
                }),
          },
        ];
      }),
  );
}

/**
 * @param {import("pg-introspection").PgType} type
 */
export function getTypeName(type) {
  return [type.getNamespace()?.nspname, type.typname].join(".");
}

/**
 * might implement a custom metadata parser later
 * @param {{ getDescription(): string | undefined }} entity
 */
export function getDescription(entity) {
  return entity.getDescription();
}

/**
 * @param {Parameters<typeof entityPermissions>[1]} entity
 * @param {{
     introspection: PgIntrospection,
     role: PgRoles,
   }} _
 * @returns {{canSelect?: boolean, canInsert?: boolean, canUpdate?: boolean, canDelete?: boolean, canExecute?: boolean}}
 */
/** @typedef {ReturnType<typeof getPermissions>} Permissions */

/**
 * @param {Parameters<typeof entityPermissions>[1]} entity
 * @param {{
 *     introspection: PgIntrospection,
 *     role: PgRoles,
 *   }} _
 * @returns {
 *   | { canSelect: boolean, canInsert: boolean, canUpdate: boolean, canDelete?: boolean }
 *   | { usage: boolean }
 *   | { canExecute: boolean }
 * }
 */
export function getPermissions(entity, { introspection, role }) {
  // licensed under MIT from Benjie Gillam
  // https://github.com/graphile/crystal/blob/9d1c54a28e29a2da710ba093541b4a03bab6b5c6/graphile-build/graphile-build-pg/src/plugins/PgRBACPlugin.ts
  switch (entity._type) {
    case "PgNamespace": {
      const p = entityPermissions(introspection, entity, role, true);
      invariant(p.usage != null);
      return { usage: p.usage };
    }
    case "PgAttribute": {
      const table = entity.getClass();
      invariant(table, `couldn't find table for attribute ${entity.attname}`);
      const attributePermissions = entityPermissions(introspection, entity, role, true);
      const tablePermissions = entityPermissions(introspection, table, role, true);
      const canSelect = attributePermissions.select || Boolean(tablePermissions.select);
      const canInsert = attributePermissions.insert || Boolean(tablePermissions.insert);
      const canUpdate = attributePermissions.update || Boolean(tablePermissions.update);
      return { canSelect, canInsert, canUpdate };
    }
    case "PgClass": {
      const perms = entityPermissions(introspection, entity, role, true);
      let canSelect = perms.select ?? false;
      let canInsert = perms.insert ?? false;
      let canUpdate = perms.update ?? false;
      const canDelete = perms.delete ?? false;
      if (!canInsert || !canUpdate || !canSelect) {
        const attributePermissions = entity
          .getAttributes()
          .filter(att => att.attnum > 0)
          .map(att => entityPermissions(introspection, att, role, true));
        for (const attributePermission of attributePermissions) {
          canSelect ||= Boolean(attributePermission.select);
          canInsert ||= Boolean(attributePermission.insert);
          canUpdate ||= Boolean(attributePermission.update);
        }
      }
      return { canSelect, canInsert, canUpdate, canDelete };
    }
    case "PgProc": {
      const { execute } = entityPermissions(introspection, entity, role, true);
      invariant(execute != null, `failed to get permission for function ${entity.proname}`);
      return { canExecute: execute };
    }
    default:
      invariant(false, `unknown entity type "${entity._type}"`);
  }
}
