/**
 * Hex - Query Object
 *
 * Query class that wraps QueryDescriptor with AST rendering methods.
 */
import recast from "recast";
import type { namedTypes as n } from "ast-types";
import type { TSTypeKind, ExpressionKind } from "ast-types/lib/gen/kinds.js";
import type { QueryDescriptor, ParamDescriptor, ReturnDescriptor } from "../shared/query-types.js";
import { conjure, cast } from "../conjure/index.js";
import { param as sigParam, returns as sigReturns, sig } from "../conjure/signature.js";
import * as types from "../conjure/types.js";

const b = recast.types.builders;

/**
 * Template parts extracted from parameterized SQL.
 * Used for generating tagged template literals.
 */
export interface TemplateParts {
  /** String parts between parameters */
  readonly parts: readonly string[];
  /** Parameter names in order */
  readonly paramNames: readonly string[];
}

/**
 * Options for toTaggedTemplate()
 */
export interface TaggedTemplateOptions {
  /** Type parameter for the tag: sql<User>`...` */
  readonly typeParam?: TSTypeKind;
  /** Custom expression for each param. Default: identifier with param name */
  readonly paramExpr?: (name: string) => n.Expression;
}

/**
 * Options for toParameterizedCall()
 */
export interface ParameterizedCallOptions {
  /** Type parameter for the call: pool.query<User>(...) */
  readonly typeParam?: TSTypeKind;
  /** Custom expression for each param. Default: identifier with param name */
  readonly paramExpr?: (name: string) => n.Expression;
}

/**
 * Query object - wraps a QueryDescriptor with AST rendering methods.
 *
 * This is the primary interface for plugins working with SQL queries.
 * Use `hex.select()` or `hex.mutate()` to create Query objects.
 *
 * @example
 * ```typescript
 * const query = hex.select(ir, {
 *   selects: [{ kind: "star", from: "users" }],
 *   from: { kind: "table", table: "users" },
 *   where: [{ kind: "equals", column: "users.id", value: { name: "id", pgType: "uuid" } }],
 * })
 *
 * // Access data
 * query.sql           // "SELECT users.* FROM users WHERE users.id = $1"
 * query.descriptor    // Full QueryDescriptor
 * query.templateParts // { parts: ["SELECT ... WHERE users.id = ", ""], paramNames: ["id"] }
 *
 * // Render to AST
 * query.toTaggedTemplate("sql", { typeParam: types.ref("User") })
 * // → sql<User>`SELECT users.* FROM users WHERE users.id = ${id}`
 * ```
 */
export class Query {
  readonly #descriptor: QueryDescriptor;
  readonly #templateParts: TemplateParts;

  constructor(descriptor: QueryDescriptor) {
    this.#descriptor = descriptor;
    this.#templateParts = this.#extractTemplateParts();
  }

  /** The parameterized SQL string (with $1, $2, etc.) */
  get sql(): string {
    return this.#descriptor.sql;
  }

  /** The full QueryDescriptor for advanced access */
  get descriptor(): QueryDescriptor {
    return this.#descriptor;
  }

  /** Template parts for building tagged templates */
  get templateParts(): TemplateParts {
    return this.#templateParts;
  }

  /** Parameter descriptors */
  get params(): readonly ParamDescriptor[] {
    return this.#descriptor.params;
  }

  /** Return descriptor */
  get returns(): ReturnDescriptor {
    return this.#descriptor.returns;
  }

  /**
   * Extract template parts from parameterized SQL.
   *
   * Converts "SELECT * FROM users WHERE id = $1 AND name = $2"
   * into { parts: ["SELECT * FROM users WHERE id = ", " AND name = ", ""], paramNames: ["id", "name"] }
   */
  #extractTemplateParts(): TemplateParts {
    const sql = this.#descriptor.sql;
    const params = this.#descriptor.params;

    // Split on $N placeholders
    const parts: string[] = [];
    const paramNames: string[] = [];

