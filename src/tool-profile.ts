/**
 * ChatGPT-facing exposure metadata for the DSH tool registry.
 *
 * DSH remains the source of truth for tool schemas and execution. This
 * profile only decides which registered tools are exposed over MCP and which
 * client-facing annotations accompany them.
 *
 * @module
 */

import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'

/** One statically configured ChatGPT-facing tool exposure. */
export interface ToolProfileEntry {
  readonly name: string
  readonly annotations: Readonly<ToolAnnotations>
}

/** Minimal registry shape needed to validate and resolve a profile. */
export interface NamedToolSchema {
  readonly name: string
}

/** A profile entry paired with its authoritative DSH schema. */
export interface ProfiledToolSchema<TSchema extends NamedToolSchema> {
  readonly schema: TSchema
  readonly annotations: Readonly<ToolAnnotations>
}

/**
 * The single static Core Tool Profile exposed to ChatGPT in P2-C2.
 *
 * Annotations are MCP client hints only. DSH continues to enforce filesystem
 * policy, sandboxing, and every runtime side effect.
 */
export const CORE_TOOL_PROFILE = [
  {
    name: 'read',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'write',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'edit',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
] as const satisfies readonly ToolProfileEntry[]

/**
 * Validate the DSH registry and resolve the Core Profile in profile order.
 *
 * Every registry name must be unambiguous, including names not exposed by
 * the profile. Every Core Profile entry must exist. Additional unique DSH
 * tools remain unexposed.
 */
export function resolveCoreToolProfile<TSchema extends NamedToolSchema>(
  schemas: readonly TSchema[],
): readonly ProfiledToolSchema<TSchema>[] {
  const schemasByName = new Map<string, TSchema>()
  const duplicateNames = new Set<string>()

  for (const schema of schemas) {
    if (schemasByName.has(schema.name)) duplicateNames.add(schema.name)
    else schemasByName.set(schema.name, schema)
  }

  if (duplicateNames.size > 0) {
    throw new Error(`duplicate DSH tool names: ${[...duplicateNames].sort().join(', ')}`)
  }

  const missingNames = CORE_TOOL_PROFILE
    .filter(entry => !schemasByName.has(entry.name))
    .map(entry => entry.name)
  if (missingNames.length > 0) {
    throw new Error(`missing required DSH tools: ${missingNames.join(', ')}`)
  }

  return CORE_TOOL_PROFILE.map(entry => ({
    schema: schemasByName.get(entry.name) as TSchema,
    annotations: entry.annotations,
  }))
}
