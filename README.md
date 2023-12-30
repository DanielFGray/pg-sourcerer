# pg-codeforge

a tool to generate code from Postgres introspection data

## getting started

currently this is still a work-in-progress, to see what's working so far, after cloning the repo

```sh
npm install
cd examples
npm install
npm setup
```

the setup script will
 * prompt for questions and generate a .env file
 * start postgres in a docker container
 * run migrations using graphile-migrate
 * run the codeforge plugins in the config file

## plugins

currently there are a few core plugins:

 * `makeTypesPlugin` - generates type aliases
 * `makeZodSchemasPlugin` - generates zod schemas
 * `makeQueriesPlugin` - generates CRUD queries
