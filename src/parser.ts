import {JSONSchema4Type, JSONSchema4TypeName} from 'json-schema'
import {findKey, includes, isPlainObject, map, memoize, omit} from 'lodash'
import {format} from 'util'
import {Options} from './'
import {applySchemaTyping} from './applySchemaTyping'
import type {
  AST,
  TInterface,
  TInterfaceParam,
  TIntersection,
  TNamedInterface,
  TTypeAlias,
  TTuple,
  TUnion,
} from './types/AST'
import {T_ANY, T_ANY_ADDITIONAL_PROPERTIES, T_UNKNOWN, T_UNKNOWN_ADDITIONAL_PROPERTIES} from './types/AST'
import type {
  EnumJSONSchema,
  JSONSchemaWithDefinitions,
  LinkedJSONSchema,
  NormalizedJSONSchema,
  SchemaSchema,
  SchemaType,
} from './types/JSONSchema'
import {Intersection, Types, getRootSchema, isBoolean, isPrimitive} from './types/JSONSchema'
import {generateName, log, maybeStripDefault, toSafeString, traverse} from './utils'

export type Processed = Map<NormalizedJSONSchema, Map<SchemaType, AST>>

export type UsedNames = Set<string>

/**
 * Context for $dynamicAnchor - tracks what types are allowed in this context
 */
export interface AnchorContext {
  anchorName: string
  allowedTypeNames: string[]
}

/**
 * Context for parsing with $dynamicRef support
 */
export interface ParseContext {
  genericInterfaces: Map<string, string>
  // The current standalone interface being parsed (if any)
  currentInterfaceName?: string
  // Collection of all generic interface ASTs that need to be declared
  genericInterfaceASTs: Map<string, TInterface>
  // Collection of recursive type aliases that need to be declared
  typeAliases: Map<string, TTypeAlias>
}

export interface ParseResult {
  ast: AST
  parseContext: ParseContext
}

/**
 * Pre-scan the schema to identify all interfaces that need type parameters
 */
