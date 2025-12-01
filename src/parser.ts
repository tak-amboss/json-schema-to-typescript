import {JSONSchema4Type, JSONSchema4TypeName} from 'json-schema'
import {findKey, includes, isPlainObject, map, memoize, omit} from 'lodash'
import {format} from 'util'
import {Options} from './'
import {applySchemaTyping} from './applySchemaTyping'
import type {AST, TInterface, TInterfaceParam, TIntersection, TNamedInterface, TTuple} from './types/AST'
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

  // Only process if there are dynamic refs
  if (dynamicRefs.size === 0) {
    return
  }

  // For each unique anchor name, find interfaces that contain $dynamicRef to that anchor
  for (const anchorName of dynamicRefs) {
    const typeParamName = 'T' + anchorName.charAt(0).toUpperCase() + anchorName.slice(1)

    // Find all interfaces that contain this $dynamicRef
    traverse(rootSchema, (s: LinkedJSONSchema) => {
      const normalized = s as NormalizedJSONSchema
      if (normalized.$id && schemaNeedsTypeParameter(normalized)) {
        const interfaceName = toSafeString(normalized.$id)
        parseContext.genericInterfaces.set(interfaceName, typeParamName)
        log('blue', 'parser', `Pre-identified generic interface ${interfaceName} with type parameter ${typeParamName}`)
      }
    })
  }
}

/**
 * Check if a schema directly contains a $dynamicRef in its properties
 * (not in nested schemas)
 */
function schemaNeedsTypeParameter(schema: NormalizedJSONSchema): boolean {
  // Check if any direct property contains $dynamicRef
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
          }
        }
      }
    }
  }
  return false
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
function getDefaultTypeForDynamicRef(
  rootSchema: NormalizedJSONSchema,
  anchorName: string,
  options: Options,
  _processed: Processed,
  _usedNames: UsedNames,
): AST {
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

export function parse(
  schema: NormalizedJSONSchema | JSONSchema4Type,
  options: Options,
  keyName?: string,
  processed: Processed = new Map(),
  usedNames = new Set<string>(),
  anchorContext?: AnchorContext,
  parseContext?: ParseContext,
): AST {
  // Initialize parse context on first call
  if (!parseContext) {
    parseContext = {
      genericInterfaces: new Map<string, string>(),
    }

    // Pre-scan the schema to identify all interfaces that need type parameters
    if (!isPrimitive(schema)) {
      identifyGenericInterfaces(getRootSchema(schema as NormalizedJSONSchema), parseContext)
    }
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
    case 'ALL_OF':
      return {
        comment: schema.description,
        deprecated: schema.deprecated,
        keyName,
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames, options),
        params: schema.allOf!.map(_ =>
          parse(_, options, undefined, processed, usedNames, newAnchorContext, parseContext),
        ),
        type: 'INTERSECTION',
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

        // If we're in an anchor context and this is a named interface with generics, instantiate it
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

          // Add type arguments to the interface
          const instantiatedAST = {
            ...ast,
            typeArguments:
              typeArguments.length === 1 ? typeArguments : [{params: typeArguments, type: 'UNION' as const}],
          }

          return instantiatedAST
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

      // If we're in an anchor context and this is a generic interface, add type arguments
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

        // Add type arguments to the interface
        return {
          ...ast,
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

        // If we're in an anchor context and this is a named interface with generics, instantiate it
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

          // Add type arguments to the interface
          const instantiatedAST = {
            ...ast,
            typeArguments:
              typeArguments.length === 1 ? typeArguments : [{params: typeArguments, type: 'UNION' as const}],
          }

          return instantiatedAST
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
      return parseDynamicReference(schema, options, keyName, processed, usedNames)
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
 * Parse a $dynamicRef. This returns a reference to a type parameter that will be
 * added to the containing interface.
 */
function parseDynamicReference(
  schema: NormalizedJSONSchema,
  _options: Options,
  keyName: string | undefined,
  _processed: Processed,
  _usedNames: UsedNames,
): AST {
  const dynamicRef = schema.$dynamicRef
  if (!dynamicRef) {
    throw Error('Expected $dynamicRef to be defined')
  }

  // Extract the anchor name from the $dynamicRef (e.g., "#allowedNodes" -> "allowedNodes")
  const anchorName = dynamicRef.replace(/^#/, '')

  // Generate a type parameter name from the anchor name
  const typeParamName = 'T' + anchorName.charAt(0).toUpperCase() + anchorName.slice(1)

  // Return a reference to the type parameter
  // The containing interface will have this as a type parameter
  return {
    comment: schema.description,
    keyName,
    params: typeParamName,
    type: 'REFERENCE',
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
  let typeParameters: Array<{name: string; defaultType?: AST}> | undefined

  if (schemaNeedsTypeParameter(schema)) {
    const anchorName = getDynamicRefAnchorName(schema)
    if (anchorName) {
      const typeParamName = 'T' + anchorName.charAt(0).toUpperCase() + anchorName.slice(1)
      const rootSchema = getRootSchema(schema)
      const defaultType = getDefaultTypeForDynamicRef(rootSchema, anchorName, options, processed, usedNames)

      typeParameters = [
        {
          name: typeParamName,
          defaultType,
        },
      ]

      log('blue', 'parser', `Adding type parameter ${typeParamName} to interface ${name}`)
    }
  }

  return {
    comment: schema.description,
    deprecated: schema.deprecated,
    keyName,
    params: parseSchema(schema, options, processed, usedNames, name, anchorContext, parseContext),
    standaloneName: name,
    superTypes: parseSuperTypes(schema, options, processed, usedNames, anchorContext, parseContext),
    type: 'INTERFACE',
    typeParameters,
  }
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
