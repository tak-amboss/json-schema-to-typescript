# $dynamicRef and $dynamicAnchor Support

## Overview

This fork adds support for JSON Schema Draft 2020-12's `$dynamicRef` and `$dynamicAnchor` keywords, enabling context-dependent recursive types in TypeScript.

## Implementation Status

✅ **Fully Implemented and Test-Covered**

- Basic `$dynamicRef` and `$dynamicAnchor` parsing
- Generic type parameter generation for interfaces with `$dynamicRef`
- Context-dependent type resolution via anchor contexts
- Global collection and emission of generic interfaces
- Proper handling of inline vs standalone schemas
- External file references support
- Deduplication of interface declarations
- **Self-referential generic parameter usage** (Issue #2 - Dec 2, 2025)
- **Generic instantiation for `allOf` patterns** (Issue #4 - Dec 2, 2025)
- **Recursive type aliases for complex unions** (Issue #3 - Dec 2, 2025)

## How It Works

### 1. Pre-Scanning Phase
`identifyGenericInterfaces()` scans the schema to identify which interfaces need generic type parameters based on `$dynamicRef` usage.

### 2. Parsing Phase
- **Generic Interfaces**: Interfaces containing `$dynamicRef` are parsed with self-referential anchor context to use type parameters (e.g., `TAllowedNodes[]`)
- **Anchor Contexts**: When parsing a `$dynamicAnchor`, we create an `AnchorContext` with the allowed types and pass it down
- **Context Collection**: All generic interfaces are stored in `ParseContext.genericInterfaceASTs` for global emission
- **Recursive Type Aliases**: Properties with `$dynamicAnchor` + `oneOf`/`anyOf` generate type aliases stored in `ParseContext.typeAliases`

### 3. Generation Phase
- **Type Alias Emission**: `declareTypeAliases()` emits recursive type aliases first (replaces generic instantiations with self-references)
- **Generic Interface Emission**: `declareCollectedGenericInterfaces()` emits all generic interfaces
- **Deduplication**: Tracks declared interface names to prevent duplicate emissions
- **Instantiation**: When referencing a generic interface from within an anchor context, generates instantiated types (e.g., `TreeNode<TreeNode>`)

## Test Coverage

- `test/e2e/dynamicRef.1.ts`: Basic context-dependent recursive types
- `test/e2e/dynamicRef.2.ts`: Deeper recursive structures
- `test/e2e/dynamicRef.3.ts`: External file generic interface references
- `test/e2e/dynamicRef.4.ts`: Self-referential generic parameter usage (Issue #2)
- `test/e2e/dynamicRef.5.ts`: Recursive unions without type aliases (Issue #3)
- `test/e2e/dynamicRef.6.ts`: `allOf` generic instantiation pattern (Issue #4)

## Recently Resolved Issues (Dec 2, 2025)

### ✅ Issue #2: Self-Referential Generic Parameter Usage

**Fixed**: Generic interfaces with `$dynamicAnchor` now correctly use their type parameter in properties with `$dynamicRef`.

**Example**:
```typescript
// Before: children?: (SerializedParagraphNode | SerializedTextNode)[]
// After:  children?: TAllowedNodeTypes[]
export interface SerializedParagraphNode<TAllowedNodeTypes = SerializedParagraphNode | SerializedTextNode> {
  type?: "paragraph";
  children?: TAllowedNodeTypes[];  // ✅ Uses generic parameter
}
```

**Solution**: When parsing a generic interface with `$dynamicAnchor`, create a self-referential anchor context that points to the type parameter name.

### ✅ Issue #4: `allOf` Generic Instantiation

**Fixed**: `allOf` patterns with `$dynamicAnchor` now generate proper generic instantiation instead of nonsensical intersections.

**Example**:
```typescript
// Before: Base<Base> & (string | number)
// After:  Base<string | number>
export type Issue4Test = Base<string | number>;  // ✅ Proper instantiation
```

**Solution**: Detect the `allOf` pattern where one member is a generic interface reference and another has `$dynamicAnchor`, then create a REFERENCE with type arguments instead of INTERSECTION.

### ✅ Issue #3: Recursive Type Aliases for Complex Unions

**Fixed**: Properties with `$dynamicAnchor` and `oneOf`/`anyOf` now generate named recursive type aliases instead of inlining the union.

**Example**:
```typescript
// Before:
export interface Issue3Test {
  content?: TextNode | ParagraphNode<ParagraphNode>;  // ❌ Loses TextNode in recursive children
}

// After:
export type Issue3TestContent = TextNode | ParagraphNode<Issue3TestContent>;  // ✅ Self-referential
export interface Issue3Test {
  content?: Issue3TestContent;  // ✅ Uses type alias
}
```

**Solution**: 
1. Added `TTypeAlias` AST node type
2. Detect recursive union patterns in `parseSchema()` when parsing properties
3. Generate type alias name from parent interface and property name
4. Store type aliases in `ParseContext.typeAliases`
5. Replace generic instantiations with self-references in `generateRecursiveType()`
6. Emit type aliases before interfaces in `generate()`

**Benefits**:
- Type information preserved at all nesting levels
- Better readability and DRY principle
- Improved IDE autocomplete for nested structures
- Reusable type definitions

## Known Limitations

### Limitation: Default Type is `unknown` Instead of `any`

Generic type parameters default to `unknown` rather than `any`.

**Current**: `interface Base<T = unknown> { ... }`
**Desired**: `interface Base<T = any> { ... }`

**Workaround**: The types work correctly; `unknown` is actually more type-safe.

**Priority**: Very Low (cosmetic, could be made configurable)

## Architecture

### Key Files

- `src/types/JSONSchema.ts`: Extended with `$dynamicRef` and `$dynamicAnchor` properties
- `src/types/AST.ts`: Added `TDynamicReference`, `TTypeAlias`, and `typeParameters`/`typeArguments` support
- `src/typesOfSchema.ts`: Added `DYNAMIC_REFERENCE` matcher
- `src/parser.ts`: Core implementation with `parseWithContext()`, anchor context tracking, generic interface collection, and recursive type alias detection
- `src/generator.ts`: Modified to emit type aliases, collected generic interfaces, and handle instantiation with self-references
- `src/index.ts`: Updated to use `parseWithContext()` and pass context to generator

### Key Data Structures

**ParseContext**:
```typescript
interface ParseContext {
  genericInterfaces: Map<string, string>  // interface name -> type param name
  genericInterfaceASTs: Map<string, TInterface>  // collected generic interfaces
  typeAliases: Map<string, TTypeAlias>  // collected recursive type aliases
  currentInterfaceName?: string  // for tracking parsing context
}
```

**AnchorContext**:
```typescript
interface AnchorContext {
  anchorName: string  // e.g., "allowedNodes"
  allowedTypeNames: string[]  // e.g., ["TreeNode", "LeafNode"]
}
```

**TTypeAlias** (AST node):
```typescript
interface TTypeAlias {
  type: 'TYPE_ALIAS'
  standaloneName: string  // e.g., "Issue3TestContent"
  params: AST  // the union or other type
  comment?: string
}
```

## Future Improvements

1. ✅ ~~Implement proper generic instantiation for `allOf` compositions~~ (Completed Dec 2, 2025)
2. ✅ ~~Self-referential generic parameter usage~~ (Completed Dec 2, 2025)
3. ✅ ~~Generate named recursive type aliases for complex unions~~ (Completed Dec 2, 2025)
4. Make default type (`any` vs `unknown`) configurable
5. Optimize type parameter detection to handle more edge cases
6. Support for multiple `$dynamicAnchor` names in a single schema

## Post-Processing No Longer Needed

With all critical issues (#2, #3, #4) resolved, the fork now correctly generates:
- Self-referential generic parameters (`children?: TAllowedNodeTypes[]`)
- Proper `allOf` instantiation (`Base<string | number>`)
- Recursive type aliases (`type Alias = A | B<Alias>`)

This **completely eliminates** the need for post-processing scripts. The generated TypeScript types are production-ready and match the expected behavior for context-dependent recursive types.
