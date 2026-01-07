/**
 * Tests for Conjure - AST Builder DSL
 *
 * These tests verify the core functionality of the conjure module,
 * ensuring it generates correct JavaScript/TypeScript AST nodes.
 */
import { describe, it, expect } from "vitest"
import { conjure, cast } from "../lib/conjure.js"

/** Helper to get printed code from an expression */
const printExpr = (expr: any) => conjure.print(conjure.stmt.expr(expr))

/** Helper to get printed code from a statement */
const printStmt = (stmt: any) => conjure.print(stmt)

describe("Conjure", () => {
  describe("chain builder", () => {
    it("creates identifier", () => {
      const result = conjure.id("foo").build()
      expect(printExpr(result)).toBe("foo;")
    })

    it("chains property access", () => {
      const result = conjure.id("foo").prop("bar").prop("baz").build()
      expect(printExpr(result)).toBe("foo.bar.baz;")
    })

    it("chains method calls", () => {
      const result = conjure.id("foo").method("bar").method("baz").build()
      expect(printExpr(result)).toBe("foo.bar().baz();")
    })

    it("chains method calls with arguments", () => {
      const result = conjure
        .id("foo")
        .method("bar", [conjure.str("hello"), conjure.num(42)])
        .build()
      expect(printExpr(result)).toBe('foo.bar("hello", 42);')
    })

    it("chains mixed property and method access", () => {
      const result = conjure
        .id("z")
        .prop("coerce")
        .method("date")
        .method("nullable")
        .build()
      expect(printExpr(result)).toBe("z.coerce.date().nullable();")
    })

    it("chains direct calls", () => {
      const result = conjure
        .id("createHandler")
        .call([conjure.str("users")])
        .method("use", [conjure.id("auth").build()])
        .build()
      expect(printExpr(result)).toBe('createHandler("users").use(auth);')
    })

    it("chains computed property access", () => {
      const result = conjure
        .id("arr")
        .index(conjure.num(0))
        .prop("value")
        .build()
      expect(printExpr(result)).toBe("arr[0].value;")
    })

    it("chains computed property with expression", () => {
      const result = conjure
        .id("obj")
        .index(conjure.id("key").build())
        .build()
      expect(printExpr(result)).toBe("obj[key];")
    })

    it("starts chain from arbitrary expression", () => {
      const inner = conjure.id("getConfig").method("load").build()
      const result = conjure.chain(inner).prop("settings").build()
      expect(printExpr(result)).toBe("getConfig.load().settings;")
    })
  })

  describe("object builder", () => {
    it("creates empty object", () => {
      const result = conjure.obj().build()
      expect(printExpr(result)).toBe("({});")
    })

    it("creates object with properties", () => {
      const result = conjure
        .obj()
        .prop("name", conjure.str("test"))
        .prop("count", conjure.num(42))
        .build()
      expect(printExpr(result)).toContain('name: "test"')
      expect(printExpr(result)).toContain("count: 42")
    })

    it("creates object with computed property", () => {
      const result = conjure
        .obj()
        .computed(conjure.id("key").build(), conjure.str("value"))
        .build()
      expect(printExpr(result)).toContain('[key]: "value"')
    })

    it("creates object with spread", () => {
      const result = conjure
        .obj()
        .spread(conjure.id("defaults").build())
        .prop("override", conjure.bool(true))
        .build()
      expect(printExpr(result)).toContain("...defaults")
      expect(printExpr(result)).toContain("override: true")
    })

    it("creates object with shorthand property", () => {
      const result = conjure.obj().shorthand("name").shorthand("value").build()
      // Shorthand properties print as `name` not `name: name`
      const code = printExpr(result)
      expect(code).toContain("name")
      expect(code).toContain("value")
    })

    it("creates nested objects", () => {
      const result = conjure
        .obj()
        .prop(
          "nested",
          conjure.obj().prop("deep", conjure.str("value")).build()
        )
        .build()
      expect(printExpr(result)).toContain("nested:")
      expect(printExpr(result)).toContain('deep: "value"')
    })
  })

  describe("array builder", () => {
    it("creates empty array", () => {
      const result = conjure.arr().build()
      expect(printExpr(result)).toBe("[];")
    })

    it("creates array with initial elements", () => {
      const result = conjure
        .arr(conjure.num(1), conjure.num(2), conjure.num(3))
        .build()
      expect(printExpr(result)).toBe("[1, 2, 3];")
    })

    it("adds elements to array", () => {
      const result = conjure
        .arr()
        .add(conjure.str("a"))
        .add(conjure.str("b"), conjure.str("c"))
        .build()
      expect(printExpr(result)).toBe('["a", "b", "c"];')
    })

    it("creates array with spread", () => {
      const result = conjure
        .arr(conjure.num(1))
        .spread(conjure.id("rest").build())
        .add(conjure.num(99))
        .build()
      expect(printExpr(result)).toBe("[1, ...rest, 99];")
    })

    it("creates array of expressions", () => {
      const result = conjure
        .arr(
          conjure.id("a").build(),
          conjure.id("b").method("get").build()
        )
        .build()
      expect(printExpr(result)).toBe("[a, b.get()];")
    })
  })

  describe("function builder", () => {
    it("creates arrow function", () => {
      const result = conjure
        .fn()
        .arrow()
        .param("x")
        .body(conjure.stmt.return(conjure.id("x").build()))
        .build()
      expect(printExpr(result)).toContain("x =>")
      expect(printExpr(result)).toContain("return x")
    })

    it("creates async arrow function", () => {
      const result = conjure
        .fn()
        .async()
        .arrow()
        .param("url")
        .body(
          conjure.stmt.return(
            conjure.await(conjure.id("fetch").call([conjure.id("url").build()]).build())
          )
        )
        .build()
      expect(printExpr(result)).toContain("async")
      expect(printExpr(result)).toContain("await fetch(url)")
    })

    it("creates function with typed parameters", () => {
      const result = conjure
        .fn()
        .arrow()
        .param("name", conjure.ts.string())
        .param("age", conjure.ts.number())
        .body(conjure.stmt.return(conjure.bool(true)))
        .build()
      expect(printExpr(result)).toContain("name: string")
      expect(printExpr(result)).toContain("age: number")
    })

    it("creates function with optional parameters", () => {
      const result = conjure
        .fn()
        .arrow()
        .param("required", conjure.ts.string())
        .optionalParam("optional", conjure.ts.number())
        .body(conjure.stmt.return(conjure.bool(true)))
        .build()
      expect(printExpr(result)).toContain("required: string")
      expect(printExpr(result)).toContain("optional?: number")
    })

    it("creates function with rest parameters", () => {
      const result = conjure
        .fn()
        .arrow()
        .param("first")
        .restParam("rest", conjure.ts.array(conjure.ts.string()))
        .body(conjure.stmt.return(conjure.id("rest").build()))
        .build()
      expect(printExpr(result)).toContain("...rest: string[]")
    })

    it("creates function with default parameters", () => {
      const result = conjure
        .fn()
        .arrow()
        .defaultParam("count", conjure.num(10), conjure.ts.number())
        .body(conjure.stmt.return(conjure.id("count").build()))
        .build()
      expect(printExpr(result)).toContain("count: number = 10")
    })

    it("creates function with return type", () => {
      const result = conjure
        .fn()
        .arrow()
        .returns(conjure.ts.string())
        .body(conjure.stmt.return(conjure.str("hello")))
        .build()
      expect(printExpr(result)).toContain("): string =>")
    })

    it("creates function expression (non-arrow)", () => {
      const result = conjure
        .fn()
        .param("x")
        .body(conjure.stmt.return(conjure.id("x").build()))
        .build()
      expect(printExpr(result)).toContain("function(x)")
    })

    it("creates generator function", () => {
      const result = conjure
        .fn()
        .generator()
        .body(
          conjure.stmt.expr(
            conjure.id("yield").call([conjure.num(1)]).build()
          )
        )
        .build()
      expect(printExpr(result)).toContain("function*()")
    })

    it("creates function declaration", () => {
      const result = conjure
        .fn()
        .async()
        .param("id", conjure.ts.string())
        .returns(conjure.ts.ref("Promise", [conjure.ts.ref("User")]))
        .body(
          conjure.stmt.return(
            conjure.id("db").method("find", [conjure.id("id").build()]).build()
          )
        )
        .toDeclaration("getUser")
      expect(printStmt(result)).toContain("async function getUser")
      expect(printStmt(result)).toContain("id: string")
      expect(printStmt(result)).toContain("Promise<User>")
    })
  })

  describe("literals", () => {
    it("creates string literal", () => {
      expect(printExpr(conjure.str("hello"))).toBe('"hello";')
    })

    it("creates numeric literal", () => {
      expect(printExpr(conjure.num(42))).toBe("42;")
      expect(printExpr(conjure.num(3.14))).toBe("3.14;")
    })

    it("creates boolean literals", () => {
      expect(printExpr(conjure.bool(true))).toBe("true;")
      expect(printExpr(conjure.bool(false))).toBe("false;")
    })

    it("creates null literal", () => {
      expect(printExpr(conjure.null())).toBe("null;")
    })

    it("creates undefined", () => {
      expect(printExpr(conjure.undefined())).toBe("undefined;")
    })

    it("creates template literal", () => {
      const result = conjure.template(
        ["Hello, ", "!"],
        conjure.id("name").build()
      )
      expect(printExpr(result)).toContain("`Hello, ${name}!`")
    })
  })

  describe("operators", () => {
    describe("binary operators", () => {
      it("creates strict equality", () => {
        const result = conjure.op.eq(
          conjure.id("a").build(),
          conjure.id("b").build()
        )
        expect(printExpr(result)).toBe("a === b;")
      })

      it("creates strict inequality", () => {
        const result = conjure.op.neq(
          conjure.id("a").build(),
          conjure.id("b").build()
        )
        expect(printExpr(result)).toBe("a !== b;")
      })

      it("creates generic binary expression", () => {
        const result = conjure.op.binary(
          conjure.id("a").build(),
          "+",
          conjure.id("b").build()
        )
        expect(printExpr(result)).toBe("a + b;")
      })

      it("creates comparison operators", () => {
        expect(
          printExpr(
            conjure.op.binary(conjure.num(1), "<", conjure.num(2))
          )
        ).toBe("1 < 2;")
        expect(
          printExpr(
            conjure.op.binary(conjure.num(1), ">=", conjure.num(2))
          )
        ).toBe("1 >= 2;")
      })

      it("creates instanceof check", () => {
        const result = conjure.op.binary(
          conjure.id("err").build(),
          "instanceof",
          conjure.id("Error").build()
        )
        expect(printExpr(result)).toBe("err instanceof Error;")
      })
    })

    describe("logical operators", () => {
      it("creates logical and", () => {
        const result = conjure.op.and(
          conjure.id("a").build(),
          conjure.id("b").build()
        )
        expect(printExpr(result)).toBe("a && b;")
      })

      it("creates logical or", () => {
        const result = conjure.op.or(
          conjure.id("a").build(),
          conjure.id("b").build()
        )
        expect(printExpr(result)).toBe("a || b;")
      })

      it("creates nullish coalescing", () => {
        const result = conjure.op.nullish(
          conjure.id("a").build(),
          conjure.str("default")
        )
        expect(printExpr(result)).toBe('a ?? "default";')
      })

      it("creates generic logical expression", () => {
        const result = conjure.op.logical(
          conjure.id("a").build(),
          "??",
          conjure.id("b").build()
        )
        expect(printExpr(result)).toBe("a ?? b;")
      })
    })

    describe("unary operators", () => {
      it("creates logical not", () => {
        const result = conjure.op.not(conjure.id("flag").build())
        expect(printExpr(result)).toBe("!flag;")
      })

      it("creates generic unary expression", () => {
        const result = conjure.op.unary("typeof", conjure.id("x").build())
        expect(printExpr(result)).toBe("typeof x;")
      })

      it("creates negation", () => {
        const result = conjure.op.unary("-", conjure.num(42))
        expect(printExpr(result)).toBe("-42;")
      })
    })

    describe("other operators", () => {
      it("creates ternary expression", () => {
        const result = conjure.op.ternary(
          conjure.id("cond").build(),
          conjure.str("yes"),
          conjure.str("no")
        )
        expect(printExpr(result)).toBe('cond ? "yes" : "no";')
      })

      it("creates new expression", () => {
        const result = conjure.op.new(
          conjure.id("Error").build(),
          [conjure.str("message")]
        )
        expect(printExpr(result)).toBe('new Error("message");')
      })

      it("creates new expression without arguments", () => {
        const result = conjure.op.new(conjure.id("Date").build())
        expect(printExpr(result)).toBe("new Date();")
      })

      it("creates assignment expression", () => {
        const result = conjure.op.assign(
          conjure.id("x").build(),
          "=",
          conjure.num(42)
        )
        expect(printExpr(result)).toBe("x = 42;")
      })

      it("creates compound assignment", () => {
        const result = conjure.op.assign(
          conjure.id("count").build(),
          "+=",
          conjure.num(1)
        )
        expect(printExpr(result)).toBe("count += 1;")
      })
    })
  })

  describe("statements", () => {
    it("creates const declaration", () => {
      const result = conjure.stmt.const("x", conjure.num(42))
      expect(printStmt(result)).toBe("const x = 42;")
    })

    it("creates const declaration with type", () => {
      const result = conjure.stmt.const(
        "name",
        conjure.str("test"),
        conjure.ts.string()
      )
      expect(printStmt(result)).toBe('const name: string = "test";')
    })

    it("creates let declaration", () => {
      const result = conjure.stmt.let("x", conjure.num(0))
      expect(printStmt(result)).toBe("let x = 0;")
    })

    it("creates let declaration without initializer", () => {
      const result = conjure.stmt.let("x", undefined, conjure.ts.number())
      expect(printStmt(result)).toBe("let x: number;")
    })

    it("creates return statement", () => {
      const result = conjure.stmt.return(conjure.id("value").build())
      expect(printStmt(result)).toBe("return value;")
    })

    it("creates empty return statement", () => {
      const result = conjure.stmt.return()
      expect(printStmt(result)).toBe("return;")
    })

    it("creates expression statement", () => {
      const result = conjure.stmt.expr(
        conjure.id("console").method("log", [conjure.str("hello")]).build()
      )
      expect(printStmt(result)).toBe('console.log("hello");')
    })

    it("creates if statement", () => {
      const result = conjure.stmt.if(
        conjure.id("condition").build(),
        [conjure.stmt.return(conjure.bool(true))]
      )
      expect(printStmt(result)).toContain("if (condition)")
      expect(printStmt(result)).toContain("return true")
    })

    it("creates if-else statement", () => {
      const result = conjure.stmt.if(
        conjure.id("condition").build(),
        [conjure.stmt.return(conjure.bool(true))],
        [conjure.stmt.return(conjure.bool(false))]
      )
      expect(printStmt(result)).toContain("if (condition)")
      expect(printStmt(result)).toContain("else")
      expect(printStmt(result)).toContain("return false")
    })

    it("creates throw statement", () => {
      const result = conjure.stmt.throw(
        conjure.op.new(conjure.id("Error").build(), [conjure.str("oops")])
      )
      expect(printStmt(result)).toBe('throw new Error("oops");')
    })

    it("creates try-catch statement", () => {
      const result = conjure.stmt.try(
        [conjure.stmt.expr(conjure.id("riskyOp").call().build())],
        "err",
        [
          conjure.stmt.expr(
            conjure.id("console").method("error", [conjure.id("err").build()]).build()
          ),
        ]
      )
      expect(printStmt(result)).toContain("try")
      expect(printStmt(result)).toContain("catch (err)")
      expect(printStmt(result)).toContain("console.error(err)")
    })

    it("creates try-catch-finally statement", () => {
      const result = conjure.stmt.try(
        [conjure.stmt.expr(conjure.id("open").call().build())],
        "err",
        [conjure.stmt.expr(conjure.id("log").call([conjure.id("err").build()]).build())],
        [conjure.stmt.expr(conjure.id("close").call().build())]
      )
      expect(printStmt(result)).toContain("finally")
      expect(printStmt(result)).toContain("close()")
    })

    it("creates for-of statement", () => {
      const result = conjure.stmt.forOf(
        "const",
        "item",
        conjure.id("items").build(),
        [
          conjure.stmt.expr(
            conjure.id("process").call([conjure.id("item").build()]).build()
          ),
        ]
      )
      expect(printStmt(result)).toContain("for (const item of items)")
      expect(printStmt(result)).toContain("process(item)")
    })

    it("creates block statement", () => {
      const result = conjure.stmt.block(
        conjure.stmt.const("x", conjure.num(1)),
        conjure.stmt.const("y", conjure.num(2))
      )
      expect(printStmt(result)).toContain("const x = 1")
      expect(printStmt(result)).toContain("const y = 2")
    })
  })

  describe("TypeScript types", () => {
    describe("keyword types", () => {
      it("creates string type", () => {
        const result = conjure.stmt.let("x", undefined, conjure.ts.string())
        expect(printStmt(result)).toBe("let x: string;")
      })

      it("creates number type", () => {
        const result = conjure.stmt.let("x", undefined, conjure.ts.number())
        expect(printStmt(result)).toBe("let x: number;")
      })

      it("creates boolean type", () => {
        const result = conjure.stmt.let("x", undefined, conjure.ts.boolean())
        expect(printStmt(result)).toBe("let x: boolean;")
      })

      it("creates bigint type", () => {
        const result = conjure.stmt.let("x", undefined, conjure.ts.bigint())
        expect(printStmt(result)).toBe("let x: bigint;")
      })

      it("creates any type", () => {
        const result = conjure.stmt.let("x", undefined, conjure.ts.any())
        expect(printStmt(result)).toBe("let x: any;")
      })

      it("creates unknown type", () => {
        const result = conjure.stmt.let("x", undefined, conjure.ts.unknown())
        expect(printStmt(result)).toBe("let x: unknown;")
      })

      it("creates never type", () => {
        const result = conjure.stmt.let("x", undefined, conjure.ts.never())
        expect(printStmt(result)).toBe("let x: never;")
      })

      it("creates void type", () => {
        const result = conjure.stmt.let("x", undefined, conjure.ts.void())
        expect(printStmt(result)).toBe("let x: void;")
      })

      it("creates null type", () => {
        const result = conjure.stmt.let("x", undefined, conjure.ts.null())
        expect(printStmt(result)).toBe("let x: null;")
      })

      it("creates undefined type", () => {
        const result = conjure.stmt.let("x", undefined, conjure.ts.undefined())
        expect(printStmt(result)).toBe("let x: undefined;")
      })
    })

    describe("reference types", () => {
      it("creates simple type reference", () => {
        const result = conjure.stmt.let("x", undefined, conjure.ts.ref("User"))
        expect(printStmt(result)).toBe("let x: User;")
      })

      it("creates generic type reference", () => {
        const result = conjure.stmt.let(
          "x",
          undefined,
          conjure.ts.ref("Promise", [conjure.ts.string()])
        )
        expect(printStmt(result)).toBe("let x: Promise<string>;")
      })

      it("creates nested generic type reference", () => {
        const result = conjure.stmt.let(
          "x",
          undefined,
          conjure.ts.ref("Map", [
            conjure.ts.string(),
            conjure.ts.ref("Array", [conjure.ts.number()]),
          ])
        )
        expect(printStmt(result)).toBe("let x: Map<string, Array<number>>;")
      })

      it("creates qualified type reference", () => {
        const result = conjure.stmt.let(
          "x",
          undefined,
          conjure.ts.qualifiedRef("React", "FC", [conjure.ts.ref("Props")])
        )
        expect(printStmt(result)).toBe("let x: React.FC<Props>;")
      })
    })

    describe("composite types", () => {
      it("creates array type", () => {
        const result = conjure.stmt.let(
          "x",
          undefined,
          conjure.ts.array(conjure.ts.string())
        )
        expect(printStmt(result)).toBe("let x: string[];")
      })

      it("creates union type", () => {
        const result = conjure.stmt.let(
          "x",
          undefined,
          conjure.ts.union(conjure.ts.string(), conjure.ts.number())
        )
        expect(printStmt(result)).toBe("let x: string | number;")
      })

      it("creates intersection type", () => {
        const result = conjure.stmt.let(
          "x",
          undefined,
          conjure.ts.intersection(conjure.ts.ref("A"), conjure.ts.ref("B"))
        )
        expect(printStmt(result)).toBe("let x: A & B;")
      })

      it("creates tuple type", () => {
        const result = conjure.stmt.let(
          "x",
          undefined,
          conjure.ts.tuple(conjure.ts.string(), conjure.ts.number())
        )
        expect(printStmt(result)).toBe("let x: [string, number];")
      })

      it("creates literal types", () => {
        expect(
          printStmt(
            conjure.stmt.let("x", undefined, conjure.ts.literal("hello"))
          )
        ).toBe('let x: "hello";')
        expect(
          printStmt(conjure.stmt.let("x", undefined, conjure.ts.literal(42)))
        ).toBe("let x: 42;")
        expect(
          printStmt(conjure.stmt.let("x", undefined, conjure.ts.literal(true)))
        ).toBe("let x: true;")
      })
    })

    describe("function types", () => {
      it("creates simple function type", () => {
        const result = conjure.stmt.let(
          "x",
          undefined,
          conjure.ts.fn(
            [{ name: "a", type: conjure.ts.string() }],
            conjure.ts.number()
          )
        )
        expect(printStmt(result)).toBe("let x: (a: string) => number;")
      })

      it("creates function type with optional params", () => {
        const result = conjure.stmt.let(
          "x",
          undefined,
          conjure.ts.fn(
            [
              { name: "a", type: conjure.ts.string() },
              { name: "b", type: conjure.ts.number(), optional: true },
            ],
            conjure.ts.void()
          )
        )
        expect(printStmt(result)).toBe("let x: (a: string, b?: number) => void;")
      })
    })

    describe("type operators", () => {
      it("creates typeof type", () => {
        const result = conjure.stmt.let(
          "x",
          undefined,
          conjure.ts.typeof("config")
        )
        expect(printStmt(result)).toBe("let x: typeof config;")
      })

      it("creates keyof type", () => {
        const result = conjure.stmt.let(
          "x",
          undefined,
          conjure.ts.keyof(conjure.ts.ref("User"))
        )
        expect(printStmt(result)).toBe("let x: keyof User;")
      })

      it("creates readonly type", () => {
        const result = conjure.stmt.let(
          "x",
          undefined,
          conjure.ts.readonly(conjure.ts.array(conjure.ts.string()))
        )
        expect(printStmt(result)).toBe("let x: readonly string[];")
      })
    })
  })

  describe("helpers", () => {
    it("creates await expression", () => {
      const result = conjure.await(conjure.id("promise").build())
      expect(printExpr(result)).toBe("await promise;")
    })

    it("creates spread element", () => {
      const arr = conjure
        .arr(conjure.num(1))
        .add(conjure.spread(conjure.id("rest").build()) as any)
        .build()
      expect(printExpr(arr)).toBe("[1, ...rest];")
    })

    it("creates program", () => {
      const program = conjure.program(
        conjure.stmt.const("x", conjure.num(1)),
        conjure.stmt.const("y", conjure.num(2))
      )
      const code = conjure.print(program)
      expect(code).toContain("const x = 1")
      expect(code).toContain("const y = 2")
    })

    it("exposes raw builders", () => {
      // Verify we can access raw recast builders
      expect(conjure.b).toBeDefined()
      expect(conjure.b.identifier).toBeDefined()
      expect(conjure.b.stringLiteral).toBeDefined()
    })
  })

  describe("cast helpers", () => {
    it("exports cast helpers for raw recast interop", () => {
      expect(cast.asExpr).toBeDefined()
      expect(cast.asMemberObj).toBeDefined()
      expect(cast.asArrayElem).toBeDefined()
      expect(cast.asPropValue).toBeDefined()
      expect(cast.asStatement).toBeDefined()
      expect(cast.asTSType).toBeDefined()
    })
  })

  describe("real-world patterns", () => {
    it("generates Zod schema", () => {
      const schema = conjure
        .id("z")
        .method("object", [
          conjure
            .obj()
            .prop("id", conjure.id("z").method("string").method("uuid").build())
            .prop("email", conjure.id("z").method("string").method("email").build())
            .prop("age", conjure.id("z").method("number").method("min", [conjure.num(0)]).build())
            .build(),
        ])
        .build()

      const code = printExpr(schema)
      expect(code).toContain("z.object")
      expect(code).toContain("id: z.string().uuid()")
      expect(code).toContain("email: z.string().email()")
      expect(code).toContain("age: z.number().min(0)")
    })

    it("generates Express route handler", () => {
      const handler = conjure
        .fn()
        .async()
        .arrow()
        .param("req", conjure.ts.ref("Request"))
        .param("res", conjure.ts.ref("Response"))
        .body(
          conjure.stmt.const(
            "users",
            conjure.await(conjure.id("db").method("getUsers").build())
          ),
          conjure.stmt.return(
            conjure.id("res").method("json", [conjure.id("users").build()]).build()
          )
        )
        .build()

      const route = conjure
        .id("router")
        .method("get", [conjure.str("/users"), handler])
        .build()

      const code = printExpr(route)
      expect(code).toContain('router.get("/users"')
      expect(code).toContain("async (req: Request, res: Response)")
      expect(code).toContain("await db.getUsers()")
      expect(code).toContain("res.json(users)")
    })

    it("generates TypeScript interface-like pattern", () => {
      // While we can't directly create interfaces, we can create
      // the equivalent type patterns
      const userType = conjure.ts.ref("User")
      const arrayOfUsers = conjure.ts.array(userType)
      const promiseOfUsers = conjure.ts.ref("Promise", [arrayOfUsers])
      const nullableUser = conjure.ts.union(userType, conjure.ts.null())

      const fnDecl = conjure
        .fn()
        .async()
        .param("id", conjure.ts.string())
        .returns(promiseOfUsers)
        .body(
          conjure.stmt.return(
            conjure.id("api").method("fetchUsers", [conjure.id("id").build()]).build()
          )
        )
        .toDeclaration("getUsers")

      const code = printStmt(fnDecl)
      expect(code).toContain("async function getUsers(id: string): Promise<User[]>")
    })

    it("generates complex conditional logic", () => {
      const validation = conjure.stmt.if(
        conjure.op.and(
          conjure.op.neq(conjure.id("user").build(), conjure.null()),
          conjure.op.binary(
            conjure.id("user").prop("age").build(),
            ">=",
            conjure.num(18)
          )
        ),
        [
          conjure.stmt.expr(
            conjure.id("grantAccess").call([conjure.id("user").build()]).build()
          ),
        ],
        [
          conjure.stmt.throw(
            conjure.op.new(conjure.id("Error").build(), [
              conjure.str("Access denied"),
            ])
          ),
        ]
      )

      const code = printStmt(validation)
      expect(code).toContain("user !== null && user.age >= 18")
      expect(code).toContain("grantAccess(user)")
      expect(code).toContain('throw new Error("Access denied")')
    })
  })

  describe("export helpers (exp.*)", () => {
    it("creates exported interface with symbol metadata", () => {
      const iface = conjure.exp.interface(
        "UserRow",
        { capability: "types", entity: "User", shape: "row" },
        [
          { name: "id", type: conjure.ts.string() },
          { name: "email", type: conjure.ts.string() },
          { name: "age", type: conjure.ts.number(), optional: true },
        ]
      )

      expect(iface._tag).toBe("SymbolStatement")
      expect(iface.symbol).toEqual({
        name: "UserRow",
        capability: "types",
        entity: "User",
        shape: "row",
        isType: true,
      })

      const code = printStmt(iface.node)
      expect(code).toContain("export interface UserRow")
      expect(code).toContain("id: string")
      expect(code).toContain("email: string")
      expect(code).toContain("age?: number")
    })

    it("creates exported type alias with symbol metadata", () => {
      const alias = conjure.exp.typeAlias(
        "Role",
        { capability: "types", entity: "Role" },
        conjure.ts.union(
          conjure.ts.literal("admin"),
          conjure.ts.literal("user"),
          conjure.ts.literal("guest")
        )
      )

      expect(alias._tag).toBe("SymbolStatement")
      expect(alias.symbol).toEqual({
        name: "Role",
        capability: "types",
        entity: "Role",
        isType: true,
      })

      const code = printStmt(alias.node)
      expect(code).toContain("export type Role")
      expect(code).toContain('"admin"')
      expect(code).toContain('"user"')
      expect(code).toContain('"guest"')
    })

    it("creates exported const with symbol metadata", () => {
      const schema = conjure.exp.const(
        "UserSchema",
        { capability: "schemas:zod", entity: "User", shape: "row" },
        conjure.id("z").method("object", [conjure.obj().build()]).build()
      )

      expect(schema._tag).toBe("SymbolStatement")
      expect(schema.symbol).toEqual({
        name: "UserSchema",
        capability: "schemas:zod",
        entity: "User",
        shape: "row",
        isType: false,
      })

      const code = printStmt(schema.node)
      expect(code).toContain("export const UserSchema = z.object")
    })

    it("creates exported const with type annotation", () => {
      const schema = conjure.exp.const(
        "config",
        { capability: "config", entity: "Config" },
        conjure.obj().prop("debug", conjure.bool(true)).build(),
        conjure.ts.ref("AppConfig")
      )

      const code = printStmt(schema.node)
      expect(code).toContain("export const config: AppConfig")
    })

    it("creates exported type for inferred types", () => {
      const inferredType = conjure.exp.type(
        "User",
        { capability: "schemas:zod", entity: "User", shape: "row" },
        conjure.ts.typeof("UserSchema")
      )

      expect(inferredType._tag).toBe("SymbolStatement")
      expect(inferredType.symbol.isType).toBe(true)

      const code = printStmt(inferredType.node)
      expect(code).toContain("export type User = typeof UserSchema")
    })
  })

  describe("symbolProgram", () => {
    it("extracts symbols from SymbolStatements", () => {
      const prog = conjure.symbolProgram(
        conjure.exp.interface(
          "UserRow",
          { capability: "types", entity: "User", shape: "row" },
          [{ name: "id", type: conjure.ts.string() }]
        ),
        conjure.exp.typeAlias(
          "Role",
          { capability: "types", entity: "Role" },
          conjure.ts.literal("admin")
        )
      )

      expect(prog._tag).toBe("SymbolProgram")
      expect(prog.symbols).toHaveLength(2)
      expect(prog.symbols[0]).toEqual({
        name: "UserRow",
        capability: "types",
        entity: "User",
        shape: "row",
        isType: true,
      })
      expect(prog.symbols[1]).toEqual({
        name: "Role",
        capability: "types",
        entity: "Role",
        isType: true,
      })
    })

    it("handles mix of regular statements and SymbolStatements", () => {
      const prog = conjure.symbolProgram(
        conjure.stmt.const("x", conjure.num(1)),
        conjure.exp.interface(
          "UserRow",
          { capability: "types", entity: "User" },
          []
        ),
        conjure.stmt.const("y", conjure.num(2))
      )

      expect(prog._tag).toBe("SymbolProgram")
      expect(prog.symbols).toHaveLength(1)
      expect(prog.symbols[0]!.name).toBe("UserRow")

      const code = conjure.print(prog.node)
      expect(code).toContain("const x = 1")
      expect(code).toContain("export interface UserRow")
      expect(code).toContain("const y = 2")
    })

    it("preserves statement order in generated code", () => {
      const prog = conjure.symbolProgram(
        conjure.exp.typeAlias(
          "First",
          { capability: "types", entity: "First" },
          conjure.ts.string()
        ),
        conjure.exp.typeAlias(
          "Second",
          { capability: "types", entity: "Second" },
          conjure.ts.number()
        )
      )

      const code = conjure.print(prog.node)
      const firstIdx = code.indexOf("First")
      const secondIdx = code.indexOf("Second")
      expect(firstIdx).toBeLessThan(secondIdx)
    })
  })
})