function identifyGenericInterfaces(rootSchema: NormalizedJSONSchema, parseContext: ParseContext): void {
  // Find all $dynamicRefs and the anchors they reference
  const dynamicRefs = new Set<string>()

  traverse(rootSchema, (s: LinkedJSONSchema) => {
    const normalized = s as NormalizedJSONSchema
    if (normalized.$dynamicRef) {
      const anchorName = normalized.$dynamicRef.replace(/^#/, '')
      dynamicRefs.add(anchorName)
    }
  })

  // Process dynamic refs if they exist
  if (dynamicRefs.size > 0) {
    // For each unique anchor name, find interfaces that contain $dynamicRef to that anchor
    for (const anchorName of dynamicRefs) {
      const typeParamName = 'T' + anchorName.charAt(0).toUpperCase() + anchorName.slice(1)

      // Find all interfaces that contain this $dynamicRef
      traverse(rootSchema, (s: LinkedJSONSchema) => {
        const normalized = s as NormalizedJSONSchema
        if (normalized.$id && schemaNeedsTypeParameter(normalized)) {
          const interfaceName = toSafeString(normalized.$id)
          if (!parseContext.genericInterfaces.has(interfaceName)) {
            parseContext.genericInterfaces.set(interfaceName, typeParamName)
            log(
              'blue',
              'parser',
              `Pre-identified generic interface ${interfaceName} with type parameter ${typeParamName}`,
            )
          }
        }
      })
    }
  }

  // Also identify interfaces with empty items schemas (allOf pattern)
  traverse(rootSchema, (s: LinkedJSONSchema) => {
    const normalized = s as NormalizedJSONSchema
    if (normalized.$id && hasEmptyItemsSchema(normalized)) {
      const interfaceName = toSafeString(normalized.$id)
      if (!parseContext.genericInterfaces.has(interfaceName)) {
        const typeParamName = 'T'
        parseContext.genericInterfaces.set(interfaceName, typeParamName)
        log(
          'blue',
          'parser',
          `Pre-identified generic interface ${interfaceName} (empty items) with type parameter ${typeParamName}`,
        )
      }
    }
  })
}

/**
 * Check if a schema directly contains a $dynamicRef in its properties
 * OR has empty items schema (items: {}) which should be generic
 * (not in nested schemas)
 */
function schemaNeedsTypeParameter(schema: NormalizedJSONSchema): boolean {
  // Check if any direct property contains $dynamicRef or empty items
  if (schema.properties) {
    for (const prop of Object.values(schema.properties)) {
      if (prop && typeof prop === 'object') {
        // Check if the property itself has $dynamicRef
        if ((prop as NormalizedJSONSchema).$dynamicRef) {
          return true
        }
        // Check if the property is an array with items containing $dynamicRef
        if ((prop as NormalizedJSONSchema).items) {
          const items = (prop as NormalizedJSONSchema).items
          if (!Array.isArray(items) && items && typeof items === 'object') {
            if ((items as NormalizedJSONSchema).$dynamicRef) {
              return true
            }
            // Check for empty items schema: items: {}
            // This means the array item type should be generic
            if (
              Object.keys(items).length === 0 ||
              (Object.keys(items).length === 1 && 'type' in items && !items.type)
            ) {
              return true
            }
          }
        }
      }
    }
  }
  return false
}

/**
 * Check if a schema has properties with empty items schemas (items: {})
 * This indicates the type should be generic
 */
function hasEmptyItemsSchema(schema: NormalizedJSONSchema): boolean {
  if (schema.properties) {
    for (const prop of Object.values(schema.properties)) {
      if (prop && typeof prop === 'object') {
        const propSchema = prop as NormalizedJSONSchema
        // Check if it's an array with empty items
        if (propSchema.type === 'array' && propSchema.items) {
          const items = propSchema.items
          if (!Array.isArray(items) && typeof items === 'object') {
            // Empty schema: {} or {type: undefined}
            if (
              Object.keys(items).length === 0 ||
              (Object.keys(items).length === 1 && 'type' in items && !items.type)
            ) {
              return true
            }
          }
        }
      }
    }
  }
  return false
}

/**
 * Extract type argument from allOf override member
 * Looks for properties.X.items.items.oneOf or similar patterns
 */
function extractTypeArgumentFromOverride(
  overrideMember: any,
  options: Options,
  processed: Processed,
  usedNames: UsedNames,
  parseContext?: ParseContext,
): AST | null {
  if (!overrideMember.properties) {
    return null
  }

  // Find the first array property with concrete items
  for (const prop of Object.values(overrideMember.properties)) {
    if (prop && typeof prop === 'object') {
      const propSchema = prop as NormalizedJSONSchema
      // Look for array with items
      if (propSchema.type === 'array' && propSchema.items) {
        const items = propSchema.items
        if (!Array.isArray(items) && typeof items === 'object') {
          // Check if items has concrete type (oneOf, anyOf, type, $ref)
          if ((items as NormalizedJSONSchema).oneOf || (items as NormalizedJSONSchema).anyOf) {
            // Parse this as the type argument
            return parse(
              items as NormalizedJSONSchema,
              options,
              undefined,
              processed,
              usedNames,
              undefined,
              parseContext,
            )
          }
          if ((items as NormalizedJSONSchema).type || (items as NormalizedJSONSchema).$ref) {
            return parse(
              items as NormalizedJSONSchema,
              options,
              undefined,
              processed,
              usedNames,
              undefined,
              parseContext,
            )
          }
        }
      }
    }
  }

  return null
}

/**
 * Find the $dynamicRef anchor name in a schema
 */
function getDynamicRefAnchorName(schema: NormalizedJSONSchema): string | null {
  let anchorName: string | null = null

  function checkSchema(s: LinkedJSONSchema) {
    const normalized = s as NormalizedJSONSchema
    if (normalized.$dynamicRef) {
      anchorName = normalized.$dynamicRef.replace(/^#/, '')
    }
  }

  traverse(schema, checkSchema)
  return anchorName
}

/**
 * Get the default type for a $dynamicRef by finding all matching $dynamicAnchors
 */
function getDefaultTypeForDynamicRef(rootSchema: NormalizedJSONSchema, anchorName: string, options: Options): AST {
  const matchingSchemas: NormalizedJSONSchema[] = []

  function findMatchingAnchors(s: LinkedJSONSchema) {
    const normalized = s as NormalizedJSONSchema
    if (normalized.$dynamicAnchor === anchorName) {
      matchingSchemas.push(normalized)
    }
  }

  traverse(rootSchema, findMatchingAnchors)

  log('blue', 'parser', `Found ${matchingSchemas.length} matching anchors for '${anchorName}'`)

  if (matchingSchemas.length === 0) {
    // No matching anchors found
    log('blue', 'parser', `No anchors found, returning ${options.unknownAny ? 'unknown' : 'any'}`)
    return options.unknownAny ? T_UNKNOWN : T_ANY
  }

  // The anchor schemas typically have oneOf/anyOf with the actual types
  // We need to extract those types
  const allTypes: AST[] = []

  for (const anchorSchema of matchingSchemas) {
    if (anchorSchema.oneOf) {
      // Parse each oneOf member to get the actual type references
      for (const member of anchorSchema.oneOf) {
        const definitions = getDefinitionsMemoized(getRootSchema(member))
        const keyName = findKey(definitions, _ => _ === member)
        if (keyName) {
          allTypes.push({
            params: toSafeString(keyName),
            type: 'REFERENCE' as const,
          })
          log('blue', 'parser', `Adding type ${keyName} to default type for ${anchorName}`)
        }
      }
    } else if (anchorSchema.anyOf) {
      for (const member of anchorSchema.anyOf) {
        const definitions = getDefinitionsMemoized(getRootSchema(member))
        const keyName = findKey(definitions, _ => _ === member)
        if (keyName) {
          allTypes.push({
            params: toSafeString(keyName),
            type: 'REFERENCE' as const,
          })
        }
      }
    }
  }

  if (allTypes.length === 0) {
    log('blue', 'parser', `No types extracted from anchors, returning ${options.unknownAny ? 'unknown' : 'any'}`)
    return options.unknownAny ? T_UNKNOWN : T_ANY
  }

  // Deduplicate types by their params (type name)
  const uniqueTypes = Array.from(new Map(allTypes.map(t => [(t as any).params, t])).values())

  if (uniqueTypes.length === 1) {
    return uniqueTypes[0]
  }

  return {
    params: uniqueTypes,
    type: 'UNION',
  }
}

/**
 * Parse a JSON Schema into an AST with context information
 * This is the main entry point that returns both AST and parseContext
 */
export function parseWithContext(schema: NormalizedJSONSchema | JSONSchema4Type, options: Options): ParseResult {
  const parseContext: ParseContext = {
    genericInterfaces: new Map<string, string>(),
    genericInterfaceASTs: new Map<string, TInterface>(),
    typeAliases: new Map<string, TTypeAlias>(),
  }

  // Pre-scan the schema to identify all interfaces that need type parameters
  if (!isPrimitive(schema)) {
    identifyGenericInterfaces(getRootSchema(schema as NormalizedJSONSchema), parseContext)
  }

  const ast = parse(schema, options, undefined, new Map(), new Set(), undefined, parseContext)
  return {ast, parseContext}
}

/**
 * Internal parse function (kept for backward compatibility and internal use)
 * @deprecated Use parseWithContext for top-level parsing
 */
export function parse(
  schema: NormalizedJSONSchema | JSONSchema4Type,
  options: Options,
  keyName?: string,
  processed: Processed = new Map(),
  usedNames = new Set<string>(),
  anchorContext?: AnchorContext,
  parseContext?: ParseContext,
): AST {
  // For backward compatibility: if no parseContext provided, create a minimal one
  // This happens when parse() is called directly (legacy usage without $dynamicRef support)
  if (!parseContext) {
    parseContext = {
      genericInterfaces: new Map<string, string>(),
      genericInterfaceASTs: new Map<string, TInterface>(),
      typeAliases: new Map<string, TTypeAlias>(),
    }
    // Don't pre-scan for backward compatibility - just create empty context
  }

  if (isPrimitive(schema)) {
    if (isBoolean(schema)) {
      return parseBooleanSchema(schema, keyName, options)
    }

    return parseLiteral(schema, keyName)
  }

  const intersection = schema[Intersection]
  const types = schema[Types]

  if (intersection) {
    const ast = parseAsTypeWithCache(
      intersection,
      'ALL_OF',
      options,
      keyName,
      processed,
      usedNames,
      anchorContext,
      parseContext,
    ) as TIntersection

    types.forEach(type => {
      ast.params.push(
        parseAsTypeWithCache(schema, type, options, keyName, processed, usedNames, anchorContext, parseContext),
      )
    })

    log('blue', 'parser', 'Types:', [...types], 'Input:', schema, 'Output:', ast)
    return ast
  }

  if (types.size === 1) {
    const type = [...types][0]
    const ast = parseAsTypeWithCache(schema, type, options, keyName, processed, usedNames, anchorContext, parseContext)
    log('blue', 'parser', 'Type:', type, 'Input:', schema, 'Output:', ast)
    return ast
  }

  throw new ReferenceError('Expected intersection schema. Please file an issue on GitHub.')
}

function parseAsTypeWithCache(
  schema: NormalizedJSONSchema,
  type: SchemaType,
  options: Options,
  keyName?: string,
  processed: Processed = new Map(),
  usedNames = new Set<string>(),
  anchorContext?: AnchorContext,
  parseContext?: ParseContext,
): AST {
  // If we've seen this node before, return it.
  let cachedTypeMap = processed.get(schema)
  if (!cachedTypeMap) {
    cachedTypeMap = new Map()
    processed.set(schema, cachedTypeMap)
  }
  const cachedAST = cachedTypeMap.get(type)
  if (cachedAST) {
    return cachedAST
  }

  // Cache processed ASTs before they are actually computed, then update
  // them in place using set(). This is to avoid cycles.
  // TODO: Investigate alternative approaches (lazy-computing nodes, etc.)
  const ast = {} as AST
  cachedTypeMap.set(type, ast)

  // Update the AST in place. This updates the `processed` cache, as well
  // as any nodes that directly reference the node.
  return Object.assign(
    ast,
    parseNonLiteral(schema, type, options, keyName, processed, usedNames, anchorContext, parseContext),
  )
}

function parseBooleanSchema(schema: boolean, keyName: string | undefined, options: Options): AST {
  if (schema) {
    return {
      keyName,
      type: options.unknownAny ? 'UNKNOWN' : 'ANY',
    }
  }

  return {
    keyName,
    type: 'NEVER',
  }
}

function parseLiteral(schema: JSONSchema4Type, keyName: string | undefined): AST {
  return {
    keyName,
    params: schema,
    type: 'LITERAL',
  }
}

function parseNonLiteral(
  schema: NormalizedJSONSchema,
  type: SchemaType,
  options: Options,
  keyName: string | undefined,
  processed: Processed,
  usedNames: UsedNames,
  anchorContext?: AnchorContext,
  parseContext?: ParseContext,
): AST {
  // Check if this schema has a $dynamicAnchor - if so, create anchor context for children
  let newAnchorContext = anchorContext
  if (schema.$dynamicAnchor) {
    const anchorName = schema.$dynamicAnchor
    // Extract the types from oneOf/anyOf or from the schema itself
    const allowedTypeNames: string[] = []

    if (schema.oneOf) {
      for (const member of schema.oneOf) {
        const definitions = getDefinitionsMemoized(getRootSchema(member))
        const keyName = findKey(definitions, _ => _ === member)
        if (keyName) {
          allowedTypeNames.push(toSafeString(keyName))
        }
      }
    } else if (schema.anyOf) {
      for (const member of schema.anyOf) {
        const definitions = getDefinitionsMemoized(getRootSchema(member))
        const keyName = findKey(definitions, _ => _ === member)
        if (keyName) {
          allowedTypeNames.push(toSafeString(keyName))
        }
      }
    } else {
      // No oneOf/anyOf, check if this schema itself has an $id (is a named schema)
      if (schema.$id) {
        allowedTypeNames.push(toSafeString(schema.$id))
      } else {
        // Try to find this schema in definitions
        const definitions = getDefinitionsMemoized(getRootSchema(schema))
        const keyName = findKey(definitions, _ => _ === schema)
        if (keyName) {
          allowedTypeNames.push(toSafeString(keyName))
        }
      }
    }

    newAnchorContext = {
      anchorName,
      allowedTypeNames,
    }
    log('blue', 'parser', `Created anchor context for '${anchorName}' with types: [${allowedTypeNames.join(', ')}]`)
  }
  const definitions = getDefinitionsMemoized(getRootSchema(schema as any)) // TODO
  const keyNameFromDefinition = findKey(definitions, _ => _ === schema)

  switch (type) {
    case 'ALL_OF': {
      // Pattern 1: Check if one of the allOf members has a $dynamicAnchor
      const anchorMember = schema.allOf!.find((member: any) => member.$dynamicAnchor && (member.oneOf || member.anyOf))

      // If we have an anchor member, parse others without the anchor context,
      // then create a generic instantiation
      if (anchorMember && schema.allOf!.length === 2) {
        // Find the non-anchor member (could be $ref or the actual schema)
        const baseMember = schema.allOf!.find((m: any) => m !== anchorMember)

        if (baseMember) {
          // Parse the base member without anchor context to get the base interface
          const baseAST = parse(baseMember, options, undefined, processed, usedNames, undefined, parseContext)

          // Parse the anchor member to get the type union
          const typeArgAST = parse(anchorMember, options, undefined, processed, usedNames, undefined, parseContext)

          // Get the interface name from either standaloneName or params (for REFERENCE nodes)
          const interfaceName =
            baseAST.standaloneName || (baseAST.type === 'REFERENCE' && baseAST.params ? baseAST.params : null)

          // If the base is a generic interface, create instantiation
          if (
            interfaceName &&
            typeof interfaceName === 'string' &&
            parseContext?.genericInterfaces.has(interfaceName)
          ) {
            return {
              comment: schema.description,
              deprecated: schema.deprecated,
              keyName,
              standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames, options),
              params: interfaceName,
              type: 'REFERENCE',
              typeArguments: [typeArgAST],
            }
          }
        }
      }

      // Pattern 2: Check for allOf with base (has empty items) + override pattern
      // By this point, $ref may be dereferenced, so we check for:
      // - One member with empty items (the base)
      // - One member with concrete items (the override)
      if (schema.allOf!.length === 2) {
        const baseMember = schema.allOf!.find((m: any) => hasEmptyItemsSchema(m as NormalizedJSONSchema))
        const overrideMember = schema.allOf!.find((m: any) => m !== baseMember && m.properties)

        log(
          'blue',
          'parser',
          `Pattern 2: baseMember=${!!baseMember}, overrideMember=${!!overrideMember}, baseName=${baseMember && (baseMember as any).$id}`,
        )

        if (baseMember && overrideMember) {
          // Parse the base to get the interface
          const baseAST = parse(baseMember, options, undefined, processed, usedNames, undefined, parseContext)

          // Get the interface name
          const interfaceName =
            baseAST.standaloneName || (baseAST.type === 'REFERENCE' && baseAST.params ? baseAST.params : null)

          log(
            'blue',
            'parser',
            `Pattern 2: interfaceName=${interfaceName}, isGeneric=${parseContext?.genericInterfaces.has(interfaceName as string)}`,
          )

          // Check if this is a generic interface (has empty items)
          if (
            interfaceName &&
            typeof interfaceName === 'string' &&
            parseContext?.genericInterfaces.has(interfaceName)
          ) {
            // Look for the property override that provides the concrete type
            const typeArg = extractTypeArgumentFromOverride(overrideMember, options, processed, usedNames, parseContext)

            if (typeArg) {
              // Check if this creates a recursive union that should be a type alias
              const isRecursiveUnion =
                typeArg.type === 'UNION' &&
                (typeArg as TUnion).params.some(
                  (p: AST) => p.type === 'REFERENCE' && parseContext?.genericInterfaces.has((p as any).params),
                )

              // Get parent schema name - could be from parse context or from root schema
              const parentName = parseContext?.currentInterfaceName || (schema.$id && toSafeString(schema.$id))

              if (isRecursiveUnion && keyName && parentName) {
                // Generate type alias for the recursive union
                const typeAliasName = parentName + toSafeString(keyName.charAt(0).toUpperCase() + keyName.slice(1))

                if (!parseContext.typeAliases.has(typeAliasName)) {
                  log('blue', 'parser', `Creating recursive type alias for allOf pattern: ${typeAliasName}`)

                  const typeAlias: TTypeAlias = {
                    type: 'TYPE_ALIAS',
                    standaloneName: typeAliasName,
                    params: typeArg,
                    comment: `Recursive type for ${parentName}.${keyName}`,
                  }

                  parseContext.typeAliases.set(typeAliasName, typeAlias)

                  // Return reference with type alias instead of direct typeArg
                  return {
                    comment: schema.description,
                    deprecated: schema.deprecated,
                    keyName,
                    standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames, options),
                    params: interfaceName,
                    type: 'REFERENCE',
                    typeArguments: [
                      {
                        type: 'REFERENCE',
                        params: typeAliasName,
                      },
                    ],
                  }
                }
              }

              log('blue', 'parser', `Creating generic instantiation: ${interfaceName}<...>`)
              return {
                comment: schema.description,
                deprecated: schema.deprecated,
                keyName,
                standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames, options),
                params: interfaceName,
                type: 'REFERENCE',
                typeArguments: [typeArg],
              }
            }
          }
        }
      }

      // Default: parse all members with anchor context and create intersection
      const members = schema.allOf!.map(_ =>
        parse(_, options, undefined, processed, usedNames, newAnchorContext, parseContext),
      )

      return {
        comment: schema.description,
        deprecated: schema.deprecated,
        keyName,
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames, options),
        params: members,
        type: 'INTERSECTION',
      }
    }
    case 'ANY':
      return {
        ...(options.unknownAny ? T_UNKNOWN : T_ANY),
        comment: schema.description,
        deprecated: schema.deprecated,
        keyName,
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames, options),
      }
    case 'ANY_OF':
      const anyOfParams = schema.anyOf!.map(_ => {
        const ast = parse(_, options, undefined, processed, usedNames, newAnchorContext, parseContext)

        // If we're in an anchor context and this is a named interface with generics,
        // return a REFERENCE with type arguments instead of modifying the interface
        if (
          newAnchorContext &&
          ast.type === 'INTERFACE' &&
          ast.standaloneName &&
          parseContext?.genericInterfaces.has(ast.standaloneName)
        ) {
          log('blue', 'parser', `Found generic interface ${ast.standaloneName} in anyOf with anchor context`)
          // Create type arguments from the anchor's allowed types
          const typeArguments: AST[] = newAnchorContext.allowedTypeNames.map(typeName => ({
            params: typeName,
            type: 'REFERENCE' as const,
          }))

          // Return a REFERENCE to the generic interface with type arguments
          return {
            params: ast.standaloneName,
            type: 'REFERENCE' as const,
            typeArguments:
              typeArguments.length === 1 ? typeArguments : [{params: typeArguments, type: 'UNION' as const}],
          }
        }

        return ast
      })

      return {
        comment: schema.description,
        deprecated: schema.deprecated,
        keyName,
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames, options),
        params: anyOfParams,
        type: 'UNION',
      }
    case 'BOOLEAN':
      return {
        comment: schema.description,
        deprecated: schema.deprecated,
        keyName,
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames, options),
        type: 'BOOLEAN',
      }
    case 'CUSTOM_TYPE':
      return {
        comment: schema.description,
        deprecated: schema.deprecated,
        keyName,
        params: schema.tsType!,
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames, options),
        type: 'CUSTOM_TYPE',
      }
    case 'NAMED_ENUM':
      return {
        comment: schema.description,
        deprecated: schema.deprecated,
        keyName,
        standaloneName: standaloneName(schema, keyNameFromDefinition ?? keyName, usedNames, options)!,
        params: (schema as EnumJSONSchema).enum!.map((_, n) => ({
          ast: parseLiteral(_, undefined),
          keyName: schema.tsEnumNames![n],
        })),
        type: 'ENUM',
      }
    case 'NAMED_SCHEMA': {
      const ast = newInterface(
        schema as SchemaSchema,
        options,
        processed,
        usedNames,
        keyName,
        undefined,
        newAnchorContext,
        parseContext,
      )

      // If we're in an anchor context and this is a generic interface,
      // return a REFERENCE with type arguments instead of the interface itself
      // This ensures the base generic interface can be declared separately
      if (
        newAnchorContext &&
        ast.type === 'INTERFACE' &&
        ast.standaloneName &&
        parseContext?.genericInterfaces.has(ast.standaloneName)
      ) {
        log(
          'blue',
          'parser',
          `Found generic interface ${ast.standaloneName} in NAMED_SCHEMA with anchor context [${newAnchorContext.allowedTypeNames.join(', ')}]`,
        )
        // Create type arguments from the anchor's allowed types
        const typeArguments: AST[] = newAnchorContext.allowedTypeNames.map(typeName => ({
          params: typeName,
          type: 'REFERENCE' as const,
        }))

        // Return a REFERENCE to the interface with type arguments
        return {
          comment: schema.description,
          keyName,
          params: ast.standaloneName,
          type: 'REFERENCE',
          typeArguments: typeArguments.length === 1 ? typeArguments : [{params: typeArguments, type: 'UNION' as const}],
        }
      }

      return ast
    }
    case 'NEVER':
      return {
        comment: schema.description,
        deprecated: schema.deprecated,
        keyName,
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames, options),
        type: 'NEVER',
      }
    case 'NULL':
      return {
        comment: schema.description,
        deprecated: schema.deprecated,
        keyName,
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames, options),
        type: 'NULL',
      }
    case 'NUMBER':
      return {
        comment: schema.description,
        deprecated: schema.deprecated,
        keyName,
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames, options),
        type: 'NUMBER',
      }
    case 'OBJECT':
      return {
        comment: schema.description,
        keyName,
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames, options),
        type: 'OBJECT',
        deprecated: schema.deprecated,
      }
    case 'ONE_OF':
      const oneOfParams = schema.oneOf!.map(_ => {
        const ast = parse(_, options, undefined, processed, usedNames, newAnchorContext, parseContext)

        log(
          'blue',
          'parser',
          `Parsed oneOf member: type=${ast.type}, standaloneName=${(ast as any).standaloneName}, hasContext=${!!newAnchorContext}`,
        )

        // If we're in an anchor context and this is a named interface with generics,
        // return a REFERENCE with type arguments instead of modifying the interface
        if (
          newAnchorContext &&
          ast.type === 'INTERFACE' &&
          ast.standaloneName &&
          parseContext?.genericInterfaces.has(ast.standaloneName)
        ) {
          log(
            'blue',
            'parser',
            `Found generic interface ${ast.standaloneName} in oneOf with anchor context [${newAnchorContext.allowedTypeNames.join(', ')}]`,
          )
          // Create type arguments from the anchor's allowed types
          const typeArguments: AST[] = newAnchorContext.allowedTypeNames.map(typeName => ({
            params: typeName,
            type: 'REFERENCE' as const,
          }))

          // Return a REFERENCE to the generic interface with type arguments
          return {
            params: ast.standaloneName,
            type: 'REFERENCE' as const,
            typeArguments:
              typeArguments.length === 1 ? typeArguments : [{params: typeArguments, type: 'UNION' as const}],
          }
        }

        return ast
      })

      return {
        comment: schema.description,
        deprecated: schema.deprecated,
        keyName,
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames, options),
        params: oneOfParams,
        type: 'UNION',
      }
    case 'REFERENCE':
      throw Error(format('Refs should have been resolved by the resolver!', schema))
    case 'DYNAMIC_REFERENCE':
      return parseDynamicReference(schema, keyName, options, newAnchorContext, parseContext)
    case 'STRING':
      return {
        comment: schema.description,
        deprecated: schema.deprecated,
        keyName,
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames, options),
        type: 'STRING',
      }
    case 'TYPED_ARRAY':
      if (Array.isArray(schema.items)) {
        // normalised to not be undefined
        const minItems = schema.minItems!
        const maxItems = schema.maxItems!
        const arrayType: TTuple = {
          comment: schema.description,
          deprecated: schema.deprecated,
          keyName,
          maxItems,
          minItems,
          standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames, options),
          params: schema.items.map(_ =>
            parse(_, options, undefined, processed, usedNames, newAnchorContext, parseContext),
          ),
          type: 'TUPLE',
        }
        if (schema.additionalItems === true) {
          arrayType.spreadParam = options.unknownAny ? T_UNKNOWN : T_ANY
        } else if (schema.additionalItems) {
          arrayType.spreadParam = parse(
            schema.additionalItems,
            options,
            undefined,
            processed,
            usedNames,
            newAnchorContext,
          )
        }
        return arrayType
      } else {
        return {
          comment: schema.description,
          deprecated: schema.deprecated,
          keyName,
          standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames, options),
          params: parse(
            schema.items!,
            options,
            `{keyNameFromDefinition}Items`,
            processed,
            usedNames,
            newAnchorContext,
            parseContext,
          ),
          type: 'ARRAY',
        }
      }
    case 'UNION':
      return {
        comment: schema.description,
        deprecated: schema.deprecated,
        keyName,
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames, options),
        params: (schema.type as JSONSchema4TypeName[]).map(type => {
          const member: LinkedJSONSchema = {...omit(schema, '$id', 'description', 'title'), type}
          maybeStripDefault(member)
          applySchemaTyping(member)
          return parse(member, options, undefined, processed, usedNames, newAnchorContext, parseContext)
        }),
        type: 'UNION',
      }
    case 'UNNAMED_ENUM':
      return {
        comment: schema.description,
        deprecated: schema.deprecated,
        keyName,
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames, options),
        params: (schema as EnumJSONSchema).enum!.map(_ => parseLiteral(_, undefined)),
        type: 'UNION',
      }
    case 'UNNAMED_SCHEMA':
      return newInterface(
        schema as SchemaSchema,
        options,
        processed,
        usedNames,
        keyName,
        keyNameFromDefinition,
        newAnchorContext,
      )
    case 'UNTYPED_ARRAY':
      // normalised to not be undefined
      const minItems = schema.minItems!
      const maxItems = typeof schema.maxItems === 'number' ? schema.maxItems : -1
      const params = options.unknownAny ? T_UNKNOWN : T_ANY
      if (minItems > 0 || maxItems >= 0) {
        return {
          comment: schema.description,
          deprecated: schema.deprecated,
          keyName,
          maxItems: schema.maxItems,
          minItems,
          // create a tuple of length N
          params: Array(Math.max(maxItems, minItems) || 0).fill(params),
          // if there is no maximum, then add a spread item to collect the rest
          spreadParam: maxItems >= 0 ? undefined : params,
          standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames, options),
          type: 'TUPLE',
        }
      }

      return {
        comment: schema.description,
        deprecated: schema.deprecated,
        keyName,
        params,
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames, options),
        type: 'ARRAY',
      }
  }
}

