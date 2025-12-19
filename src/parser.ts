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
  // Map of type name -> constraint schema (for allOf patterns in oneOf items)
  typeConstraints?: Map<string, any>
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
  // Pre-scanned anchor contexts (collected before normalization strips $refs)
  anchorContexts: Map<string, AnchorContext>
  // Current type alias being generated (for nested patterns to reference)
  currentTypeAliasName?: string
  // Maps $dynamicAnchor names to their generated type alias names
  // This ensures the same anchor always uses the same type alias across the schema
  anchorToAliasMap: Map<string, string>
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
    // Note: Anchor contexts are now collected in compile() before dereference
    // They're passed into parseWithContext() and available in parseContext.anchorContexts

    // For each unique anchor name, find interfaces that contain $dynamicRef to that anchor
    for (const anchorName of dynamicRefs) {
      const typeParamName = 'T' + anchorName.charAt(0).toUpperCase() + anchorName.slice(1)

      // Find all interfaces that contain this $dynamicRef
      traverse(rootSchema, (s: LinkedJSONSchema, key: string | null) => {
        const normalized = s as NormalizedJSONSchema
        if (schemaNeedsTypeParameter(normalized)) {
          // Use the same priority as standaloneName: title || $id || key
          // This ensures registration name matches the name used later
          const rawName = normalized.title || normalized.$id || (key ? key : null)
          const interfaceName = rawName ? toSafeString(rawName) : null
          if (interfaceName && !parseContext.genericInterfaces.has(interfaceName)) {
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
  traverse(rootSchema, (s: LinkedJSONSchema, key: string | null) => {
    const normalized = s as NormalizedJSONSchema
    if (hasEmptyItemsSchema(normalized)) {
      // Use the same priority as standaloneName: title || $id || key
      // This ensures registration name matches the name used later
      const rawName = normalized.title || normalized.$id || (key ? key : null)
      const interfaceName = rawName ? toSafeString(rawName) : null
      if (interfaceName && !parseContext.genericInterfaces.has(interfaceName)) {
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
  // Recursively check if schema or any nested property contains $dynamicRef or empty items
  const visited = new Set<any>()

  const checkSchema = (s: any): boolean => {
    if (!s || typeof s !== 'object') {
      return false
    }

    // Prevent infinite recursion on circular references
    if (visited.has(s)) {
      return false
    }
    visited.add(s)

    // Check if this schema has $dynamicRef
    if (s.$dynamicRef) {
      return true
    }

    // Check if this schema has empty items
    if (s.items) {
      if (!Array.isArray(s.items) && typeof s.items === 'object') {
        if (s.items.$dynamicRef) {
          return true
        }
        // Check for empty items schema: items: {}
        if (
          Object.keys(s.items).length === 0 ||
          (Object.keys(s.items).length === 1 && 'type' in s.items && !s.items.type)
        ) {
          return true
        }
      }
    }

    // Recursively check nested properties
    if (s.properties) {
      for (const prop of Object.values(s.properties)) {
        if (checkSchema(prop)) {
          return true
        }
      }
    }

    return false
  }

  return checkSchema(schema)
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
        // Also recursively check nested properties
        if (propSchema.properties) {
          if (hasEmptyItemsSchema(propSchema)) {
            return true
          }
        }
      }
    }
  }
  return false
}

/**
 * Extract $dynamicAnchor name from an allOf override member
 * Returns the anchor name if found, undefined otherwise
 */
function extractAnchorNameFromOverride(overrideMember: any): string | undefined {
  if (!overrideMember || !overrideMember.properties) {
    return undefined
  }

  // Look through properties for one with a $dynamicAnchor in its items
  for (const prop of Object.values(overrideMember.properties)) {
    if (prop && typeof prop === 'object') {
      const propSchema = prop as any
      // Check if it has items with $dynamicAnchor
      if (propSchema.items && propSchema.items.$dynamicAnchor) {
        return propSchema.items.$dynamicAnchor
      }
      // Also check nested properties recursively
      if (propSchema.properties) {
        const nested = extractAnchorNameFromOverride(propSchema)
        if (nested) return nested
      }
    }
  }

  return undefined
}

/**
 * Find nested $dynamicAnchor in anyOf members
 * Returns the anchor context if found
 */
function findNestedDynamicAnchor(anyOfMembers: any[]): AnchorContext | null {
  log('blue', 'parser', `findNestedDynamicAnchor: checking ${anyOfMembers.length} members`)

  for (const member of anyOfMembers) {
    log(
      'blue',
      'parser',
      `  member has allOf: ${!!member.allOf}, type: ${member.type}, hasProperties: ${!!member.properties}`,
    )

    // Look for allOf pattern
    if (member.allOf && Array.isArray(member.allOf)) {
      log('blue', 'parser', `  allOf has ${member.allOf.length} members`)

      for (let i = 0; i < member.allOf.length; i++) {
        const m = member.allOf[i]
        log('blue', 'parser', `    member ${i}: hasRef=${!!m.$ref}, hasProperties=${!!m.properties}`)
      }

      // Check override member for nested $dynamicAnchor
      // Pattern: allOf[0] is the base $ref, allOf[1] is the override
      // Note: In normalized schemas, allOf[0] might have been dereferenced,
      // so we can't rely on $ref presence. Just use allOf[1] directly.
      const overrideMember = member.allOf.length >= 2 ? member.allOf[1] : null

      log('blue', 'parser', `  overrideMember found: ${!!overrideMember}, length: ${member.allOf.length}`)

      if (overrideMember && overrideMember.properties) {
        // Check the RAW properties before normalization
        const anchor = findDynamicAnchorInRawProperties(overrideMember.properties)
        if (anchor) {
          log('blue', 'parser', `  Found anchor: ${anchor.anchorName}`)
          return anchor
        }
      }
    }
  }

  log('blue', 'parser', `  No nested anchor found`)
  return null
}

/**
 * Find $dynamicAnchor in raw properties (before normalization/dereferencing)
 * This checks the properties object directly from the schema
 */
function findDynamicAnchorInRawProperties(properties: any): AnchorContext | null {
  const propKeys = Object.keys(properties)
  log(
    'blue',
    'parser',
    `    findDynamicAnchorInRawProperties: checking ${propKeys.length} properties: [${propKeys.join(', ')}]`,
  )

  for (const [propKey, prop] of Object.entries(properties)) {
    if (prop && typeof prop === 'object') {
      const propSchema = prop as any

      log(
        'blue',
        'parser',
        `      checking ${propKey}: hasAnchor=${!!propSchema.$dynamicAnchor}, hasProperties=${!!propSchema.properties}, hasItems=${!!propSchema.items}, type=${propSchema.type}`,
      )

      // Direct check for $dynamicAnchor on this property
      if (propSchema.$dynamicAnchor && (propSchema.oneOf || propSchema.anyOf)) {
        const allowedTypeNames: string[] = []
        const allConstraints = new Map<string, any>()
        const union = propSchema.oneOf || propSchema.anyOf

        // Use consistent type extraction that handles nested allOf
        for (const item of union) {
          const {names, constraints} = extractTypeNamesFromUnionItem(item)
          allowedTypeNames.push(...names)
          // Merge constraints
          for (const [typeName, constraint] of constraints.entries()) {
            allConstraints.set(typeName, constraint)
          }
        }

        log('blue', 'parser', `Found $dynamicAnchor in raw property ${propKey}: ${propSchema.$dynamicAnchor}`)
        return {
          anchorName: propSchema.$dynamicAnchor,
          allowedTypeNames,
          typeConstraints: allConstraints.size > 0 ? allConstraints : undefined,
        }
      }

      // Recursively check nested properties
      if (propSchema.properties) {
        const nested = findDynamicAnchorInRawProperties(propSchema.properties)
        if (nested) {
          return nested
        }
      }

      // Check in array items
      if (propSchema.items && typeof propSchema.items === 'object' && !Array.isArray(propSchema.items)) {
        const itemKeys = Object.keys(propSchema.items)
        log(
          'blue',
          'parser',
          `        Checking items of ${propKey}: keys=[${itemKeys.join(',')}], $dynamicAnchor=${!!propSchema.items.$dynamicAnchor}, oneOf=${!!propSchema.items.oneOf}, anyOf=${!!propSchema.items.anyOf}`,
        )

        if (propSchema.items.$dynamicAnchor && (propSchema.items.oneOf || propSchema.items.anyOf)) {
          const allowedTypeNames: string[] = []
          const allConstraints = new Map<string, any>()
          const union = propSchema.items.oneOf || propSchema.items.anyOf

          log('blue', 'parser', `          Extracting types from union of ${union.length} items`)

          for (const item of union) {
            const {names, constraints} = extractTypeNamesFromUnionItem(item)
            log('blue', 'parser', `            Extracted names from item: [${names.join(', ')}]`)
            allowedTypeNames.push(...names)
            // Merge constraints
            for (const [typeName, constraint] of constraints.entries()) {
              allConstraints.set(typeName, constraint)
            }
          }

          log(
            'blue',
            'parser',
            `Found $dynamicAnchor in raw items of ${propKey}: ${propSchema.items.$dynamicAnchor}, extracted ${allowedTypeNames.length} types: [${allowedTypeNames.join(', ')}]`,
          )
          return {
            anchorName: propSchema.items.$dynamicAnchor,
            allowedTypeNames,
            typeConstraints: allConstraints.size > 0 ? allConstraints : undefined,
          }
        }
      }
    }
  }

  return null
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
  anchorContext?: AnchorContext,
): AST | null {
  if (!overrideMember.properties) {
    return null
  }

  // Recursively find the first array property with concrete items
  function findArrayItems(props: any): AST | null {
    for (const prop of Object.values(props)) {
      if (prop && typeof prop === 'object') {
        const propSchema = prop as NormalizedJSONSchema
        // Look for array with items (either explicit type: "array" or just has items property)
        const isArray = propSchema.type === 'array' || (propSchema.items && !propSchema.properties)
        if (isArray && propSchema.items) {
          const items = propSchema.items
          if (!Array.isArray(items) && typeof items === 'object') {
            // Check if items has concrete type (oneOf, anyOf, type, $ref, $dynamicAnchor)
            if (
              (items as NormalizedJSONSchema).oneOf ||
              (items as NormalizedJSONSchema).anyOf ||
              (items as NormalizedJSONSchema).$dynamicAnchor
            ) {
              // Parse this as the type argument, passing anchor context for proper type instantiation
              return parse(
                items as NormalizedJSONSchema,
                options,
                undefined,
                processed,
                usedNames,
                anchorContext,
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
                anchorContext,
                parseContext,
              )
            }
          }
        }
        // Recursively search nested properties
        if (propSchema.properties) {
          const result = findArrayItems(propSchema.properties)
          if (result) {
            return result
          }
        }
      }
    }
    return null
  }

  return findArrayItems(overrideMember.properties)
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
/**
 * Extract type names and constraints from a union item, handling nested allOf patterns
 */
function extractTypeNamesFromUnionItem(item: any): {names: string[]; constraints: Map<string, any>} {
  const names: string[] = []
  const constraints = new Map<string, any>()

  // Direct $ref (no constraints)
  if (item.$ref) {
    const refName = item.$ref.split('/').pop()
    if (refName) {
      names.push(toSafeString(refName))
    }
  }

  // Nested allOf pattern (e.g., for property constraints)
  if (item.allOf && Array.isArray(item.allOf)) {
    // Find the base $ref
    const baseRef = item.allOf.find((member: any) => member.$ref)
    if (baseRef) {
      const refName = baseRef.$ref.split('/').pop()
      if (refName) {
        const typeName = toSafeString(refName)
        names.push(typeName)

        // Collect constraint schemas (everything that's not a $ref)
        const constraintSchemas = item.allOf.filter((member: any) => !member.$ref && member.properties)
        if (constraintSchemas.length > 0) {
          // Merge all constraint schemas into one
          const mergedConstraints = {
            properties: {},
          }
          for (const constraintSchema of constraintSchemas) {
            if (constraintSchema.properties) {
              Object.assign(mergedConstraints.properties, constraintSchema.properties)
            }
          }
          constraints.set(typeName, mergedConstraints)
        }
      }
    }
  }

  return {names, constraints}
}

/**
 * Collect anchor contexts from the original schema before any processing
 * This is called in compile() before dereference strips the $refs
 */
export function collectAnchorContexts(schema: any): Map<string, AnchorContext> {
  const anchorContexts = new Map<string, AnchorContext>()

  function traverse(obj: any) {
    if (!obj || typeof obj !== 'object') return

    // Check if this object has a $dynamicAnchor with oneOf/anyOf
    if (obj.$dynamicAnchor && (obj.oneOf || obj.anyOf)) {
      const union = obj.oneOf || obj.anyOf
      const allowedTypeNames: string[] = []
      const allConstraints = new Map<string, any>()

      for (const item of union) {
        const {names, constraints} = extractTypeNamesFromUnionItem(item)
        allowedTypeNames.push(...names)
        // Merge constraints
        for (const [typeName, constraint] of constraints.entries()) {
          allConstraints.set(typeName, constraint)
        }
      }

      if (allowedTypeNames.length > 0) {
        anchorContexts.set(obj.$dynamicAnchor, {
          anchorName: obj.$dynamicAnchor,
          allowedTypeNames,
          typeConstraints: allConstraints.size > 0 ? allConstraints : undefined,
        })
        log('blue', 'parser', `Collected anchor context: ${obj.$dynamicAnchor} -> [${allowedTypeNames.join(', ')}]`)
        if (allConstraints.size > 0) {
          log('blue', 'parser', `  With constraints for: [${Array.from(allConstraints.keys()).join(', ')}]`)
        }
      }
    }

    // Recursively traverse all properties
    for (const key in obj) {
      if (key !== '$ref') {
        // Don't follow $refs during collection
        traverse(obj[key])
      }
    }
  }

  traverse(schema)
  return anchorContexts
}

/**
 * Post-process generic interfaces to make them truly generic with T = unknown
 * This prevents field-specific defaults from leaking into shared node definitions
 */
function genericizeInterfaces(parseContext: ParseContext, options: Options): void {
  // Track which interfaces appear in which type aliases (anchor contexts)
  const interfaceUsage = new Map<string, Set<string>>() // interfaceName -> Set<typeAliasName>

  // Check all type aliases to find which interfaces are used where
  for (const [typeAliasName, typeAlias] of parseContext.typeAliases.entries()) {
    // Walk the type alias to find referenced generic interfaces
    function findReferencedGenerics(node: AST) {
      if (node.type === 'REFERENCE' && typeof (node as any).params === 'string') {
        const refName = (node as any).params
        if (parseContext.genericInterfaces.has(refName)) {
          if (!interfaceUsage.has(refName)) {
            interfaceUsage.set(refName, new Set())
          }
          interfaceUsage.get(refName)!.add(typeAliasName)
        }
      }
      if (node.type === 'UNION' && Array.isArray((node as any).params)) {
        ;(node as any).params.forEach((p: AST) => findReferencedGenerics(p))
      }
      if (node.type === 'INTERSECTION' && Array.isArray((node as any).params)) {
        ;(node as any).params.forEach((p: AST) => findReferencedGenerics(p))
      }
    }

    findReferencedGenerics(typeAlias.params)
  }

  // Only genericize interfaces that are used in MULTIPLE type aliases
  // (i.e., shared across different fields/contexts)
  const interfacesToGenericize = new Set<string>()
  for (const [interfaceName, typeAliases] of interfaceUsage.entries()) {
    if (typeAliases.size > 1) {
      interfacesToGenericize.add(interfaceName)
      log(
        'blue',
        'parser',
        `Interface ${interfaceName} used in ${typeAliases.size} contexts: [${Array.from(typeAliases).join(', ')}] - genericizing`,
      )
    }
  }

  log(
    'blue',
    'parser',
    `Genericizing ${interfacesToGenericize.size} shared interfaces: [${Array.from(interfacesToGenericize).join(', ')}]`,
  )

  // No need to walk the main AST - generic interfaces are emitted from genericInterfaceASTs

  // Also update the stored generic interface ASTs
  for (const interfaceName of interfacesToGenericize) {
    const interfaceAST = parseContext.genericInterfaceASTs.get(interfaceName)
    if (interfaceAST && interfaceAST.typeParameters) {
      const oldParamName = interfaceAST.typeParameters[0].name
      const defaultType = options.unknownAny ? T_UNKNOWN : T_ANY

      // Replace references to the old parameter name with 'T' in the interface body
      function replaceParamReferences(ast: AST): AST {
        if (ast.type === 'REFERENCE' && (ast as any).params === oldParamName) {
          return {
            ...ast,
            params: 'T',
          }
        }

        if (ast.type === 'ARRAY' && (ast as any).params) {
          return {
            ...ast,
            params: replaceParamReferences((ast as any).params),
          }
        }

        if (ast.type === 'INTERFACE' && Array.isArray((ast as any).params)) {
          return {
            ...ast,
            params: (ast as any).params.map((param: any) => ({
              ...param,
              ast: replaceParamReferences(param.ast),
            })),
          }
        }

        if ((ast.type === 'UNION' || ast.type === 'INTERSECTION') && Array.isArray((ast as any).params)) {
          return {
            ...ast,
            params: (ast as any).params.map((p: AST) => replaceParamReferences(p)),
          }
        }

        return ast
      }

      interfaceAST.params = interfaceAST.params.map(param => ({
        ...param,
        ast: replaceParamReferences(param.ast),
      }))

      interfaceAST.typeParameters = [
        {
          name: 'T',
          defaultType,
        },
      ]
      log('blue', 'parser', `  Updated stored interface ${interfaceName}: ${oldParamName} -> T`)
    }
  }

  // Phase 1: Make ALL generic interfaces actually use their type parameter
  // This includes both interfaces being genericized and interfaces already marked as generic
  log('blue', 'parser', `Updating generic interface bodies to use type parameters`)

  for (const [interfaceName, interfaceAST] of parseContext.genericInterfaceASTs.entries()) {
    if (interfaceAST.typeParameters && interfaceAST.typeParameters.length > 0) {
      const typeParamName = interfaceAST.typeParameters[0].name
      log('blue', 'parser', `  Updating ${interfaceName} body to use ${typeParamName} in children`)

      // Helper to recursively find and update children arrays
      function updateChildrenToUseTypeParam(ast: AST): AST {
        // If this is an array with unknown/any items, replace with type parameter
        if (ast.type === 'ARRAY') {
          const arrayAST = ast as any
          if (arrayAST.params && (arrayAST.params.type === 'UNKNOWN' || arrayAST.params.type === 'ANY')) {
            log('blue', 'parser', `    Found array with ${arrayAST.params.type}, replacing with ${typeParamName}`)
            return {
              ...ast,
              params: {
                type: 'REFERENCE' as const,
                params: typeParamName,
              },
            }
          }
        }

        // Recursively process INTERFACE params
        if (ast.type === 'INTERFACE' && Array.isArray((ast as any).params)) {
          return {
            ...ast,
            params: (ast as any).params.map((param: TInterfaceParam) => ({
              ...param,
              ast: updateChildrenToUseTypeParam(param.ast),
            })),
          }
        }

        return ast
      }

      // Update all interface parameters
      interfaceAST.params = interfaceAST.params.map(param => ({
        ...param,
        ast: updateChildrenToUseTypeParam(param.ast),
      }))

      log('blue', 'parser', `  Updated ${interfaceName} to use ${typeParamName} in children arrays`)
    }
  }
}

export function parseWithContext(
  schema: NormalizedJSONSchema | JSONSchema4Type,
  options: Options,
  preCollectedAnchorContexts?: Map<string, AnchorContext>,
): ParseResult {
  const parseContext: ParseContext = {
    genericInterfaces: new Map<string, string>(),
    genericInterfaceASTs: new Map<string, TInterface>(),
    typeAliases: new Map<string, TTypeAlias>(),
    anchorContexts: preCollectedAnchorContexts || new Map<string, AnchorContext>(),
    anchorToAliasMap: new Map<string, string>(),
  }

  // Pre-scan the schema to identify all interfaces that need type parameters
  if (!isPrimitive(schema)) {
    identifyGenericInterfaces(getRootSchema(schema as NormalizedJSONSchema), parseContext)
  }

  const ast = parse(schema, options, undefined, new Map(), new Set(), undefined, parseContext)

  // Post-process: Make generic interfaces truly generic (T = unknown) instead of field-specific
  genericizeInterfaces(parseContext, options)

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
      anchorContexts: new Map<string, AnchorContext>(),
      anchorToAliasMap: new Map<string, string>(),
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

          // Get the interface name - prefer $id or definition key for generic interface lookups
          // (genericInterfaces are registered using $id or definition key, not title)
          const baseMemberSchema = baseMember as NormalizedJSONSchema

          // Try to extract definition key from $ref if present
          let baseMemberKeyFromRef: string | null = null
          if (baseMemberSchema.$ref) {
            const refMatch = baseMemberSchema.$ref.match(/^#\/(?:\$defs|definitions)\/(.+)$/)
            if (refMatch) {
              baseMemberKeyFromRef = refMatch[1]
            }
          }

          // Also try to find in definitions by identity
          const baseMemberDefinitions = getDefinitionsMemoized(getRootSchema(baseMemberSchema))
          const baseMemberKeyFromDef = findKey(baseMemberDefinitions, _ => _ === baseMemberSchema)

          const interfaceName =
            (baseMemberSchema.$id ? toSafeString(baseMemberSchema.$id) : null) ||
            (baseMemberKeyFromRef ? toSafeString(baseMemberKeyFromRef) : null) ||
            (baseMemberKeyFromDef ? toSafeString(baseMemberKeyFromDef) : null) ||
            baseAST.standaloneName ||
            (baseAST.type === 'REFERENCE' && baseAST.params ? baseAST.params : null)

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
      // Check for:
      // - One member with empty items or a $ref to a generic interface (the base)
      // - One member with concrete properties (the override)
      if (schema.allOf!.length === 2) {
        // Helper to check if a member is a base (has empty items or is a $ref to a generic interface)
        const isBaseMember = (m: any): boolean => {
          // First check: does the schema itself have empty items?
          if (hasEmptyItemsSchema(m as NormalizedJSONSchema)) {
            return true
          }

          // Second check: if it has $id, recursively check its properties for empty items
          // This handles dereferenced schemas that haven't been marked as generic yet
          if (m.$id && m.properties) {
            for (const propValue of Object.values(m.properties as any)) {
              if (propValue && typeof propValue === 'object' && (propValue as any).properties) {
                if (hasEmptyItemsSchema(propValue as NormalizedJSONSchema)) {
                  return true
                }
              }
            }
          }

          // Third check: is it a $ref to a generic interface?
          if (m.$ref) {
            const refMatch = m.$ref.match(/^#\/(?:\$defs|definitions)\/(.+)$/)
            if (refMatch) {
              const refName = toSafeString(refMatch[1])

              // Check if already marked as generic
              if (parseContext?.genericInterfaces.has(refName)) {
                return true
              }
              // Also check if the referenced schema HAS empty items (will become generic)
              const definitions = getDefinitionsMemoized(getRootSchema(schema))
              const refSchema = definitions[refMatch[1]]

              if (refSchema && hasEmptyItemsSchema(refSchema as NormalizedJSONSchema)) {
                return true
              }
            }
          }

          // Fourth check: dereferenced schema with $id already marked as generic
          if (m.$id && parseContext?.genericInterfaces.has(toSafeString(m.$id))) {
            return true
          }

          return false
        }

        const baseMember = schema.allOf!.find(isBaseMember)
        const overrideMember = schema.allOf!.find((m: any) => m !== baseMember && m.properties)

        log(
          'blue',
          'parser',
          `Pattern 2: baseMember=${!!baseMember}, overrideMember=${!!overrideMember}, baseName=${baseMember && (baseMember as any).$id}`,
        )

        if (baseMember && overrideMember) {
          // Parse the base to get the interface
          const baseAST = parse(baseMember, options, undefined, processed, usedNames, undefined, parseContext)

          // Get the interface name - prefer $id or definition key for generic interface lookups
          // (genericInterfaces are registered using $id or definition key, not title)
          const baseMemberSchema = baseMember as NormalizedJSONSchema

          // Try to extract definition key from $ref if present
          let baseMemberKeyFromRef: string | null = null
          if (baseMemberSchema.$ref) {
            const refMatch = baseMemberSchema.$ref.match(/^#\/(?:\$defs|definitions)\/(.+)$/)
            if (refMatch) {
              baseMemberKeyFromRef = refMatch[1]
            }
          }

          // Also try to find in definitions by identity
          const baseMemberDefinitions = getDefinitionsMemoized(getRootSchema(baseMemberSchema))
          const baseMemberKeyFromDef = findKey(baseMemberDefinitions, _ => _ === baseMemberSchema)

          // Use baseAST.standaloneName first since that's the ACTUAL generated name
          // (it considers title, $id, and other factors via standaloneName())
          const interfaceName =
            baseAST.standaloneName ||
            (baseMemberSchema.$id ? toSafeString(baseMemberSchema.$id) : null) ||
            (baseMemberKeyFromRef ? toSafeString(baseMemberKeyFromRef) : null) ||
            (baseMemberKeyFromDef ? toSafeString(baseMemberKeyFromDef) : null) ||
            (baseAST.type === 'REFERENCE' && baseAST.params ? baseAST.params : null)

          // Check if this is a generic interface (already marked OR has empty items)
          // For $ref members, need to look up the actual schema in definitions
          let actualBaseSchema = baseMemberSchema
          if (baseMemberKeyFromRef) {
            const definitions = getDefinitionsMemoized(getRootSchema(schema))
            actualBaseSchema = (definitions[baseMemberKeyFromRef] || baseMemberSchema) as NormalizedJSONSchema
          }

          const baseMemberHasEmptyItems = hasEmptyItemsSchema(actualBaseSchema as NormalizedJSONSchema)
          const isGenericInterface =
            interfaceName &&
            typeof interfaceName === 'string' &&
            (parseContext?.genericInterfaces.has(interfaceName) || baseMemberHasEmptyItems)

          log('blue', 'parser', `Pattern 2: interfaceName=${interfaceName}, isGeneric=${isGenericInterface}`)

          // Check if this is a generic interface (has empty items)
          if (isGenericInterface) {
            // Look for the property override that provides the concrete type
            // Note: Don't pass anchorContext here - it will cause nested types to use self-references
            // The anchor context will be applied later when we create the type alias
            const typeArg = extractTypeArgumentFromOverride(
              overrideMember,
              options,
              processed,
              usedNames,
              parseContext,
              undefined, // anchorContext
            )

            if (typeArg) {
              // Check if this creates a recursive union that should be a type alias
              // Need to check within intersections too (for allOf constraint patterns)
              const hasGenericRef = (ast: AST): boolean => {
                if (ast.type === 'REFERENCE' && parseContext?.genericInterfaces.has((ast as any).params)) {
                  return true
                }
                if (ast.type === 'INTERSECTION' && Array.isArray((ast as any).params)) {
                  return (ast as any).params.some((p: AST) => hasGenericRef(p))
                }
                return false
              }

              const isRecursiveUnion =
                typeArg.type === 'UNION' && (typeArg as TUnion).params.some((p: AST) => hasGenericRef(p))

              // Get parent schema name - could be from parse context or from root schema
              const parentName = parseContext?.currentInterfaceName || (schema.$id && toSafeString(schema.$id))

              log(
                'blue',
                'parser',
                `Pattern 2: isRecursiveUnion=${isRecursiveUnion}, keyName=${keyName}, parentName=${parentName}, typeArg.type=${typeArg.type}, currentTypeAliasName=${parseContext?.currentTypeAliasName}`,
              )

              let finalTypeArg = typeArg

              // Check if we should use a type alias
              let typeAliasName: string | undefined
              let useTypeAlias = false

              // First priority: use currentTypeAliasName if set (from anyOf handler)
              if (parseContext?.currentTypeAliasName) {
                typeAliasName = parseContext.currentTypeAliasName
                useTypeAlias = true // Always use type alias from anyOf, regardless of recursion
                log('blue', 'parser', `Pattern 2: Using currentTypeAliasName from context: ${typeAliasName}`)
              } else if (isRecursiveUnion && keyName) {
                // Second priority: check if there's an anchor in the override and reuse its type alias
                // This enables type alias reuse across different fields with the same anchor
                // This works even for inline objects that don't have a parentName!
                const anchorName = extractAnchorNameFromOverride(overrideMember)
                const existingAliasForAnchor = anchorName ? parseContext?.anchorToAliasMap.get(anchorName) : undefined

                if (existingAliasForAnchor) {
                  // Reuse the existing type alias for this anchor
                  typeAliasName = existingAliasForAnchor
                  useTypeAlias = true
                  log(
                    'blue',
                    'parser',
                    `Pattern 2: REUSING existing type alias for anchor ${anchorName}: ${typeAliasName}`,
                  )
                } else if (anchorName) {
                  // Third priority: create type alias using anchor name (works even without parentName!)
                  typeAliasName = toSafeString(anchorName.charAt(0).toUpperCase() + anchorName.slice(1))

                  if (parseContext && !parseContext.typeAliases.has(typeAliasName)) {
                    log('blue', 'parser', `Creating recursive type alias for anchor ${anchorName}: ${typeAliasName}`)

                    const typeAlias: TTypeAlias = {
                      type: 'TYPE_ALIAS',
                      standaloneName: typeAliasName,
                      params: typeArg,
                      comment: `Recursive type alias for $dynamicAnchor "${anchorName}"`,
                    }

                    parseContext.typeAliases.set(typeAliasName, typeAlias)
                    parseContext.anchorToAliasMap.set(anchorName, typeAliasName)
                    log('blue', 'parser', `Registered anchor ${anchorName} -> type alias ${typeAliasName}`)
                  }
                  useTypeAlias = true
                } else if (parentName) {
                  // Fourth priority: create field-based type alias (requires parentName)
                  typeAliasName = parentName + toSafeString(keyName.charAt(0).toUpperCase() + keyName.slice(1))

                  if (parseContext && !parseContext.typeAliases.has(typeAliasName)) {
                    log('blue', 'parser', `Creating recursive type alias for allOf pattern: ${typeAliasName}`)

                    const typeAlias: TTypeAlias = {
                      type: 'TYPE_ALIAS',
                      standaloneName: typeAliasName,
                      params: typeArg,
                      comment: `Recursive type for ${parentName}.${keyName}`,
                    }

                    parseContext.typeAliases.set(typeAliasName, typeAlias)
                  }
                  useTypeAlias = true
                }
              }

              if (typeAliasName && useTypeAlias) {
                // Use reference to the type alias instead of the raw union
                finalTypeArg = {
                  type: 'REFERENCE',
                  params: typeAliasName,
                } as AST
                log('blue', 'parser', `Pattern 2: Using type alias ${typeAliasName} instead of raw union`)
              }

              log('blue', 'parser', `Creating generic instantiation: ${interfaceName}<...>`)
              return {
                comment: schema.description,
                deprecated: schema.deprecated,
                keyName,
                standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames, options),
                params: interfaceName,
                type: 'REFERENCE',
                typeArguments: [finalTypeArg],
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
    case 'ANY_OF': {
      // Debug: Check raw anyOf structure
      if (schema.anyOf && schema.anyOf.length > 0 && (schema.anyOf[0] as any).allOf) {
        const firstMember = schema.anyOf[0] as any
        log('blue', 'parser', `ANY_OF raw: has allOf with ${firstMember.allOf.length} members`)

        if (firstMember.allOf.length >= 2) {
          const override = firstMember.allOf[1]
          log('blue', 'parser', `  allOf[1] has properties: ${!!override.properties}`)

          if (override.properties && override.properties.root && override.properties.root.properties) {
            log('blue', 'parser', `  root.properties has children: ${!!override.properties.root.properties.children}`)

            if (override.properties.root.properties.children && override.properties.root.properties.children.items) {
              const items = override.properties.root.properties.children.items
              log(
                'blue',
                'parser',
                `  children.items has: $dynamicAnchor=${!!items.$dynamicAnchor}, oneOf=${!!items.oneOf}`,
              )
            }
          }
        }
      }

      // Check if this anyOf contains a nested $dynamicAnchor pattern
      // Pattern: anyOf contains allOf with Base + override containing $dynamicAnchor
      const nestedAnchor = findNestedDynamicAnchor(schema.anyOf!)

      log(
        'blue',
        'parser',
        `ANY_OF: nestedAnchor=${!!nestedAnchor}, keyName=${keyName}, currentInterface=${parseContext?.currentInterfaceName}`,
      )

      if (nestedAnchor && keyName && parseContext?.currentInterfaceName) {
        // Check if this anchor already has a type alias (for reuse across schema)
        let typeAliasName: string = parseContext.anchorToAliasMap.get(nestedAnchor.anchorName) || ''

        if (typeAliasName) {
          log(
            'blue',
            'parser',
            `Found nested $dynamicAnchor in anyOf for field ${keyName}, anchor=${nestedAnchor.anchorName}, REUSING existing type alias: ${typeAliasName}`,
          )
        } else {
          // Generate type alias for this field's recursive union
          // The alias represents the allowed children types for this field
          typeAliasName =
            parseContext.currentInterfaceName +
            toSafeString(keyName.charAt(0).toUpperCase() + keyName.slice(1)) +
            'Children'

          // Register this anchor -> alias mapping for future reuse
          parseContext.anchorToAliasMap.set(nestedAnchor.anchorName, typeAliasName)

          log(
            'blue',
            'parser',
            `Found nested $dynamicAnchor in anyOf for field ${keyName}, anchor=${nestedAnchor.anchorName}, CREATING new type alias: ${typeAliasName}`,
          )
        }

        // Get the allowed types from the pre-scanned anchor contexts
        const preScannedAnchor = parseContext.anchorContexts.get(nestedAnchor.anchorName)
        let effectiveAnchor = nestedAnchor
        if (preScannedAnchor) {
          log('blue', 'parser', `  Using pre-scanned allowed types: [${preScannedAnchor.allowedTypeNames.join(', ')}]`)
          effectiveAnchor = preScannedAnchor
        } else {
          log(
            'blue',
            'parser',
            `  WARNING: No pre-scanned anchor found for ${nestedAnchor.anchorName}, types: [${nestedAnchor.allowedTypeNames.join(', ')}]`,
          )
        }

        // Store the type alias name so nested patterns (like Pattern 2) can reference it
        parseContext.currentTypeAliasName = typeAliasName

        // Parse with the nested anchor context to generate the type alias
        let anyOfParams = schema.anyOf!.map((_, idx) => {
          log('blue', 'parser', `  Parsing anyOf member ${idx}`)
          const ast = parse(_, options, undefined, processed, usedNames, effectiveAnchor, parseContext)
          log('blue', 'parser', `  Result: type=${ast.type}, standaloneName=${(ast as any).standaloneName}`)

          // If we're in a nested anchor context, we need to instantiate generic interfaces
          // This can be either a direct INTERFACE or an INTERSECTION containing interfaces
          if (effectiveAnchor) {
            if (
              ast.type === 'INTERFACE' &&
              ast.standaloneName &&
              parseContext?.genericInterfaces.has(ast.standaloneName)
            ) {
              log(
                'blue',
                'parser',
                `Found generic interface ${ast.standaloneName} in anyOf with nested anchor, using type alias: ${typeAliasName}`,
              )
              return {
                params: ast.standaloneName,
                type: 'REFERENCE' as const,
                typeArguments: [
                  {
                    type: 'REFERENCE' as const,
                    params: typeAliasName,
                  },
                ],
              }
            } else if (ast.type === 'INTERSECTION' && Array.isArray((ast as any).params)) {
              log('blue', 'parser', `Found INTERSECTION in anyOf, checking for generic interfaces`)
              // Process intersection parts - instantiate any generic interfaces
              const intersectionParams = (ast as any).params.map((part: AST, partIdx: number) => {
                const refParams = part.type === 'REFERENCE' ? (part as any).params : undefined
                log(
                  'blue',
                  'parser',
                  `  Part ${partIdx}: type=${part.type}, refParams=${refParams}, isGeneric=${refParams && parseContext?.genericInterfaces.has(refParams)}`,
                )

                // Check if this is a REFERENCE to a generic interface
                if (part.type === 'REFERENCE' && refParams && parseContext?.genericInterfaces.has(refParams)) {
                  log(
                    'blue',
                    'parser',
                    `  Part ${partIdx}: generic interface reference ${refParams}, instantiating with ${typeAliasName}`,
                  )
                  return {
                    params: refParams,
                    type: 'REFERENCE' as const,
                    typeArguments: [
                      {
                        type: 'REFERENCE' as const,
                        params: typeAliasName,
                      },
                    ],
                  }
                }

                // Check if this is a standalone INTERFACE that's generic
                if (
                  part.type === 'INTERFACE' &&
                  part.standaloneName &&
                  parseContext?.genericInterfaces.has(part.standaloneName)
                ) {
                  log(
                    'blue',
                    'parser',
                    `  Part ${partIdx}: generic interface ${part.standaloneName}, instantiating with ${typeAliasName}`,
                  )
                  return {
                    params: part.standaloneName,
                    type: 'REFERENCE' as const,
                    typeArguments: [
                      {
                        type: 'REFERENCE' as const,
                        params: typeAliasName,
                      },
                    ],
                  }
                }

                log('blue', 'parser', `  Part ${partIdx}: not generic, keeping as-is`)
                return part
              })

              return {
                ...(ast as any),
                params: intersectionParams,
              }
            }
          }

          return ast
        })

        // Build the union of allowed types from the effective anchor
        // These are the actual node types like ParagraphNode, TextNode, etc.
        const allowedTypeRefs: AST[] = effectiveAnchor.allowedTypeNames.map(typeName => {
          // Build the base type reference
          let baseRef: AST

          // Check if this type is a generic interface
          if (parseContext.genericInterfaces.has(typeName)) {
            // Instantiate it with the type alias (for recursion)
            log('blue', 'parser', `  Allowed type ${typeName} is generic, instantiating with ${typeAliasName}`)
            baseRef = {
              params: typeName,
              type: 'REFERENCE' as const,
              typeArguments: [
                {
                  type: 'REFERENCE' as const,
                  params: typeAliasName,
                },
              ],
            }
          } else {
            log('blue', 'parser', `  Allowed type ${typeName} is not generic, plain reference`)
            baseRef = {
              params: typeName,
              type: 'REFERENCE' as const,
            }
          }

          // Check if there are constraints for this type from allOf patterns
          const constraintSchema = effectiveAnchor.typeConstraints?.get(typeName)
          if (constraintSchema && constraintSchema.properties) {
            log('blue', 'parser', `  Type ${typeName} has constraints, creating intersection`)

            // Build an interface AST directly from the constraint properties
            const constraintParams: TInterfaceParam[] = []
            for (const [propName, propSchema] of Object.entries(constraintSchema.properties)) {
              const propAST = parse(
                propSchema as NormalizedJSONSchema,
                options,
                propName,
                new Map(),
                new Set(),
                undefined,
                parseContext,
              )
              constraintParams.push({
                ast: propAST,
                isPatternProperty: false,
                isRequired: false,
                isUnreachableDefinition: false,
                keyName: propName,
              })
            }

            const constraintAST: TInterface = {
              type: 'INTERFACE' as const,
              params: constraintParams,
              superTypes: [],
            }

            // Return intersection of base type and constraints
            return {
              type: 'INTERSECTION' as const,
              params: [baseRef, constraintAST],
            }
          }

          return baseRef
        })

        const unionAST = {
          params: allowedTypeRefs,
          type: 'UNION' as const,
        }

        // Check if this creates a recursive union
        // Look for generic interfaces in the anyOf params or nested within intersections
        const hasGenericInterface = (ast: AST): boolean => {
          if (ast.type === 'REFERENCE' && parseContext?.genericInterfaces.has((ast as any).params)) {
            return true
          }
          if (ast.type === 'INTERSECTION' && Array.isArray((ast as any).params)) {
            return (ast as any).params.some((p: AST) => hasGenericInterface(p))
          }
          if (ast.type === 'UNION' && Array.isArray((ast as any).params)) {
            return (ast as any).params.some((p: AST) => hasGenericInterface(p))
          }
          return false
        }

        const hasGenericMembers = anyOfParams.some((p: AST) => hasGenericInterface(p))

        // Also check if the allowed types include generic interfaces
        // This handles the case where generic interfaces are in the field-level oneOf, not in anyOf params
        const hasGenericAllowedTypes = effectiveAnchor.allowedTypeNames.some(typeName =>
          parseContext.genericInterfaces.has(typeName),
        )

        log(
          'blue',
          'parser',
          `  hasGenericMembers=${hasGenericMembers}, hasGenericAllowedTypes=${hasGenericAllowedTypes}, anyOfParams count=${anyOfParams.length}`,
        )
        anyOfParams.forEach((p: AST, idx: number) => {
          log('blue', 'parser', `    param ${idx}: type=${p.type}`)
          if (p.type === 'INTERSECTION' && Array.isArray((p as any).params)) {
            ;(p as any).params.forEach((ip: AST, ipIdx: number) => {
              log(
                'blue',
                'parser',
                `      intersection part ${ipIdx}: type=${ip.type}, ${ip.type === 'REFERENCE' ? `params=${(ip as any).params}` : ''}`,
              )
            })
          }
        })

        // Create type alias if:
        // 1. It's recursive (hasGenericMembers or hasGenericAllowedTypes), OR
        // 2. There's a nested anchor (enables clean output for non-recursive cases too)
        if (
          (hasGenericMembers || hasGenericAllowedTypes || effectiveAnchor) &&
          !parseContext.typeAliases.has(typeAliasName)
        ) {
          log('blue', 'parser', `Creating field-level type alias: ${typeAliasName}`)
          log('blue', 'parser', `  Union has ${allowedTypeRefs.length} types`)
          allowedTypeRefs.forEach((ref, idx) => {
            log(
              'blue',
              'parser',
              `    Type ${idx}: ${(ref as any).params}, hasTypeArgs=${!!(ref as any).typeArguments}`,
            )
          })

          const typeAlias: TTypeAlias = {
            type: 'TYPE_ALIAS',
            standaloneName: typeAliasName,
            params: unionAST,
            comment: `Type alias for ${parseContext.currentInterfaceName}.${keyName}`,
          }

          parseContext.typeAliases.set(typeAliasName, typeAlias)
          log('blue', 'parser', `Type alias created, now replacing self-references in anyOf params`)

          // Replace self-referential generic type arguments with the type alias
          // This handles cases like Heading<Heading> -> Heading<TypeAliasName>
          function replaceSelfReferences(ast: AST): AST {
            if (ast.type === 'REFERENCE' && (ast as any).typeArguments) {
              const typeArgs = (ast as any).typeArguments as AST[]
              const newTypeArgs = typeArgs.map((arg: AST) => {
                // Replace self-referential types (e.g., Heading in Heading<Heading>)
                if (
                  arg.type === 'REFERENCE' &&
                  (arg as any).params === (ast as any).params &&
                  parseContext?.genericInterfaces.has((arg as any).params)
                ) {
                  return {
                    type: 'REFERENCE' as const,
                    params: typeAliasName,
                  }
                }
                return replaceSelfReferences(arg)
              })
              return {
                ...ast,
                typeArguments: newTypeArgs,
              }
            }

            if (ast.type === 'INTERFACE' && Array.isArray((ast as any).params)) {
              // Process interface parameters (each param has an ast field)
              return {
                ...ast,
                params: (ast as any).params.map((param: any) => ({
                  ...param,
                  ast: replaceSelfReferences(param.ast),
                })),
              }
            }

            if (ast.type === 'INTERSECTION' && Array.isArray((ast as any).params)) {
              return {
                ...ast,
                params: (ast as any).params.map((p: AST) => replaceSelfReferences(p)),
              }
            }

            if (ast.type === 'UNION' && Array.isArray((ast as any).params)) {
              return {
                ...ast,
                params: (ast as any).params.map((p: AST) => replaceSelfReferences(p)),
              }
            }

            if (ast.type === 'ARRAY' && (ast as any).params) {
              // Process array element types
              return {
                ...ast,
                params: replaceSelfReferences((ast as any).params),
              }
            }

            return ast
          }

          // Rewrite anyOfParams to use the type alias
          anyOfParams = anyOfParams.map(param => replaceSelfReferences(param))
        }

        // Return the anyOf union (which includes Base<TypeAlias> & {...} | null)
        return {
          comment: schema.description,
          deprecated: schema.deprecated,
          keyName,
          standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames, options),
          params: anyOfParams,
          type: 'UNION',
        }
      }

      // Default anyOf handling
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

      // Clear the current type alias name after processing
      if (parseContext && parseContext.currentTypeAliasName) {
        log('blue', 'parser', `Clearing currentTypeAliasName: ${parseContext.currentTypeAliasName}`)
        parseContext.currentTypeAliasName = undefined
      }

      return {
        comment: schema.description,
        deprecated: schema.deprecated,
        keyName,
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames, options),
        params: anyOfParams,
        type: 'UNION',
      }
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

        // Ensure the generic interface is stored before converting to REFERENCE
        if (parseContext && !parseContext.genericInterfaceASTs.has(ast.standaloneName)) {
          const hasTypeParams = !!(ast as TInterface).typeParameters
          log(
            'blue',
            'parser',
            `Storing ${ast.standaloneName}: hasTypeParams=${hasTypeParams}, typeParams=${JSON.stringify((ast as TInterface).typeParameters)}`,
          )
          parseContext.genericInterfaceASTs.set(ast.standaloneName, ast as TInterface)
          log('blue', 'parser', `Stored generic interface ${ast.standaloneName} before converting to REFERENCE`)
        }

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
        parseContext,
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

  const needsTypeParam = schemaNeedsTypeParameter(schema)

  if (name && needsTypeParam) {
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
    } else {
      // Either hasEmptyItemsSchema or nested $dynamicRef
      // Use a default type parameter T
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
  if (name && typeParameters && parseContext) {
    if (!parseContext.genericInterfaceASTs.has(name)) {
      parseContext.genericInterfaceASTs.set(name, interfaceAST)
      log('blue', 'parser', `Stored generic interface ${name} for later emission`)
    } else {
      log('blue', 'parser', `Generic interface ${name} already stored, skipping`)
    }
  } else if (name && typeParameters) {
    log('blue', 'parser', `Would store generic interface ${name} but parseContext is missing`)
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