    // Regex to match $1, $2, etc.
    const regex = /\$(\d+)/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(sql)) !== null) {
      // Add the part before this placeholder
      parts.push(sql.slice(lastIndex, match.index));

      // Get param name by index (1-based)
      const paramIndex = parseInt(match[1]!, 10) - 1;
      const param = params[paramIndex];
      if (param) {
        paramNames.push(param.name);
      } else {
        paramNames.push(`param${paramIndex + 1}`);
      }

      lastIndex = regex.lastIndex;
    }

    // Add the final part after the last placeholder
    parts.push(sql.slice(lastIndex));

    return { parts, paramNames };
  }

  /**
   * Render as a tagged template literal: sql<T>`SELECT ... ${id}`
   *
   * @param tag - The tag name (e.g., "sql")
   * @param opts - Optional type parameter and custom param expressions
   *
   * @example
   * query.toTaggedTemplate("sql")
   * // → sql`SELECT * FROM users WHERE id = ${id}`
   *
   * query.toTaggedTemplate("sql", { typeParam: types.ref("User") })
   * // → sql<User>`SELECT * FROM users WHERE id = ${id}`
   *
   * query.toTaggedTemplate("sql", { paramExpr: (name) => conjure.id("params").prop(name).build() })
   * // → sql`SELECT * FROM users WHERE id = ${params.id}`
   */
  toTaggedTemplate(tag: string, opts?: TaggedTemplateOptions): n.TaggedTemplateExpression {
    const { parts, paramNames } = this.#templateParts;

    // Build param expressions
    const expressions: n.Expression[] = paramNames.map(name => {
      if (opts?.paramExpr) {
        return opts.paramExpr(name);
      }
      return b.identifier(name);
    });

    // Use conjure's taggedTemplate builder
    return conjure.taggedTemplate(
      tag,
      parts,
      expressions,
      opts?.typeParam ? [opts.typeParam] : undefined,
    );
  }

  /**
   * Render as a parameterized call: pool.query<T>("SELECT ...", [id])
   *
   * @param obj - The object to call the method on (e.g., "pool", "db")
   * @param method - The method name (e.g., "query", "execute")
   * @param opts - Optional type parameter and custom param expressions
   *
   * @example
   * query.toParameterizedCall("pool", "query")
   * // → pool.query("SELECT * FROM users WHERE id = $1", [id])
   *
   * query.toParameterizedCall("db", "execute", { typeParam: types.ref("User") })
   * // → db.execute<User>("SELECT * FROM users WHERE id = $1", [id])
   */
  toParameterizedCall(obj: string, method: string, opts?: ParameterizedCallOptions): n.CallExpression {
    const { paramNames } = this.#templateParts;

    // Build param array expressions
    const paramExprs: ExpressionKind[] = paramNames.map(name => {
      if (opts?.paramExpr) {
        return cast.toExpr(opts.paramExpr(name));
      }
      return b.identifier(name);
    });

    // Build the call: obj.method<T>("sql", [params])
    const callee = b.memberExpression(b.identifier(obj), b.identifier(method));

    const args: ExpressionKind[] = [
      b.stringLiteral(this.#descriptor.sql),
      b.arrayExpression(paramExprs),
    ];

    const callExpr = b.callExpression(callee, args);

    // Add type parameters if provided
    if (opts?.typeParam) {
      (callExpr as unknown as { typeParameters: n.TSTypeParameterInstantiation }).typeParameters =
        b.tsTypeParameterInstantiation([opts.typeParam]);
    }

    return callExpr;
  }

  /**
   * Build a function type signature for this query.
   *
   * Used in symbol declarations to describe the query function's type.
   *
   * @example
   * query.toSignature()
   * // → (id: string) => Promise<User | null>
   */
  toSignature(): TSTypeKind {
    const params = this.#descriptor.params.map(p => {
      const tsType = conjure.ts.fromString(p.tsType) as TSTypeKind;
      const paramType = p.nullable ? types.nullable(tsType) : tsType;
      return sigParam.simple(p.name, paramType);
    });

    // Build return type based on mode
    const { mode, fields } = this.#descriptor.returns;

    let returnType: TSTypeKind;

    if (mode === "void") {
      returnType = b.tsVoidKeyword();
    } else if (mode === "affected") {
      returnType = b.tsNumberKeyword();
    } else if (fields.length === 0) {
      returnType = b.tsUnknownKeyword();
    } else if (fields.length === 1 && fields[0]!.name === "*") {
      // SELECT * returns unknown without entity context
      returnType = b.tsUnknownKeyword();
    } else {
      // Build object type from fields
      const props = fields.map(f => ({
        name: f.name,
        type: conjure.ts.fromString(f.tsType) as TSTypeKind,
        optional: f.nullable,
      }));
      returnType = conjure.ts.objectType(props);
    }

    // Apply cardinality modifiers
    if (mode === "many") {
      returnType = types.array(returnType);
    } else if (mode === "oneOrNone") {
      returnType = types.nullable(returnType);
    }

    // Wrap in Promise for async
    returnType = sigReturns.promise(returnType);

    return sig(params, returnType);
  }
}

/**
 * Create a Query object from a QueryDescriptor.
 */
export function createQuery(descriptor: QueryDescriptor): Query {
  return new Query(descriptor);
}
