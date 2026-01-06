/**
 * File Writer Tests
 *
 * Tests for writing emissions to disk using real filesystem operations.
 */
import { it, describe, expect } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { FileSystem, Path } from "@effect/platform"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import {
  createFileWriter,
  defaultHeader,
} from "../services/file-writer.js"
import type { EmissionEntry } from "../services/emissions.js"

// Provide real Node.js filesystem and path services
const TestLayer = Layer.merge(NodeFileSystem.layer, NodePath.layer)

describe("FileWriter", () => {
  describe("writeAll", () => {
    it.effect("writes files to disk with header", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const pathSvc = yield* Path.Path
        const writer = createFileWriter()

        // Create a temp directory for our test
        const tmpDir = yield* fs.makeTempDirectory({ prefix: "file-writer-test-" })

        const emissions: EmissionEntry[] = [
          { path: "types.ts", content: "export type Foo = string;", plugin: "test" },
        ]

        try {
          const results = yield* writer.writeAll(emissions, { outputDir: tmpDir })

          expect(results).toHaveLength(1)
          expect(results[0]?.written).toBe(true)
          expect(results[0]?.path).toBe(pathSvc.join(tmpDir, "types.ts"))

          // Verify file was actually written
          const content = yield* fs.readFileString(pathSvc.join(tmpDir, "types.ts"))
          expect(content).toContain("AUTO-GENERATED FILE")
          expect(content).toContain("export type Foo = string;")
        } finally {
          // Clean up
          yield* fs.remove(tmpDir, { recursive: true })
        }
      }).pipe(Effect.provide(TestLayer))
    )

    it.effect("creates nested directories as needed", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const pathSvc = yield* Path.Path
        const writer = createFileWriter()

        const tmpDir = yield* fs.makeTempDirectory({ prefix: "file-writer-test-" })

        const emissions: EmissionEntry[] = [
          { path: "deep/nested/dir/file.ts", content: "// nested", plugin: "test" },
        ]

        try {
          const results = yield* writer.writeAll(emissions, { outputDir: tmpDir })

          expect(results).toHaveLength(1)
          expect(results[0]?.written).toBe(true)

          // Verify nested file exists
          const exists = yield* fs.exists(pathSvc.join(tmpDir, "deep/nested/dir/file.ts"))
          expect(exists).toBe(true)
        } finally {
          yield* fs.remove(tmpDir, { recursive: true })
        }
      }).pipe(Effect.provide(TestLayer))
    )

    it.effect("writes multiple files from different plugins", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const pathSvc = yield* Path.Path
        const writer = createFileWriter()

        const tmpDir = yield* fs.makeTempDirectory({ prefix: "file-writer-test-" })

        const emissions: EmissionEntry[] = [
          { path: "types.ts", content: "export type A = 1;", plugin: "types-plugin" },
          { path: "schemas.ts", content: "export const schema = {};", plugin: "schemas-plugin" },
          { path: "queries/select.ts", content: "export const select = () => {};", plugin: "queries-plugin" },
        ]

        try {
          const results = yield* writer.writeAll(emissions, { outputDir: tmpDir })

          expect(results).toHaveLength(3)
          expect(results.every((r) => r.written)).toBe(true)

          // Verify all files exist
          const typesExists = yield* fs.exists(pathSvc.join(tmpDir, "types.ts"))
          const schemasExists = yield* fs.exists(pathSvc.join(tmpDir, "schemas.ts"))
          const queriesExists = yield* fs.exists(pathSvc.join(tmpDir, "queries/select.ts"))

          expect(typesExists).toBe(true)
          expect(schemasExists).toBe(true)
          expect(queriesExists).toBe(true)
        } finally {
          yield* fs.remove(tmpDir, { recursive: true })
        }
      }).pipe(Effect.provide(TestLayer))
    )

    it.effect("dry-run mode returns paths without writing", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const pathSvc = yield* Path.Path
        const writer = createFileWriter()

        const tmpDir = yield* fs.makeTempDirectory({ prefix: "file-writer-test-" })

        const emissions: EmissionEntry[] = [
          { path: "should-not-exist.ts", content: "// nope", plugin: "test" },
        ]

        try {
          const results = yield* writer.writeAll(emissions, {
            outputDir: tmpDir,
            dryRun: true,
          })

          expect(results).toHaveLength(1)
          expect(results[0]?.written).toBe(false)
          expect(results[0]?.reason).toBe("dry-run")
          expect(results[0]?.path).toBe(pathSvc.join(tmpDir, "should-not-exist.ts"))

          // Verify file was NOT written
          const exists = yield* fs.exists(pathSvc.join(tmpDir, "should-not-exist.ts"))
          expect(exists).toBe(false)
        } finally {
          yield* fs.remove(tmpDir, { recursive: true })
        }
      }).pipe(Effect.provide(TestLayer))
    )

    it.effect("uses custom header when provided", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const pathSvc = yield* Path.Path
        const writer = createFileWriter()

        const tmpDir = yield* fs.makeTempDirectory({ prefix: "file-writer-test-" })
        const customHeader = "/* Custom Header */\n\n"

        const emissions: EmissionEntry[] = [
          { path: "custom.ts", content: "export const x = 1;", plugin: "test" },
        ]

        try {
          yield* writer.writeAll(emissions, {
            outputDir: tmpDir,
            header: customHeader,
          })

          const content = yield* fs.readFileString(pathSvc.join(tmpDir, "custom.ts"))
          expect(content).toBe("/* Custom Header */\n\nexport const x = 1;")
        } finally {
          yield* fs.remove(tmpDir, { recursive: true })
        }
      }).pipe(Effect.provide(TestLayer))
    )

    it.effect("handles empty emissions list", () =>
      Effect.gen(function* () {
        const writer = createFileWriter()

        const results = yield* writer.writeAll([], { outputDir: "/tmp/empty" })

        expect(results).toHaveLength(0)
      }).pipe(Effect.provide(TestLayer))
    )

    it.effect("overwrites existing files", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const pathSvc = yield* Path.Path
        const writer = createFileWriter()

        const tmpDir = yield* fs.makeTempDirectory({ prefix: "file-writer-test-" })
        const filePath = pathSvc.join(tmpDir, "overwrite.ts")

        try {
          // Write initial file
          yield* fs.writeFileString(filePath, "// original content")

          // Overwrite with emission
          const emissions: EmissionEntry[] = [
            { path: "overwrite.ts", content: "// new content", plugin: "test" },
          ]

          yield* writer.writeAll(emissions, {
            outputDir: tmpDir,
            header: "", // No header for simpler assertion
          })

          const content = yield* fs.readFileString(filePath)
          expect(content).toBe("// new content")
        } finally {
          yield* fs.remove(tmpDir, { recursive: true })
        }
      }).pipe(Effect.provide(TestLayer))
    )
  })

  describe("defaultHeader", () => {
    it("includes timestamp", () => {
      const fixedDate = new Date("2026-01-05T12:00:00Z")
      const header = defaultHeader(fixedDate)

      expect(header).toContain("AUTO-GENERATED FILE")
      expect(header).toContain("DO NOT EDIT")
      expect(header).toContain("2026-01-05T12:00:00.000Z")
    })
  })
})
