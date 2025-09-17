// @ts-check
import * as utils from "../utils/index.mjs";

const b = utils.builders;

/**
 * @type {(pluginOpts?: {
 *   schemas?: Array<string>
 *   tables?: Array<string>
 *   views?: Array<string>
 *   path?: string | ((o: { schema: string, name: string }) => string),
 *   exportType?: boolean
 * }) => import("../index.mjs").Plugin}
 */
export const makeZodSchemasPlugin = pluginOpts => ({
  name: "schemas",
  inflections: {
    types: ["camelize", "singularize"],
    schemas: ["camelize", "singularize"],
  },
  render({ introspection, config }) {
    return Object.values(introspection.schemas)
      .filter(s => pluginOpts?.schemas?.includes(s.name) ?? true)
      .flatMap(schema => {
        const createSchemaFromEntity = (entity) => {
          const identifier = config.inflections.schemas(entity.name);
          const exportType = b.exportNamedDeclaration(
            b.tsTypeAliasDeclaration.from({
              id: b.identifier(config.inflections.schemas(identifier)),
              typeAnnotation: b.tsExpressionWithTypeArguments(
                b.tsQualifiedName(b.identifier("z"), b.identifier("infer")),
                b.tsTypeParameterInstantiation([
                  b.tsTypeQuery(b.identifier(config.inflections.schemas(identifier))),
                ]),
              ),
            }),
          );

          const zodSchema = b.exportNamedDeclaration(
            b.variableDeclaration("const", [
              b.variableDeclarator(
                b.identifier(config.inflections.schemas(identifier)),
                b.callExpression(
                  b.memberExpression(
                    b.callExpression(
                      b.memberExpression(b.identifier("z"), b.identifier("object")),
                      [
                        b.objectExpression(
                          Object.values(entity.columns).map(c => {
                            let tsType = utils.getTSTypeNameFromPgType(c.type, config);
                            if (!tsType) {
                              tsType = "unknown";
                            }
                            const value = b.callExpression(
                              b.memberExpression(b.identifier("z"), b.identifier(tsType)),
                              [],
                            );
                            const typeModifiers = [
                              ...(c.nullable ? ["nullable"] : []),
                              ...({ "pg_catalog.uuid": ["uuid"] }[c.type] ?? []),
                            ].reduceRight(
                              (p, i) =>
                                b.callExpression(b.memberExpression(p, b.identifier(i)), []),
                              value,
                            );
                            return b.objectProperty.from({
                              key: b.literal(config.inflections.columns(c.name)),
                              value: typeModifiers,
                            });
                          }),
                        ),
                      ],
                    ),
                    b.identifier("strict"),
                  ),
                  [],
                ),
              ),
            ]),
          );
          return {
            content: pluginOpts?.exportType ? [zodSchema, exportType] : [zodSchema],
            identifier,
          };
        };

        const tables = Object.values(schema.tables)
          .filter(table => pluginOpts?.tables?.includes(table.name) ?? true)
          .map(createSchemaFromEntity);

        const views = Object.values(schema.views)
          .filter(view => pluginOpts?.views?.includes(view.name) ?? true)
          .map(createSchemaFromEntity);

        return [
          ...tables,
          ...views
        ].map(
          ({ identifier, content }) =>
            /** @type {import("../index.mjs").Output} */ ({
              path: utils.makePathFromConfig({
                config: { ...config, pluginOpts },
                name: config.inflections.schemas(identifier),
                schema: schema.name,
              }),
              content,
              imports: [{ identifier: "z", path: "zod" }],
              exports: [
                { identifier, kind: "zodSchema" },
                ...(pluginOpts?.exportType ? [{ identifier, kind: "type" }] : []),
              ],
            }),
        );
      });
  },
});
