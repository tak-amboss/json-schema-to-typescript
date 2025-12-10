# Post-Process Genericization for Shared Nodes

## Problem

When using `$dynamicAnchor` to define field-level type constraints, nodes that are shared across multiple fields would get "locked" to a specific field's context instead of being truly generic.

**Example:**

```json
{
  "properties": {
    "basicText": {
      "allOf": [
        { "$ref": "#/$defs/Base" },
        {
          "properties": {
            "root": {
              "properties": {
                "children": {
                  "items": {
                    "$dynamicAnchor": "basicTextTypes",
                    "oneOf": [
                      { "$ref": "#/$defs/Para" },
                      { "$ref": "#/$defs/Text" },
                      { "$ref": "#/$defs/Root" }
                    ]
                  }
                }
              }
            }
          }
        }
      ]
    },
    "headingOnly": {
      "allOf": [
        { "$ref": "#/$defs/Base" },
        {
          "properties": {
            "root": {
              "properties": {
                "children": {
                  "items": {
                    "$dynamicAnchor": "headingOnlyTypes",
                    "oneOf": [
                      { "$ref": "#/$defs/Heading" },
                      { "$ref": "#/$defs/Text" },
                      { "$ref": "#/$defs/Root" }
                    ]
                  }
                }
              }
            }
          }
        }
      ]
    }
  },
  "$defs": {
    "Root": {
      "type": "object",
      "properties": {
        "type": { "const": "root" },
        "children": {
          "type": "array",
          "items": { "$dynamicRef": "#basicTextTypes" }
        }
      }
    }
  }
}
```

**Before (Incorrect):**

```typescript
export interface Root<TBasicTextTypes = Para | Text | Root> {
  type?: "root";
  children?: TBasicTextTypes[];
}
```

The problem: `Root` gets locked to the `basicText` context (`TBasicTextTypes`), but it's also used in `headingOnly` which has different allowed children.

**After (Correct):**

```typescript
export interface Root<T = unknown> {
  type?: "root";
  children?: T[];
}
```

The solution: `Root` is truly generic and can be instantiated with any type parameter.

## Solution: Post-Processing Approach

Instead of trying to detect shared nodes during initial parsing, we use a **post-processing step** after the AST is built:

### Algorithm

1. **Parse normally** - Generate all type aliases and generic interfaces with field-specific defaults
2. **Scan type aliases** - Walk all generated type aliases to find which interfaces are referenced where
3. **Identify shared nodes** - Track which interfaces appear in multiple type alias contexts
4. **Genericize shared nodes** - For interfaces used in 2+ contexts:
   - Replace type parameter with generic `T = unknown`
   - Update all references to the old parameter name in the interface body
5. **Preserve field-specific nodes** - Interfaces used in only one context keep their specific defaults

### Implementation

```typescript
function genericizeInterfaces(parseContext: ParseContext, options: Options): void {
  // Track which interfaces appear in which type aliases (anchor contexts)
  const interfaceUsage = new Map<string, Set<string>>()
  
  // Scan all type aliases to find interface references
  for (const [typeAliasName, typeAlias] of parseContext.typeAliases.entries()) {
    // ... walk type alias AST to find referenced generic interfaces ...
    // ... add to interfaceUsage map ...
  }
  
  // Genericize interfaces that are used in MULTIPLE type aliases
  const interfacesToGenericize = new Set<string>()
  for (const [interfaceName, typeAliases] of interfaceUsage.entries()) {
    if (typeAliases.size > 1) {
      interfacesToGenericize.add(interfaceName)
    }
  }
  
  // Update stored generic interface ASTs
  for (const interfaceName of interfacesToGenericize) {
    const interfaceAST = parseContext.genericInterfaceASTs.get(interfaceName)
    if (interfaceAST && interfaceAST.typeParameters) {
      const oldParamName = interfaceAST.typeParameters[0].name
      const defaultType = options.unknownAny ? T_UNKNOWN : T_ANY
      
      // Replace references to old parameter name with 'T'
      interfaceAST.params = interfaceAST.params.map(param => ({
        ...param,
        ast: replaceParamReferences(param.ast, oldParamName, 'T'),
      }))
      
      // Update type parameter
      interfaceAST.typeParameters = [{ name: 'T', defaultType }]
    }
  }
}
```

### Integration Point

The function is called in `parseWithContext()` after the main `parse()` completes but before returning:

```typescript
export function parseWithContext(...): ParseResult {
  // ... initialize parseContext ...
  // ... pre-scan for generic interfaces ...
  
  const ast = parse(schema, options, undefined, new Map(), new Set(), undefined, parseContext)
  
  // Post-process: Make generic interfaces truly generic (T = unknown) instead of field-specific
  genericizeInterfaces(parseContext, options)
  
  return {ast, parseContext}
}
```

## Benefits

1. **Clean separation** - Genericization is a separate concern from parsing
2. **No top-down tracking** - Don't need to track context during parsing
3. **Automatically detects shared nodes** - No manual configuration required
4. **Preserves field-specific types** - Single-use interfaces keep their context
5. **Easy to understand** - Post-processing is easier to reason about than complex parsing logic

## Test Results

All 173 tests pass. Example changes in snapshots:

**Before:**
```typescript
export interface ParagraphNode<TBasicTextAllowedTypes = ParagraphNode | TextNode> {
  type: "paragraph";
  children: TBasicTextAllowedTypes[];
}
```

**After:**
```typescript
export interface ParagraphNode<T = unknown> {
  type: "paragraph";
  children: T[];
}
```

This change occurs because `ParagraphNode` is used in multiple type alias contexts (e.g., `basicText` and `richContent`), so it's automatically genericized.

## Commit

Commit ID: `0be31c3381ba67084b768e85deffe92126390ed0`
Branch: `feature/dynamic-ref-support`
Remote: `fork` (https://github.com/tak-amboss/json-schema-to-typescript.git)

