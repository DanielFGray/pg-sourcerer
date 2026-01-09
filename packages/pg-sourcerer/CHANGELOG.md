# Changelog

## [0.2.1](https://github.com/DanielFGray/pg-sourcerer/compare/v0.2.0...v0.2.1) (2026-01-09)


### Features

* **conjure:** add export.* helpers for cleaner export generation ([0853b94](https://github.com/DanielFGray/pg-sourcerer/commit/0853b94ddd39b530d5d4e8059bcbb70fbe51b6aa))
* **sql-queries:** add stored function wrappers ([8bb97e4](https://github.com/DanielFGray/pg-sourcerer/commit/8bb97e404c471364c10d823e1e74067b8a64a370))


### Bug Fixes

* **cli:** refactor config loading to use Effect DI pattern ([e756bc2](https://github.com/DanielFGray/pg-sourcerer/commit/e756bc233651af88cbb6239b8c009e4a9c7c2663))

## [0.2.0](https://github.com/DanielFGray/pg-sourcerer/compare/v0.1.10...v0.2.0) (2026-01-09)


### ⚠ BREAKING CHANGES

* **inflection:** classicInflectionConfig and ClassicInflectionLive removed

### Features

* add ArkType schema generation plugin ([2e1840f](https://github.com/DanielFGray/pg-sourcerer/commit/2e1840fbe7e5e3f200fe1aea23b00a4ff435772b))
* add enumStyle and typeReferences config to validation plugins ([dbec244](https://github.com/DanielFGray/pg-sourcerer/commit/dbec244624e61a69173c6940545eb4572db37bd1))
* Add formatter hook for post-generation code formatting ([606a2d8](https://github.com/DanielFGray/pg-sourcerer/commit/606a2d8912b6b9071acaf9abc788195414fda48d))
* Add FunctionEntity to IR for PostgreSQL stored functions ([043e7ce](https://github.com/DanielFGray/pg-sourcerer/commit/043e7cee21eb1c0089b451cce1093150381d17b0))
* add opclassNames to IndexDef via vendored pg-introspection ([b3c27fb](https://github.com/DanielFGray/pg-sourcerer/commit/b3c27fb7e41d55020b486381c5548588ad94d80f))
* add sql-queries plugin with typed query generation ([c284b30](https://github.com/DanielFGray/pg-sourcerer/commit/c284b30da1d941674edabd33171234b1a81d36fa))
* bare command runs generate, fix CLI permissions ([7bf6cdf](https://github.com/DanielFGray/pg-sourcerer/commit/7bf6cdf052c3143a0e6f6e4a0a9e1d1094070140))
* **cli:** add interactive init command for config generation ([641df17](https://github.com/DanielFGray/pg-sourcerer/commit/641df1759517d7d24a9af064beeb5da82ec3c360))
* **conjure:** add rawStatement for arbitrary code emission ([4762ec2](https://github.com/DanielFGray/pg-sourcerer/commit/4762ec25cd9b4fbf7b69bdde4f34fe3d5349f280))
* **effect-model:** add @effect/sql Model plugin with clean output patterns ([82177c9](https://github.com/DanielFGray/pg-sourcerer/commit/82177c98f730ae89ab183df35309b422b5ed35f3))
* fix kysely plugins table/type naming consistency ([6f86dfa](https://github.com/DanielFGray/pg-sourcerer/commit/6f86dfaa9ecf871dccf03ca066f61de88e917dfb))
* generate composite types in validation plugins (zod, arktype, effect-model) ([1b3a9b3](https://github.com/DanielFGray/pg-sourcerer/commit/1b3a9b366f0d77e9eed8a0ce304d5845a177ddd8))
* **init:** detect postgres connection strings in .env and process.env ([d6eb123](https://github.com/DanielFGray/pg-sourcerer/commit/d6eb12309f01aece91e9b2091bc80e969a78cb65))
* **init:** discover schemas with table counts and prompt to run generate ([b3b3efb](https://github.com/DanielFGray/pg-sourcerer/commit/b3b3efbccf9baa37b346c57ef973d8927790601c))
* **ir:** add IndexDef and simplify relation name handling ([1e8f4a8](https://github.com/DanielFGray/pg-sourcerer/commit/1e8f4a851efeb5f177471491aaad55d5545e4948))
* **ir:** add relation graph utilities for join path finding ([a1cd007](https://github.com/DanielFGray/pg-sourcerer/commit/a1cd0076471065aaac859552fdb6f3b1580c2816))
* **ir:** add reverse relations helpers (getReverseRelations, getAllRelations) ([f5ce23c](https://github.com/DanielFGray/pg-sourcerer/commit/f5ce23ccf055005a713370dacc0cc6f9622a4a62))
* **kysely-queries:** add Kysely query generation plugin ([0682684](https://github.com/DanielFGray/pg-sourcerer/commit/06826845ba057efeee0d44ba20d60d24c4151cbf))
* **kysely-queries:** flat exports with configurable naming functions ([9e9d053](https://github.com/DanielFGray/pg-sourcerer/commit/9e9d053326023258fe24b7f622d6bdf8a69e3aab))
* **lib:** add hex module for SQL query building and param helpers for conjure ([98df7b6](https://github.com/DanielFGray/pg-sourcerer/commit/98df7b621bffa802ed2fff90f8da9a8cef3a78b8))
* **plugins:** add inflection composition and fix citext array mapping ([692185b](https://github.com/DanielFGray/pg-sourcerer/commit/692185b5b9f1f1088703debf4ef5add17f74ad53))
* **plugins:** make all plugin config options optional with sensible defaults ([80e9a53](https://github.com/DanielFGray/pg-sourcerer/commit/80e9a53dcbd84ea32cc9770e4ef5aabc9544ef95))
* **plugins:** simplify plugin config syntax with curried definePlugin ([04a1977](https://github.com/DanielFGray/pg-sourcerer/commit/04a19775468f5c2caa09c14b4fe34612bf077ddb))
* prepare package for npm publication ([fffdb07](https://github.com/DanielFGray/pg-sourcerer/commit/fffdb071cc11471353493223f8781600e5bc2ad3))
* **sql-queries:** add sqlStyle config for tag vs string query generation ([a00dcc3](https://github.com/DanielFGray/pg-sourcerer/commit/a00dcc3124a27a378b81ca7912489129090afe38))


### Bug Fixes

* add --ignore-scripts to npm publish to use bun pack tarball ([d9741a4](https://github.com/DanielFGray/pg-sourcerer/commit/d9741a4dd05da325c41ace7c43e90c4888005b40))
* add postgres.js dependency for init command ([648e551](https://github.com/DanielFGray/pg-sourcerer/commit/648e551f7035f92aaa7f1985a6ebd962bd0c3c2c))
* add working-directory and use ls for tarball detection in publish ([0215136](https://github.com/DanielFGray/pg-sourcerer/commit/02151361ba42d721ff3e234b9b73484cb5753ae8))
* CI - build pg-introspection before tests, use Effect Array.groupBy for Node 20 compat ([3ffa965](https://github.com/DanielFGray/pg-sourcerer/commit/3ffa965d3d56de83e61d964d143ecca71d57f173))
* correct repository URL case for npm provenance ([3b2904e](https://github.com/DanielFGray/pg-sourcerer/commit/3b2904efa5c12567eccbdce6e43979695ff81c68))
* **generate:** ensure inflectionLayer takes precedence over PluginRunner.Default ([ae524d3](https://github.com/DanielFGray/pg-sourcerer/commit/ae524d3b7bdd117f05a357a7b5afdd13d626f0cf))
* **init:** staged plugin prompts to prevent conflicts, fix generate after init ([4a7bb35](https://github.com/DanielFGray/pg-sourcerer/commit/4a7bb356d241c33df112499d18ff09ef3985c1f1))
* **kysely-queries:** rename findMany to listMany (opt-in), dedupe lookups by column ([082046c](https://github.com/DanielFGray/pg-sourcerer/commit/082046c9755f218615d79d916a0fd1595da9bccc))
* pass configured role to IR builder for permission filtering ([658d1b9](https://github.com/DanielFGray/pg-sourcerer/commit/658d1b9864187f1121db9482463d23381701d764))
* preserve snake_case field names by default, add FK semantic naming to query plugins ([4158a74](https://github.com/DanielFGray/pg-sourcerer/commit/4158a74f664a5643cfd8b38b498f32e05672a3d2))
* use bun pack then npm publish for proper dep resolution ([36bed67](https://github.com/DanielFGray/pg-sourcerer/commit/36bed673b7be3bde4bf1458c4c5413058bd791b8))


### Code Refactoring

* **inflection:** make classic conventions the default ([1495cc7](https://github.com/DanielFGray/pg-sourcerer/commit/1495cc7a18e02f05f3fa70fa1bc96c1bf8d85f3e))
