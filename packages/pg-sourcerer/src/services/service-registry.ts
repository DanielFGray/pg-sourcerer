/**
 * Service Registry
 *
 * Runtime service registration for plugin-to-plugin communication.
 * Plugins register services during their provide() phase, and other
 * plugins can access them via ctx.services.get().
 *
 * This enables on-demand requests between plugins without coupling
 * them to specific implementations.
 *
 * @example
 * ```typescript
 * // Provider plugin (e.g., zod)
 * ctx.services.register("schema-builder", {
 *   buildParamSchema: (params) => // ... generate AST
 * })
 *
 * // Consumer plugin (e.g., http-elysia)
 * const builder = ctx.services.get<SchemaBuilder>("schema-builder")
 * if (builder) {
 *   const ast = builder.buildParamSchema(params)
 * }
 * ```
 */
import { Context, Layer } from "effect"

// ============================================================================
// Service Registry Interface
// ============================================================================

/**
 * Runtime service registry for plugin communication.
 */
export interface ServiceRegistry {
  /**
   * Register a service by kind.
   * Later registrations for the same kind overwrite earlier ones.
   *
   * @param kind - Service identifier (e.g., "schema-builder")
   * @param service - The service implementation
   */
  readonly register: <S>(kind: string, service: S) => void

  /**
   * Get a registered service by kind.
   * Returns undefined if no service is registered for the kind.
   *
   * @param kind - Service identifier
   * @returns The service or undefined
   */
  readonly get: <S>(kind: string) => S | undefined

  /**
   * Check if a service is registered.
   *
   * @param kind - Service identifier
   * @returns true if registered
   */
  readonly has: (kind: string) => boolean

  /**
   * List all registered service kinds.
   * Useful for debugging.
   */
  readonly kinds: () => readonly string[]
}

// ============================================================================
// Service Tag
// ============================================================================

/**
 * Effect service tag for ServiceRegistry.
 */
export class Services extends Context.Tag("Services")<Services, ServiceRegistry>() {}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Create a new service registry.
 */
export function createServiceRegistry(): ServiceRegistry {
  const services = new Map<string, unknown>()

  return {
    register: <S>(kind: string, service: S) => {
      services.set(kind, service)
    },

    get: <S>(kind: string) => {
      return services.get(kind) as S | undefined
    },

    has: (kind: string) => {
      return services.has(kind)
    },

    kinds: () => {
      return [...services.keys()]
    },
  }
}

/**
 * Live layer - creates fresh service registry.
 */
export const ServicesLive = Layer.sync(Services, () => createServiceRegistry())
