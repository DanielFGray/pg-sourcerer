/**
 * Hex - Query Builder Functions
 *
 * Core declarative query building functions.
 */
import type { SemanticIR } from "../ir/semantic-ir.js";
import type { QueryDescriptor, ReturnDescriptor } from "../shared/query-types.js";
import type { SelectSpec, MutationSpec, ParamSpec, BuilderState } from "./types.js";
import {
  createBuilderState,
  buildSelectQuery,
  buildMutationQuery,
  inferReturnFields,
} from "./types.js";

export function select(ir: SemanticIR, spec: SelectSpec): QueryDescriptor {
  const state = createBuilderState(ir);
  const sql = buildSelectQuery(state, spec);
  const returns: ReturnDescriptor = {
    mode: "many",
    fields: inferReturnFields(state, spec.selects),
  };

  return {
    name: "",
    entityName: "",
    operation: "select",
    sql,
    params: state.params,
    returns,
  };
}

export function mutate(ir: SemanticIR, spec: MutationSpec): QueryDescriptor {
  const state = createBuilderState(ir);
  const sql = buildMutationQuery(state, spec);

  const operation = spec.kind === "insert" ? "insert"
    : spec.kind === "update" ? "update"
    : spec.kind === "delete" ? "delete"
    : "upsert";

  const returns: ReturnDescriptor = {
    mode: spec.returning ? "many" : "void",
    fields: spec.returning ? inferReturnFields(state, spec.returning) : [],
  };

  return {
    name: "",
    entityName: "",
    operation,
    sql,
    params: state.params,
    returns,
  };
}

export function call(ir: SemanticIR, funcName: string, args: ParamSpec[]): QueryDescriptor {
  const state = createBuilderState(ir);

  const placeholders = args.map(arg => {
    const placeholder = `$${state.params.length + 1}`;
    state.params.push({
      name: arg.name,
      pgType: arg.pgType,
      tsType: arg.tsType ?? "unknown",
      nullable: arg.nullable ?? false,
    });
    return placeholder;
  });

  const sql = `SELECT ${funcName}(${placeholders.join(", ")})`;
  const returns: ReturnDescriptor = {
    mode: "oneOrNone",
    fields: [],
  };

  return {
    name: "",
    entityName: "",
    operation: "select",
    sql,
    params: state.params,
    returns,
  };
}
