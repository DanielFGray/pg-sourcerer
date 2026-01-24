# Changelog

## [0.5.1](https://github.com/DanielFGray/pg-sourcerer/compare/v0.5.0...v0.5.1) (2026-01-24)


### Features

* **cli:** expand init guidance ([2297765](https://github.com/DanielFGray/pg-sourcerer/commit/2297765a2ef30d62d8be19c5f1e4d916ec849f91))


### Bug Fixes

* **effect:** scope cross-references with forSymbol and add sqlClientLayer config ([4d6ebce](https://github.com/DanielFGray/pg-sourcerer/commit/4d6ebce204f757ad00067588afc8c1138a49eec3))
* **generator:** stabilize cursor pagination params ([f65cc5d](https://github.com/DanielFGray/pg-sourcerer/commit/f65cc5db1110c2eba21abb5bd4a52218faa5fc88))
* **plugins:** align schema consumption ([d85ab59](https://github.com/DanielFGray/pg-sourcerer/commit/d85ab59054c5779962ba0721809a1ab53b264c6f))

## [0.5.0](https://github.com/DanielFGray/pg-sourcerer/compare/v0.4.0...v0.5.0) (2026-01-21)


### ⚠ BREAKING CHANGES

* **inflection:** classicInflectionConfig and ClassicInflectionLive removed
* **inflection:** classicInflectionConfig and ClassicInflectionLive removed

### Features

* add ArkType schema generation plugin ([92a392a](https://github.com/DanielFGray/pg-sourcerer/commit/92a392a147ec4dab483afd63dfbf312f47b2bd0d))
* add ArkType schema generation plugin ([2e1840f](https://github.com/DanielFGray/pg-sourcerer/commit/2e1840fbe7e5e3f200fe1aea23b00a4ff435772b))
* add enumStyle and typeReferences config to validation plugins ([9c62411](https://github.com/DanielFGray/pg-sourcerer/commit/9c62411e21a3e690736a2092096fada4b849f028))
* add enumStyle and typeReferences config to validation plugins ([dbec244](https://github.com/DanielFGray/pg-sourcerer/commit/dbec244624e61a69173c6940545eb4572db37bd1))
* Add formatter hook for post-generation code formatting ([815cd7f](https://github.com/DanielFGray/pg-sourcerer/commit/815cd7f849a99330338ac6827b4c70c7529ff21a))
* Add formatter hook for post-generation code formatting ([606a2d8](https://github.com/DanielFGray/pg-sourcerer/commit/606a2d8912b6b9071acaf9abc788195414fda48d))
* Add FunctionEntity to IR for PostgreSQL stored functions ([7881147](https://github.com/DanielFGray/pg-sourcerer/commit/7881147db76a6f2a95283ccee7dd414392efc7fc))
* Add FunctionEntity to IR for PostgreSQL stored functions ([043e7ce](https://github.com/DanielFGray/pg-sourcerer/commit/043e7cee21eb1c0089b451cce1093150381d17b0))
* add opclassNames to IndexDef via vendored pg-introspection ([e4d7bb5](https://github.com/DanielFGray/pg-sourcerer/commit/e4d7bb586a2ca48354d125c62ede9395eae0e142))
* add opclassNames to IndexDef via vendored pg-introspection ([b3c27fb](https://github.com/DanielFGray/pg-sourcerer/commit/b3c27fb7e41d55020b486381c5548588ad94d80f))
* add sql-queries plugin with typed query generation ([752d2f7](https://github.com/DanielFGray/pg-sourcerer/commit/752d2f7911b182e8854fd010b25ee71ee75ba4a4))
* add sql-queries plugin with typed query generation ([c284b30](https://github.com/DanielFGray/pg-sourcerer/commit/c284b30da1d941674edabd33171234b1a81d36fa))
* bare command runs generate, fix CLI permissions ([b0b59ce](https://github.com/DanielFGray/pg-sourcerer/commit/b0b59ce89940ad168cca48ec9557a307f74da384))
* bare command runs generate, fix CLI permissions ([7bf6cdf](https://github.com/DanielFGray/pg-sourcerer/commit/7bf6cdf052c3143a0e6f6e4a0a9e1d1094070140))
* **cli:** add interactive init command for config generation ([1bbda47](https://github.com/DanielFGray/pg-sourcerer/commit/1bbda47cf46a559017321794d4f303dc980302f0))
* **cli:** add interactive init command for config generation ([641df17](https://github.com/DanielFGray/pg-sourcerer/commit/641df1759517d7d24a9af064beeb5da82ec3c360))
* **conjure,hex:** add AST helpers for route generation ([0bfa2b6](https://github.com/DanielFGray/pg-sourcerer/commit/0bfa2b6ac34c957dbb0998bc425b7e67c5f69c38))
* **conjure:** add export.* helpers for cleaner export generation ([0853b94](https://github.com/DanielFGray/pg-sourcerer/commit/0853b94ddd39b530d5d4e8059bcbb70fbe51b6aa))
* **conjure:** add export.* helpers for cleaner export generation ([8f38918](https://github.com/DanielFGray/pg-sourcerer/commit/8f38918ea1f4dcbc3437f98ee8e95f6a361925b0))
* **conjure:** add rawStatement for arbitrary code emission ([6448ba9](https://github.com/DanielFGray/pg-sourcerer/commit/6448ba9ae1df3f209074b388912862ccf8fd09a3))
* **conjure:** add rawStatement for arbitrary code emission ([4762ec2](https://github.com/DanielFGray/pg-sourcerer/commit/4762ec25cd9b4fbf7b69bdde4f34fe3d5349f280))
* cursor pagination and user module imports ([9818854](https://github.com/DanielFGray/pg-sourcerer/commit/9818854a5cfafc666e4aa334f635aa3b9df5eda2))
* declarative plugin system with DAG resolution ([ae462f8](https://github.com/DanielFGray/pg-sourcerer/commit/ae462f8f9d2e1b78151ca44e1f7aa6f8b45d9cea))
* **effect-model:** add @effect/sql Model plugin with clean output patterns ([33da0a8](https://github.com/DanielFGray/pg-sourcerer/commit/33da0a8b01820d67121d0a064fcd48069e6f29fa))
* **effect-model:** add @effect/sql Model plugin with clean output patterns ([82177c9](https://github.com/DanielFGray/pg-sourcerer/commit/82177c98f730ae89ab183df35309b422b5ed35f3))
* **effect:** add Effect plugin suite with HTTP API generation ([7260ee4](https://github.com/DanielFGray/pg-sourcerer/commit/7260ee492aa67463ece25645c903ccdc1ea7965f))
* **emissions:** add blank lines before export statements ([b2736e5](https://github.com/DanielFGray/pg-sourcerer/commit/b2736e5f7734011112f7450589dfe9e34ae1b4f0))
* **emissions:** detect and report undefined symbol references ([4980dd8](https://github.com/DanielFGray/pg-sourcerer/commit/4980dd87522f05d9a644c2602c6c86e739fdf328))
* export effect plugin and support plugin presets ([c7fe482](https://github.com/DanielFGray/pg-sourcerer/commit/c7fe4821dcc8421d747df6280b312a36f069dca1))
* fix kysely plugins table/type naming consistency ([232e618](https://github.com/DanielFGray/pg-sourcerer/commit/232e6189f23d50cdd7ff1bbe3577856effb9ddb7))
* fix kysely plugins table/type naming consistency ([6f86dfa](https://github.com/DanielFGray/pg-sourcerer/commit/6f86dfaa9ecf871dccf03ca066f61de88e917dfb))
* generate composite types in validation plugins (zod, arktype, effect-model) ([fe2e88a](https://github.com/DanielFGray/pg-sourcerer/commit/fe2e88ac87b0fb32b905863036f423f846c84b47))
* generate composite types in validation plugins (zod, arktype, effect-model) ([1b3a9b3](https://github.com/DanielFGray/pg-sourcerer/commit/1b3a9b366f0d77e9eed8a0ce304d5845a177ddd8))
* **init:** add HTTP/RPC framework selection ([b7c58fb](https://github.com/DanielFGray/pg-sourcerer/commit/b7c58fb57a71ce7589fdb00f84186af5454f74e9))
* **init:** detect postgres connection strings in .env and process.env ([c2d1e0b](https://github.com/DanielFGray/pg-sourcerer/commit/c2d1e0b1559255cfc97f1a0147e5d03f8e6a3579))
* **init:** detect postgres connection strings in .env and process.env ([d6eb123](https://github.com/DanielFGray/pg-sourcerer/commit/d6eb12309f01aece91e9b2091bc80e969a78cb65))
* **init:** discover schemas with table counts and prompt to run generate ([7b5fdb5](https://github.com/DanielFGray/pg-sourcerer/commit/7b5fdb5a2bf01333e3d15d25a45eb4eef4f18b78))
* **init:** discover schemas with table counts and prompt to run generate ([b3b3efb](https://github.com/DanielFGray/pg-sourcerer/commit/b3b3efbccf9baa37b346c57ef973d8927790601c))
* **init:** use AST builders for config generation and add all HTTP plugins ([79e51d0](https://github.com/DanielFGray/pg-sourcerer/commit/79e51d00d3ba2a18295ced0f6e8db84b977d4725))
* IR extensions and unified plugins ([184114f](https://github.com/DanielFGray/pg-sourcerer/commit/184114f19f12e8490f7c78e4b31cf59489c3c448))
* **ir:** add IndexDef and simplify relation name handling ([a815702](https://github.com/DanielFGray/pg-sourcerer/commit/a8157022a8a4e9f72aec6e844f7ea9294880397e))
* **ir:** add IndexDef and simplify relation name handling ([1e8f4a8](https://github.com/DanielFGray/pg-sourcerer/commit/1e8f4a851efeb5f177471491aaad55d5545e4948))
* **ir:** add relation graph utilities for join path finding ([9a65fc4](https://github.com/DanielFGray/pg-sourcerer/commit/9a65fc4d6bf39dc0207134c9066b2d3c87cdbf4d))
* **ir:** add relation graph utilities for join path finding ([a1cd007](https://github.com/DanielFGray/pg-sourcerer/commit/a1cd0076471065aaac859552fdb6f3b1580c2816))
* **ir:** add reverse relations helpers (getReverseRelations, getAllRelations) ([fa20a42](https://github.com/DanielFGray/pg-sourcerer/commit/fa20a422a66dc90f58dc11ec352688ce8b567579))
* **ir:** add reverse relations helpers (getReverseRelations, getAllRelations) ([f5ce23c](https://github.com/DanielFGray/pg-sourcerer/commit/f5ce23ccf055005a713370dacc0cc6f9622a4a62))
* **kysely-queries:** add defaultLimit config option ([1df994c](https://github.com/DanielFGray/pg-sourcerer/commit/1df994c4cef8057bcf75fac3da5ef34aaa775a08))
* **kysely-queries:** add Kysely query generation plugin ([3968991](https://github.com/DanielFGray/pg-sourcerer/commit/39689910d8f07ee7e8f4964825a9acb7fb9075be))
* **kysely-queries:** add Kysely query generation plugin ([0682684](https://github.com/DanielFGray/pg-sourcerer/commit/06826845ba057efeee0d44ba20d60d24c4151cbf))
* **kysely-queries:** flat exports with configurable naming functions ([b7981d2](https://github.com/DanielFGray/pg-sourcerer/commit/b7981d23e3e64174e973d0d392b6281aee539552))
* **kysely-queries:** flat exports with configurable naming functions ([9e9d053](https://github.com/DanielFGray/pg-sourcerer/commit/9e9d053326023258fe24b7f622d6bdf8a69e3aab))
* **kysely-types:** add composite type support ([f0b0441](https://github.com/DanielFGray/pg-sourcerer/commit/f0b044159c777a456782a52e351d9aabc18cc586))
* **lib:** add hex module for SQL query building and param helpers for conjure ([3fd5db1](https://github.com/DanielFGray/pg-sourcerer/commit/3fd5db138fdb48c2c68120f4c866c95ba2fc06fe))
* **lib:** add hex module for SQL query building and param helpers for conjure ([98df7b6](https://github.com/DanielFGray/pg-sourcerer/commit/98df7b621bffa802ed2fff90f8da9a8cef3a78b8))
* **plugins:** add explicitColumns config for runtime column filtering ([c39fcb0](https://github.com/DanielFGray/pg-sourcerer/commit/c39fcb05708ed5f9e394dbeb669e7c067af74e88))
* **plugins:** add exportStyle and exportName config to query plugins ([f20434a](https://github.com/DanielFGray/pg-sourcerer/commit/f20434ae78a13f23413b550edfdbe9cf15b6d270))
* **plugins:** add HTTP route generation plugins ([c533a8b](https://github.com/DanielFGray/pg-sourcerer/commit/c533a8b86d2db5aaf740d1d2cbdd2e6e8fcd6ed8))
* **plugins:** add inflection composition and fix citext array mapping ([a61bca8](https://github.com/DanielFGray/pg-sourcerer/commit/a61bca895135bae28486e60feb90695d5c8cf158))
* **plugins:** add inflection composition and fix citext array mapping ([692185b](https://github.com/DanielFGray/pg-sourcerer/commit/692185b5b9f1f1088703debf4ef5add17f74ad53))
* **plugins:** add valibot schema plugin ([cb3cc3e](https://github.com/DanielFGray/pg-sourcerer/commit/cb3cc3e9f96d71f191e80225c0afa2a784ad4a5c))
* **plugins:** make all plugin config options optional with sensible defaults ([2c95ec6](https://github.com/DanielFGray/pg-sourcerer/commit/2c95ec6fed6744cbdc31c4ee194e1aa3c467d6fa))
* **plugins:** make all plugin config options optional with sensible defaults ([80e9a53](https://github.com/DanielFGray/pg-sourcerer/commit/80e9a53dcbd84ea32cc9770e4ef5aabc9544ef95))
* **plugins:** simplify plugin config syntax with curried definePlugin ([c4d168f](https://github.com/DanielFGray/pg-sourcerer/commit/c4d168f4815be8efe522c1700064a15bc9534418))
* **plugins:** simplify plugin config syntax with curried definePlugin ([04a1977](https://github.com/DanielFGray/pg-sourcerer/commit/04a19775468f5c2caa09c14b4fe34612bf077ddb))
* **plugins:** support dynamic provides based on config ([8d6d0d3](https://github.com/DanielFGray/pg-sourcerer/commit/8d6d0d3b9f6f95f45611ebc3e30ec33a5e6e874f))
* prepare package for npm publication ([d6a2dd2](https://github.com/DanielFGray/pg-sourcerer/commit/d6a2dd215ffea8a48c1e4a69e1fa6bfc2725d54f))
* prepare package for npm publication ([fffdb07](https://github.com/DanielFGray/pg-sourcerer/commit/fffdb071cc11471353493223f8781600e5bc2ad3))
* restore two-phase plugin architecture from stash ([980f191](https://github.com/DanielFGray/pg-sourcerer/commit/980f191f0520be54a5c38e340163ee7f414e2eee))
* **sql-queries,kysely-queries:** add function wrapper generation ([8e3ea30](https://github.com/DanielFGray/pg-sourcerer/commit/8e3ea3014282ed26bd7d73080ac7cabd7d04ce14))
* **sql-queries:** add sqlStyle config for tag vs string query generation ([0281a68](https://github.com/DanielFGray/pg-sourcerer/commit/0281a68a19b9db899840a5eeea11a52c8d6c8436))
* **sql-queries:** add sqlStyle config for tag vs string query generation ([a00dcc3](https://github.com/DanielFGray/pg-sourcerer/commit/a00dcc3124a27a378b81ca7912489129090afe38))
* **sql-queries:** add stored function wrappers ([8bb97e4](https://github.com/DanielFGray/pg-sourcerer/commit/8bb97e404c471364c10d823e1e74067b8a64a370))
* **sql-queries:** add stored function wrappers ([353293d](https://github.com/DanielFGray/pg-sourcerer/commit/353293d1ce9feff8e4eddf19ae4081a0a2377cb8))


### Bug Fixes

* add --ignore-scripts to npm publish to use bun pack tarball ([a6f6e5b](https://github.com/DanielFGray/pg-sourcerer/commit/a6f6e5b7d66603e94a25253d676db993cb01423a))
* add --ignore-scripts to npm publish to use bun pack tarball ([d9741a4](https://github.com/DanielFGray/pg-sourcerer/commit/d9741a4dd05da325c41ace7c43e90c4888005b40))
* add postgres.js dependency for init command ([1002283](https://github.com/DanielFGray/pg-sourcerer/commit/1002283735826f6baa5a40437fa56ca02941020a))
* add postgres.js dependency for init command ([648e551](https://github.com/DanielFGray/pg-sourcerer/commit/648e551f7035f92aaa7f1985a6ebd962bd0c3c2c))
* add working-directory and use ls for tarball detection in publish ([b95e73d](https://github.com/DanielFGray/pg-sourcerer/commit/b95e73d37038cf6d2c4ec5689c2681cdcf995275))
* add working-directory and use ls for tarball detection in publish ([0215136](https://github.com/DanielFGray/pg-sourcerer/commit/02151361ba42d721ff3e234b9b73484cb5753ae8))
* CI - build pg-introspection before tests, use Effect Array.groupBy for Node 20 compat ([1654ff9](https://github.com/DanielFGray/pg-sourcerer/commit/1654ff92450902edf39c25f95241d8b21ba8ab89))
* CI - build pg-introspection before tests, use Effect Array.groupBy for Node 20 compat ([3ffa965](https://github.com/DanielFGray/pg-sourcerer/commit/3ffa965d3d56de83e61d964d143ecca71d57f173))
* **cli:** auto-run init when config file is missing ([b8b1a61](https://github.com/DanielFGray/pg-sourcerer/commit/b8b1a61d78ca444da488a1426eb40b9b6317ce39))
* **cli:** refactor config loading to use Effect DI pattern ([e756bc2](https://github.com/DanielFGray/pg-sourcerer/commit/e756bc233651af88cbb6239b8c009e4a9c7c2663))
* **cli:** refactor config loading to use Effect DI pattern ([34323fb](https://github.com/DanielFGray/pg-sourcerer/commit/34323fb9a51da7124b52418cce69a61ee874cc9e))
* correct repository URL case for npm provenance ([ad99716](https://github.com/DanielFGray/pg-sourcerer/commit/ad9971698859cc3aa49f53fbe98e939234fe15ab))
* correct repository URL case for npm provenance ([3b2904e](https://github.com/DanielFGray/pg-sourcerer/commit/3b2904efa5c12567eccbdce6e43979695ff81c68))
* **generate:** ensure inflectionLayer takes precedence over PluginRunner.Default ([590136d](https://github.com/DanielFGray/pg-sourcerer/commit/590136da33dfaa8005bd707661d9eba181d7ddef))
* **generate:** ensure inflectionLayer takes precedence over PluginRunner.Default ([ae524d3](https://github.com/DanielFGray/pg-sourcerer/commit/ae524d3b7bdd117f05a357a7b5afdd13d626f0cf))
* **init:** staged plugin prompts to prevent conflicts, fix generate after init ([36df9b6](https://github.com/DanielFGray/pg-sourcerer/commit/36df9b6580ac59a72ef1c7f25e80c3adea4e34ae))
* **init:** staged plugin prompts to prevent conflicts, fix generate after init ([4a7bb35](https://github.com/DanielFGray/pg-sourcerer/commit/4a7bb356d241c33df112499d18ff09ef3985c1f1))
* **kysely-queries:** rename findMany to listMany (opt-in), dedupe lookups by column ([e773e69](https://github.com/DanielFGray/pg-sourcerer/commit/e773e69b9d2d0e508d22e88ea6fea421de79fbb7))
* **kysely-queries:** rename findMany to listMany (opt-in), dedupe lookups by column ([082046c](https://github.com/DanielFGray/pg-sourcerer/commit/082046c9755f218615d79d916a0fd1595da9bccc))
* pass configured role to IR builder for permission filtering ([e12fc6d](https://github.com/DanielFGray/pg-sourcerer/commit/e12fc6d1a02497d95d5764ad91ab7e130e7bd4a5))
* pass configured role to IR builder for permission filtering ([658d1b9](https://github.com/DanielFGray/pg-sourcerer/commit/658d1b9864187f1121db9482463d23381701d764))
* **plugins:** simplify capability names and fix type registration ([595e4a4](https://github.com/DanielFGray/pg-sourcerer/commit/595e4a49ef48d559790f46856aaebdd1fd12d860))
* preserve snake_case field names by default, add FK semantic naming to query plugins ([e610d6e](https://github.com/DanielFGray/pg-sourcerer/commit/e610d6e49f7c2b21640ac8bb79084812d28b07ac))
* preserve snake_case field names by default, add FK semantic naming to query plugins ([4158a74](https://github.com/DanielFGray/pg-sourcerer/commit/4158a74f664a5643cfd8b38b498f32e05672a3d2))
* remove incorrect type dependencies from schema plugins ([4a0c06f](https://github.com/DanielFGray/pg-sourcerer/commit/4a0c06f6d1f37ef644b478a41c8c56815ac57d3f))
* **test:** remove incorrect dependsOn assertions from zod plugin test ([ddcf8cf](https://github.com/DanielFGray/pg-sourcerer/commit/ddcf8cf5cb1ee55dc617f62db467f9b448f5c164))
* use bun pack then npm publish for proper dep resolution ([c0f160c](https://github.com/DanielFGray/pg-sourcerer/commit/c0f160cbbb3fe6348e46a482965c4889b00f619e))
* use bun pack then npm publish for proper dep resolution ([36bed67](https://github.com/DanielFGray/pg-sourcerer/commit/36bed673b7be3bde4bf1458c4c5413058bd791b8))


### Code Refactoring

* **inflection:** make classic conventions the default ([1a998e5](https://github.com/DanielFGray/pg-sourcerer/commit/1a998e525b1d7509046814cc4732129c89078201))
* **inflection:** make classic conventions the default ([1495cc7](https://github.com/DanielFGray/pg-sourcerer/commit/1495cc7a18e02f05f3fa70fa1bc96c1bf8d85f3e))

## [0.2.2](https://github.com/DanielFGray/pg-sourcerer/compare/v0.2.1...v0.2.2) (2026-01-11)


### Features

* **conjure,hex:** add AST helpers for route generation ([0bfa2b6](https://github.com/DanielFGray/pg-sourcerer/commit/0bfa2b6ac34c957dbb0998bc425b7e67c5f69c38))
* **conjure:** add export.* helpers for cleaner export generation ([0853b94](https://github.com/DanielFGray/pg-sourcerer/commit/0853b94ddd39b530d5d4e8059bcbb70fbe51b6aa))
* declarative plugin system with DAG resolution ([ae462f8](https://github.com/DanielFGray/pg-sourcerer/commit/ae462f8f9d2e1b78151ca44e1f7aa6f8b45d9cea))
* **emissions:** add blank lines before export statements ([b2736e5](https://github.com/DanielFGray/pg-sourcerer/commit/b2736e5f7734011112f7450589dfe9e34ae1b4f0))
* **emissions:** detect and report undefined symbol references ([4980dd8](https://github.com/DanielFGray/pg-sourcerer/commit/4980dd87522f05d9a644c2602c6c86e739fdf328))
* **init:** add HTTP/RPC framework selection ([b7c58fb](https://github.com/DanielFGray/pg-sourcerer/commit/b7c58fb57a71ce7589fdb00f84186af5454f74e9))
* IR extensions and unified plugins ([184114f](https://github.com/DanielFGray/pg-sourcerer/commit/184114f19f12e8490f7c78e4b31cf59489c3c448))
* **kysely-queries:** add defaultLimit config option ([1df994c](https://github.com/DanielFGray/pg-sourcerer/commit/1df994c4cef8057bcf75fac3da5ef34aaa775a08))
* **kysely-types:** add composite type support ([f0b0441](https://github.com/DanielFGray/pg-sourcerer/commit/f0b044159c777a456782a52e351d9aabc18cc586))
* **plugins:** add explicitColumns config for runtime column filtering ([c39fcb0](https://github.com/DanielFGray/pg-sourcerer/commit/c39fcb05708ed5f9e394dbeb669e7c067af74e88))
* **plugins:** add exportStyle and exportName config to query plugins ([f20434a](https://github.com/DanielFGray/pg-sourcerer/commit/f20434ae78a13f23413b550edfdbe9cf15b6d270))
* **plugins:** add HTTP route generation plugins ([c533a8b](https://github.com/DanielFGray/pg-sourcerer/commit/c533a8b86d2db5aaf740d1d2cbdd2e6e8fcd6ed8))
* **plugins:** add valibot schema plugin ([cb3cc3e](https://github.com/DanielFGray/pg-sourcerer/commit/cb3cc3e9f96d71f191e80225c0afa2a784ad4a5c))
* **plugins:** support dynamic provides based on config ([8d6d0d3](https://github.com/DanielFGray/pg-sourcerer/commit/8d6d0d3b9f6f95f45611ebc3e30ec33a5e6e874f))
* **sql-queries,kysely-queries:** add function wrapper generation ([8e3ea30](https://github.com/DanielFGray/pg-sourcerer/commit/8e3ea3014282ed26bd7d73080ac7cabd7d04ce14))
* **sql-queries:** add stored function wrappers ([8bb97e4](https://github.com/DanielFGray/pg-sourcerer/commit/8bb97e404c471364c10d823e1e74067b8a64a370))


### Bug Fixes

* **cli:** refactor config loading to use Effect DI pattern ([e756bc2](https://github.com/DanielFGray/pg-sourcerer/commit/e756bc233651af88cbb6239b8c009e4a9c7c2663))
* **plugins:** simplify capability names and fix type registration ([595e4a4](https://github.com/DanielFGray/pg-sourcerer/commit/595e4a49ef48d559790f46856aaebdd1fd12d860))

## [0.2.1](https://github.com/DanielFGray/pg-sourcerer/compare/v0.2.0...v0.2.1) (2026-01-09)


### Features

* **conjure:** add export.* helpers for cleaner export generation ([0853b94](https://github.com/DanielFGray/pg-sourcerer/commit/0853b94ddd39b530d5d4e8059bcbb70fbe51b6aa))
* **sql-queries:** add stored function wrappers ([8bb97e4](https://github.com/DanielFGray/pg-sourcerer/commit/8bb97e404c471364c10d823e1e74067b8a64a370))


### Bug Fixes

* **cli:** refactor config loading to use Effect DI pattern ([e756bc2](https://github.com/DanielFGray/pg-sourcerer/commit/e756bc233651af88cbb6239b8c009e4a9c7c2663))

## [0.2.0](https://github.com/DanielFGray/pg-sourcerer/compare/v0.1.10...v0.2.0) (2026-01-09)

### ⚠ BREAKING CHANGES

- **inflection:** classicInflectionConfig and ClassicInflectionLive removed

### Features

- add ArkType schema generation plugin ([2e1840f](https://github.com/DanielFGray/pg-sourcerer/commit/2e1840fbe7e5e3f200fe1aea23b00a4ff435772b))
- add enumStyle and typeReferences config to validation plugins ([dbec244](https://github.com/DanielFGray/pg-sourcerer/commit/dbec244624e61a69173c6940545eb4572db37bd1))
- Add formatter hook for post-generation code formatting ([606a2d8](https://github.com/DanielFGray/pg-sourcerer/commit/606a2d8912b6b9071acaf9abc788195414fda48d))
- Add FunctionEntity to IR for PostgreSQL stored functions ([043e7ce](https://github.com/DanielFGray/pg-sourcerer/commit/043e7cee21eb1c0089b451cce1093150381d17b0))
- add opclassNames to IndexDef via vendored pg-introspection ([b3c27fb](https://github.com/DanielFGray/pg-sourcerer/commit/b3c27fb7e41d55020b486381c5548588ad94d80f))
- add sql-queries plugin with typed query generation ([c284b30](https://github.com/DanielFGray/pg-sourcerer/commit/c284b30da1d941674edabd33171234b1a81d36fa))
- bare command runs generate, fix CLI permissions ([7bf6cdf](https://github.com/DanielFGray/pg-sourcerer/commit/7bf6cdf052c3143a0e6f6e4a0a9e1d1094070140))
- **cli:** add interactive init command for config generation ([641df17](https://github.com/DanielFGray/pg-sourcerer/commit/641df1759517d7d24a9af064beeb5da82ec3c360))
- **conjure:** add rawStatement for arbitrary code emission ([4762ec2](https://github.com/DanielFGray/pg-sourcerer/commit/4762ec25cd9b4fbf7b69bdde4f34fe3d5349f280))
- **effect-model:** add @effect/sql Model plugin with clean output patterns ([82177c9](https://github.com/DanielFGray/pg-sourcerer/commit/82177c98f730ae89ab183df35309b422b5ed35f3))
- fix kysely plugins table/type naming consistency ([6f86dfa](https://github.com/DanielFGray/pg-sourcerer/commit/6f86dfaa9ecf871dccf03ca066f61de88e917dfb))
- generate composite types in validation plugins (zod, arktype, effect-model) ([1b3a9b3](https://github.com/DanielFGray/pg-sourcerer/commit/1b3a9b366f0d77e9eed8a0ce304d5845a177ddd8))
- **init:** detect postgres connection strings in .env and process.env ([d6eb123](https://github.com/DanielFGray/pg-sourcerer/commit/d6eb12309f01aece91e9b2091bc80e969a78cb65))
- **init:** discover schemas with table counts and prompt to run generate ([b3b3efb](https://github.com/DanielFGray/pg-sourcerer/commit/b3b3efbccf9baa37b346c57ef973d8927790601c))
- **ir:** add IndexDef and simplify relation name handling ([1e8f4a8](https://github.com/DanielFGray/pg-sourcerer/commit/1e8f4a851efeb5f177471491aaad55d5545e4948))
- **ir:** add relation graph utilities for join path finding ([a1cd007](https://github.com/DanielFGray/pg-sourcerer/commit/a1cd0076471065aaac859552fdb6f3b1580c2816))
- **ir:** add reverse relations helpers (getReverseRelations, getAllRelations) ([f5ce23c](https://github.com/DanielFGray/pg-sourcerer/commit/f5ce23ccf055005a713370dacc0cc6f9622a4a62))
- **kysely-queries:** add Kysely query generation plugin ([0682684](https://github.com/DanielFGray/pg-sourcerer/commit/06826845ba057efeee0d44ba20d60d24c4151cbf))
- **kysely-queries:** flat exports with configurable naming functions ([9e9d053](https://github.com/DanielFGray/pg-sourcerer/commit/9e9d053326023258fe24b7f622d6bdf8a69e3aab))
- **lib:** add hex module for SQL query building and param helpers for conjure ([98df7b6](https://github.com/DanielFGray/pg-sourcerer/commit/98df7b621bffa802ed2fff90f8da9a8cef3a78b8))
- **plugins:** add inflection composition and fix citext array mapping ([692185b](https://github.com/DanielFGray/pg-sourcerer/commit/692185b5b9f1f1088703debf4ef5add17f74ad53))
- **plugins:** make all plugin config options optional with sensible defaults ([80e9a53](https://github.com/DanielFGray/pg-sourcerer/commit/80e9a53dcbd84ea32cc9770e4ef5aabc9544ef95))
- **plugins:** simplify plugin config syntax with curried definePlugin ([04a1977](https://github.com/DanielFGray/pg-sourcerer/commit/04a19775468f5c2caa09c14b4fe34612bf077ddb))
- prepare package for npm publication ([fffdb07](https://github.com/DanielFGray/pg-sourcerer/commit/fffdb071cc11471353493223f8781600e5bc2ad3))
- **sql-queries:** add sqlStyle config for tag vs string query generation ([a00dcc3](https://github.com/DanielFGray/pg-sourcerer/commit/a00dcc3124a27a378b81ca7912489129090afe38))

### Bug Fixes

- add --ignore-scripts to npm publish to use bun pack tarball ([d9741a4](https://github.com/DanielFGray/pg-sourcerer/commit/d9741a4dd05da325c41ace7c43e90c4888005b40))
- add postgres.js dependency for init command ([648e551](https://github.com/DanielFGray/pg-sourcerer/commit/648e551f7035f92aaa7f1985a6ebd962bd0c3c2c))
- add working-directory and use ls for tarball detection in publish ([0215136](https://github.com/DanielFGray/pg-sourcerer/commit/02151361ba42d721ff3e234b9b73484cb5753ae8))
- CI - build pg-introspection before tests, use Effect Array.groupBy for Node 20 compat ([3ffa965](https://github.com/DanielFGray/pg-sourcerer/commit/3ffa965d3d56de83e61d964d143ecca71d57f173))
- correct repository URL case for npm provenance ([3b2904e](https://github.com/DanielFGray/pg-sourcerer/commit/3b2904efa5c12567eccbdce6e43979695ff81c68))
- **generate:** ensure inflectionLayer takes precedence over PluginRunner.Default ([ae524d3](https://github.com/DanielFGray/pg-sourcerer/commit/ae524d3b7bdd117f05a357a7b5afdd13d626f0cf))
- **init:** staged plugin prompts to prevent conflicts, fix generate after init ([4a7bb35](https://github.com/DanielFGray/pg-sourcerer/commit/4a7bb356d241c33df112499d18ff09ef3985c1f1))
- **kysely-queries:** rename findMany to listMany (opt-in), dedupe lookups by column ([082046c](https://github.com/DanielFGray/pg-sourcerer/commit/082046c9755f218615d79d916a0fd1595da9bccc))
- pass configured role to IR builder for permission filtering ([658d1b9](https://github.com/DanielFGray/pg-sourcerer/commit/658d1b9864187f1121db9482463d23381701d764))
- preserve snake_case field names by default, add FK semantic naming to query plugins ([4158a74](https://github.com/DanielFGray/pg-sourcerer/commit/4158a74f664a5643cfd8b38b498f32e05672a3d2))
- use bun pack then npm publish for proper dep resolution ([36bed67](https://github.com/DanielFGray/pg-sourcerer/commit/36bed673b7be3bde4bf1458c4c5413058bd791b8))

### Code Refactoring

- **inflection:** make classic conventions the default ([1495cc7](https://github.com/DanielFGray/pg-sourcerer/commit/1495cc7a18e02f05f3fa70fa1bc96c1bf8d85f3e))
