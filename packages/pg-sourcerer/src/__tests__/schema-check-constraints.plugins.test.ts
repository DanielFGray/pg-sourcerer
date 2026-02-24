import { describe, it, expect } from "@effect/vitest";
import { Effect } from "effect";

import { zod } from "../plugins/zod.js";
import { valibot } from "../plugins/valibot.js";
import { arktype } from "../plugins/arktype.js";
import { testIRWithEntities, testPluginEmit } from "../testing.js";
import type { Field, Shape, TableEntity } from "../ir/semantic-ir.js";
import { mockPgAttribute, mockPgClass, mockPgType } from "./mocks/pg-introspection.js";

function mockField(name: string, typeName: string, optional = false): Field {
  const pgType = mockPgType({ typname: typeName, typcategory: "S", typtype: "b" });
  return {
    name,
    columnName: name,
    pgAttribute: mockPgAttribute({
      attname: name,
      attnotnull: true,
      atthasdef: false,
      getType: () => pgType,
    }),
    nullable: false,
    optional,
    hasDefault: false,
    isGenerated: false,
    isIdentity: false,
    isArray: false,
    elementTypeName: undefined,
    tags: {},
    extensions: new Map(),
    permissions: { canSelect: true, canInsert: true, canUpdate: true },
  };
}

function mockTableWithBioCheck(): TableEntity {
  const rowShape: Shape = {
    name: "User",
    kind: "row",
    fields: [mockField("id", "uuid"), mockField("bio", "text")],
  };
  const updateShape: Shape = {
    name: "UserUpdate",
    kind: "update",
    fields: [mockField("bio", "text", true)],
  };

  return {
    kind: "table",
    name: "User",
    pgName: "users",
    schemaName: "public",
    pgClass: mockPgClass({ relname: "users" }),
    primaryKey: { columns: ["id"], isVirtual: false },
    indexes: [],
    shapes: { row: rowShape, update: updateShape },
    relations: [],
    checkConstraints: [
      {
        name: "users_bio_max",
        definition: "CHECK ((length(bio) <= 4000))",
        columns: ["bio"],
      },
    ],
    tags: {},
    permissions: { canSelect: true, canInsert: true, canUpdate: true, canDelete: true },
  };
}

function content(files: readonly { path: string; content: string }[]): string {
  return files.find(f => f.path === "schemas.ts")?.content ?? "";
}

describe("Schema Plugins - CHECK Constraints", () => {
  it.effect("zod applies table CHECK constraints to row/update shapes", () =>
    Effect.gen(function* () {
      const ir = testIRWithEntities([mockTableWithBioCheck()]);
      const { files } = yield* testPluginEmit(zod(), { ir });
      const schemas = content(files);

      expect(schemas).toContain("bio: z.string().max(4000),");
      expect(schemas).toContain("export const UserUpdate = User.pick({");
      expect(schemas).toContain("bio: true,");
      expect(schemas).toContain("}).partial();");
    }),
  );

  it.effect("valibot applies table CHECK constraints to row/update shapes", () =>
    Effect.gen(function* () {
      const ir = testIRWithEntities([mockTableWithBioCheck()]);
      const { files } = yield* testPluginEmit(valibot(), { ir });
      const schemas = content(files);

      expect(schemas).toContain("bio: v.pipe(v.string(), v.maxLength(4000)),");
      expect(schemas).toContain("bio: v.optional(v.pipe(v.string(), v.maxLength(4000))),");
    }),
  );

  it.effect("arktype applies table CHECK constraints to row/update shapes", () =>
    Effect.gen(function* () {
      const ir = testIRWithEntities([mockTableWithBioCheck()]);
      const { files } = yield* testPluginEmit(arktype(), { ir });
      const schemas = content(files);

      expect(schemas).toContain('bio: "string <= 4000",');
      expect(schemas).toContain('export const UserUpdate = User.pick("bio").partial();');
    }),
  );
});
