// @ts-check
import * as utils from "../utils/index.mjs";

/**
 * @type {(opts?: {
 *   schemas?: Array<string>
 *   tables?: Array<string>
 *   inflections?: import("../utils/index.mjs").Inflections
 *   path?: string | ((o: { schema: string, name: string }) => string),
 * }) => import("../index.mjs").Plugin}
 */
export const makeTypesPlugin = pluginOpts => ({
  name: "types",
  inflections: {
    types: ["classify"],
    columns: [],
  },
  render({ introspection, config }) {
    const b = utils.builders;
    return Object.values(introspection.schemas)
      .filter(schema => pluginOpts?.schemas?.includes(schema.name) ?? true)
      .flatMap(schema => {
        const enums = Object.values(schema.types)
          .filter(t => t.kind === "enum")
          .map(t => {
            return b.exportNamedDeclaration.from({
              declaration: b.tsTypeAliasDeclaration.from({
                id: t.name,
                typeAnnotation: b.tsUnionType(t.values.map(v => b.literal(v))),
              }),
            });
          });

        const tables = Object.values(schema.tables)
          .filter(table => pluginOpts?.tables?.includes(table.name) ?? true)
          .map(table => {
            const identifier = config.inflections.types(table.name);
            const typeAlias = b.exportNamedDeclaration.from({
              comments: table.description
                ? [
                    b.commentBlock.from({
                      leading: true,
                      value: `* ${table.description} `,
                    }),
                  ]
                : null,
              declaration: b.tsTypeAliasDeclaration.from({
                id: b.identifier(identifier),
                typeAnnotation: b.tsTypeLiteral(
                  Object.values(table.columns).map(column => {
                    const type = utils.getASTTypeFromTypeName(
                      utils.getTSTypeNameFromPgType(column.type, config),
                    );
                    return b.tsPropertySignature.from({
                      comments: column.description
                        ? [b.commentBlock(`* ${column.description} `)]
                        : null,
                      key: b.identifier(config.inflections.columns(column.name)),
                      typeAnnotation: b.tsTypeAnnotation(
                        column.nullable ? b.tsUnionType([type, b.tsNullKeyword()]) : type,
                      ),
                    });
                  }),
                ),
              }),
            });
            return { identifier, typeAlias };
          });
        return [...tables, ...enums].map(({ identifier, typeAlias }) => ({
          path: utils.makePathFromConfig({
            config: { ...config, pluginOpts },
            name: identifier,
            schema: schema.name,
          }),
          content: typeAlias,
          exports: [{ identifier, kind: "type" }],
        }));
      });
  },
});