/**
 * Parse a $dynamicRef. This returns either:
 * - A reference to a type parameter (if in a generic standalone interface)
 * - A union of types from the anchor context (if in a $dynamicAnchor scope)
 * - The default type (if no generic context available)
 */
function parseDynamicReference(
  schema: NormalizedJSONSchema,
  keyName: string | undefined,
  options: Options,
  anchorContext?: AnchorContext,
  parseContext?: ParseContext,
): AST {
  const dynamicRef = schema.$dynamicRef
  if (!dynamicRef) {
    throw Error('Expected $dynamicRef to be defined')
  }

  // Extract the anchor name from the $dynamicRef (e.g., "#allowedNodes" -> "allowedNodes")
  const anchorName = dynamicRef.replace(/^#/, '')

  // If we're in an anchor context, resolve to the types from that context
  if (anchorContext && anchorContext.anchorName === anchorName && anchorContext.allowedTypeNames.length > 0) {
    const typeRefs: AST[] = anchorContext.allowedTypeNames.map(typeName => ({
      params: typeName,
      type: 'REFERENCE' as const,
    }))

    if (typeRefs.length === 1) {
      return {
        comment: schema.description,
        keyName,
        ...typeRefs[0],
      }
    }

    return {
      comment: schema.description,
      keyName,
      params: typeRefs,
      type: 'UNION',
    }
  }

  // Check if we're in a generic interface
  const isInGenericInterface =
    parseContext?.currentInterfaceName && parseContext.genericInterfaces.has(parseContext.currentInterfaceName)

  // If we're in a generic interface, use a type parameter reference
  if (isInGenericInterface) {
    const typeParamName = 'T' + anchorName.charAt(0).toUpperCase() + anchorName.slice(1)
    return {
      comment: schema.description,
      keyName,
      params: typeParamName,
      type: 'REFERENCE',
    }
  }

  // Otherwise, use the default type
  const rootSchema = getRootSchema(schema)
  const defaultType = getDefaultTypeForDynamicRef(rootSchema, anchorName, options)

  return {
    comment: schema.description,
    keyName,
    ...defaultType,
  }
}

/**
 * Compute a schema name using a series of fallbacks
 */
function standaloneName(
  schema: NormalizedJSONSchema,
  keyNameFromDefinition: string | undefined,
  usedNames: UsedNames,
  options: Options,
): string | undefined {
  const name =
    options.customName?.(schema, keyNameFromDefinition) || schema.title || schema.$id || keyNameFromDefinition
  if (name) {
    return generateName(name, usedNames)
  }
}

function newInterface(
  schema: SchemaSchema,
  options: Options,
  processed: Processed,
  usedNames: UsedNames,
  keyName?: string,
  keyNameFromDefinition?: string,
  anchorContext?: AnchorContext,
  parseContext?: ParseContext,
): TInterface {
  const name = standaloneName(schema, keyNameFromDefinition, usedNames, options)!

  // Check if this interface needs a type parameter (contains $dynamicRef)
  // Only add type parameters to standalone (named) interfaces
  let typeParameters: Array<{name: string; defaultType?: AST}> | undefined

  if (name && schemaNeedsTypeParameter(schema)) {
    const anchorName = getDynamicRefAnchorName(schema)
    if (anchorName) {
      // $dynamicRef pattern
      const typeParamName = 'T' + anchorName.charAt(0).toUpperCase() + anchorName.slice(1)
      const rootSchema = getRootSchema(schema)
      const defaultType = getDefaultTypeForDynamicRef(rootSchema, anchorName, options)

      typeParameters = [
        {
          name: typeParamName,
          defaultType,
        },
      ]

      log('blue', 'parser', `Adding type parameter ${typeParamName} to interface ${name}`)
    } else if (hasEmptyItemsSchema(schema)) {
      // Empty items pattern: items: {}
      const typeParamName = 'T'
      const defaultType = options.unknownAny ? T_UNKNOWN : T_ANY

      typeParameters = [
        {
          name: typeParamName,
          defaultType,
        },
      ]

      log('blue', 'parser', `Adding type parameter ${typeParamName} to interface ${name} (empty items)`)
    }
  }

  // Set the current interface name in parseContext for child parsers
  const updatedParseContext = parseContext
    ? {
        ...parseContext,
        currentInterfaceName: name,
      }
    : undefined

  // For generic interfaces, create a self-referential anchor context
  // This allows $dynamicRef to resolve to the type parameter
  let contextForParsing = anchorContext
  if (typeParameters && schema.$dynamicAnchor) {
    const typeParamName = typeParameters[0].name
    contextForParsing = {
      anchorName: schema.$dynamicAnchor,
      allowedTypeNames: [typeParamName],
    }
  } else if (typeParameters) {
    // Generic interface without $dynamicAnchor - no context
    contextForParsing = undefined
  }

  const interfaceAST: TInterface = {
    comment: schema.description,
    deprecated: schema.deprecated,
    keyName,
    params: parseSchema(schema, options, processed, usedNames, name, contextForParsing, updatedParseContext),
    standaloneName: name,
    superTypes: parseSuperTypes(schema, options, processed, usedNames, contextForParsing, updatedParseContext),
    type: 'INTERFACE',
    typeParameters,
  }

  // Store generic interfaces in parseContext so they can be emitted even if not in AST tree
  // Only store if not already stored (to keep the first version which has proper type parameters)
  if (name && typeParameters && parseContext && !parseContext.genericInterfaceASTs.has(name)) {
    parseContext.genericInterfaceASTs.set(name, interfaceAST)
    log('blue', 'parser', `Stored generic interface ${name} for later emission`)
  }

  return interfaceAST
}

function parseSuperTypes(
  schema: SchemaSchema,
  options: Options,
  processed: Processed,
  usedNames: UsedNames,
  anchorContext?: AnchorContext,
  parseContext?: ParseContext,
): TNamedInterface[] {
  // Type assertion needed because of dereferencing step
  // TODO: Type it upstream
  const superTypes = schema.extends as SchemaSchema[] | undefined
  if (!superTypes) {
    return []
  }
  return superTypes.map(
    _ => parse(_, options, undefined, processed, usedNames, anchorContext, parseContext) as TNamedInterface,
  )
}

/**
 * Helper to parse schema properties into params on the parent schema's type
 */
function parseSchema(
  schema: SchemaSchema,
  options: Options,
  processed: Processed,
  usedNames: UsedNames,
  parentSchemaName: string,
  anchorContext?: AnchorContext,
  parseContext?: ParseContext,
): TInterfaceParam[] {
  let asts: TInterfaceParam[] = map(schema.properties, (value, key: string) => {
    let ast = parse(value, options, key, processed, usedNames, anchorContext, parseContext)

    // Check if we're in a generic interface and this property has empty items
    // If so, replace the array items with the type parameter
    if (
      parseContext?.currentInterfaceName &&
      parseContext.genericInterfaces.has(parseContext.currentInterfaceName) &&
      value.type === 'array' &&
      value.items &&
      typeof value.items === 'object' &&
      !Array.isArray(value.items) &&
      (Object.keys(value.items).length === 0 ||
        (Object.keys(value.items).length === 1 && 'type' in value.items && !value.items.type))
    ) {
      const typeParamName = parseContext.genericInterfaces.get(parseContext.currentInterfaceName)!
      ast = {
        comment: value.description,
        keyName: key,
        params: {
          params: typeParamName,
          type: 'REFERENCE',
        },
        type: 'ARRAY',
      }
      log('blue', 'parser', `Replaced empty items with type parameter ${typeParamName} for ${key}`)
    }

    // Check if this property defines a $dynamicAnchor with oneOf/anyOf (recursive union pattern)
    const hasRecursivePattern = value.$dynamicAnchor && (value.oneOf || value.anyOf) && parentSchemaName && parseContext

    if (hasRecursivePattern) {
      // Generate type alias name: e.g., "Issue3TestContentChildren"
      const typeAliasName = toSafeString(parentSchemaName) + toSafeString(key.charAt(0).toUpperCase() + key.slice(1))

      // Check if there are any generic interfaces in the union that would create recursion
      const hasGenericMembers =
        ast.type === 'UNION' &&
        ast.params.some((p: AST) => p.type === 'REFERENCE' && parseContext.genericInterfaces.has((p as any).params))

      if (hasGenericMembers && !parseContext.typeAliases.has(typeAliasName)) {
        log('blue', 'parser', `Creating recursive type alias: ${typeAliasName}`)

        // Create a type alias that will reference itself
        // We'll replace generic instantiations with self-references in the generator
        const typeAlias: TTypeAlias = {
          type: 'TYPE_ALIAS',
          standaloneName: typeAliasName,
          params: ast,
          comment: `Recursive type for ${parentSchemaName}.${key}`,
        }

        parseContext.typeAliases.set(typeAliasName, typeAlias)

        // Replace the property AST with a reference to the type alias
        ast = {
          type: 'REFERENCE',
          params: typeAliasName,
        }
      }
    }

    // If we're in an anchor context and this is a reference to a generic type, instantiate it
    if (anchorContext && ast.type === 'REFERENCE' && parseContext?.genericInterfaces.has(ast.params)) {
      // Create type arguments from the anchor's allowed types
      const typeArguments: AST[] = anchorContext.allowedTypeNames.map(typeName => ({
        params: typeName,
        type: 'REFERENCE' as const,
      }))

      log(
        'blue',
        'parser',
        `Instantiating generic ${ast.params} with types [${anchorContext.allowedTypeNames.join(', ')}]`,
      )

      ast = {
        ...ast,
        typeArguments: typeArguments.length === 1 ? typeArguments : [{params: typeArguments, type: 'UNION' as const}],
      }
    }

    return {
      ast,
      isPatternProperty: false,
      isRequired: includes(schema.required || [], key),
      isUnreachableDefinition: false,
      keyName: key,
    }
  })

  let singlePatternProperty = false
  if (schema.patternProperties) {
    // partially support patternProperties. in the case that
    // additionalProperties is not set, and there is only a single
    // value definition, we can validate against that.
    singlePatternProperty = !schema.additionalProperties && Object.keys(schema.patternProperties).length === 1

    asts = asts.concat(
      map(schema.patternProperties, (value, key: string) => {
        const ast = parse(value, options, key, processed, usedNames, anchorContext, parseContext)
        const comment = `This interface was referenced by \`${parentSchemaName}\`'s JSON-Schema definition
via the \`patternProperty\` "${key.replace('*/', '*\\/')}".`
        ast.comment = ast.comment ? `${ast.comment}\n\n${comment}` : comment
        return {
          ast,
          isPatternProperty: !singlePatternProperty,
          isRequired: singlePatternProperty || includes(schema.required || [], key),
          isUnreachableDefinition: false,
          keyName: singlePatternProperty ? '[k: string]' : key,
        }
      }),
    )
  }

  if (options.unreachableDefinitions) {
    asts = asts.concat(
      map(schema.$defs, (value, key: string) => {
        const ast = parse(value, options, key, processed, usedNames, anchorContext, parseContext)
        const comment = `This interface was referenced by \`${parentSchemaName}\`'s JSON-Schema
via the \`definition\` "${key}".`
        ast.comment = ast.comment ? `${ast.comment}\n\n${comment}` : comment
        return {
          ast,
          isPatternProperty: false,
          isRequired: includes(schema.required || [], key),
          isUnreachableDefinition: true,
          keyName: key,
        }
      }),
    )
  }

  // handle additionalProperties
  switch (schema.additionalProperties) {
    case undefined:
    case true:
      if (singlePatternProperty) {
        return asts
      }
      return asts.concat({
        ast: options.unknownAny ? T_UNKNOWN_ADDITIONAL_PROPERTIES : T_ANY_ADDITIONAL_PROPERTIES,
        isPatternProperty: false,
        isRequired: true,
        isUnreachableDefinition: false,
        keyName: '[k: string]',
      })

    case false:
      return asts

    // pass "true" as the last param because in TS, properties
    // defined via index signatures are already optional
    default:
      return asts.concat({
        ast: parse(
          schema.additionalProperties,
          options,
          '[k: string]',
          processed,
          usedNames,
          anchorContext,
          parseContext,
        ),
        isPatternProperty: false,
        isRequired: true,
        isUnreachableDefinition: false,
        keyName: '[k: string]',
      })
  }
}

type Definitions = {[k: string]: NormalizedJSONSchema}

function getDefinitions(
  schema: NormalizedJSONSchema,
  isSchema = true,
  processed = new Set<NormalizedJSONSchema>(),
): Definitions {
  if (processed.has(schema)) {
    return {}
  }
  processed.add(schema)
  if (Array.isArray(schema)) {
    return schema.reduce(
      (prev, cur) => ({
        ...prev,
        ...getDefinitions(cur, false, processed),
      }),
      {},
    )
  }
  if (isPlainObject(schema)) {
    return {
      ...(isSchema && hasDefinitions(schema) ? schema.$defs : {}),
      ...Object.keys(schema).reduce<Definitions>(
        (prev, cur) => ({
          ...prev,
          ...getDefinitions(schema[cur], false, processed),
        }),
        {},
      ),
    }
  }
  return {}
}

const getDefinitionsMemoized = memoize(getDefinitions)

/**
 * TODO: Reduce rate of false positives
 */
function hasDefinitions(schema: NormalizedJSONSchema): schema is JSONSchemaWithDefinitions {
  return '$defs' in schema
}
