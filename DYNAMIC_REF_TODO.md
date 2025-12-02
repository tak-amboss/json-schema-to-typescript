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

## How It Works

### 1. Pre-Scanning Phase
`identifyGenericInterfaces()` scans the schema to identify which interfaces need generic type parameters based on `$dynamicRef` usage.

### 2. Parsing Phase
- **Generic Interfaces**: Interfaces containing `$dynamicRef` are parsed WITHOUT anchor context to preserve type parameter references (e.g., `TAllowedNodes[]`)
- **Anchor Contexts**: When parsing a `$dynamicAnchor`, we create an `AnchorContext` with the allowed types and pass it down
- **Context Collection**: All generic interfaces are stored in `ParseContext.genericInterfaceASTs` for global emission

### 3. Generation Phase
- **Global Emission**: `declareCollectedGenericInterfaces()` emits all generic interfaces first
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

## Known Limitations

### Limitation 1: No Named Recursive Type Aliases

Complex recursive unions are inlined rather than extracted into named type aliases.

**Example**:
```typescript
// Current:
export interface Field {
  content1?: TextNode | ParagraphNode<TextNode | ParagraphNode>;
  content2?: TextNode | ParagraphNode<TextNode | ParagraphNode>;  // Duplicated
}

// Desired:
export type FieldAllowedTypes = TextNode | ParagraphNode<FieldAllowedTypes>;
export interface Field {
  content1?: FieldAllowedTypes;
  content2?: FieldAllowedTypes;
}
```

**Workaround**: The duplicated types are semantically identical and work correctly.

**Priority**: Medium (readability, type safety at depth 2+)

**Status**: Documented as future enhancement. This requires significant changes:
- New AST node type `TTypeAlias`
- Detection of recursive patterns
- Name generation for type aliases (e.g., `FieldContentChildren`)
- Generator changes to emit type aliases before interfaces

### Limitation 2: Default Type is `unknown` Instead of `any`

Generic type parameters default to `unknown` rather than `any`.

**Current**: `interface Base<T = unknown> { ... }`
**Desired**: `interface Base<T = any> { ... }`

**Workaround**: The types work correctly; `unknown` is actually more type-safe.

**Priority**: Very Low (cosmetic)

## Architecture

### Key Files

- `src/types/JSONSchema.ts`: Extended with `$dynamicRef` and `$dynamicAnchor` properties
- `src/types/AST.ts`: Added `TDynamicReference` type and `typeParameters`/`typeArguments` support
- `src/typesOfSchema.ts`: Added `DYNAMIC_REFERENCE` matcher
- `src/parser.ts`: Core implementation with `parseWithContext()`, anchor context tracking, and generic interface collection
- `src/generator.ts`: Modified to emit collected generic interfaces and handle instantiation
- `src/index.ts`: Updated to use `parseWithContext()` and pass context to generator

### Key Data Structures

**ParseContext**:
```typescript
interface ParseContext {
  genericInterfaces: Map<string, string>  // interface name -> type param name
  genericInterfaceASTs: Map<string, TInterface>  // collected generic interfaces
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

## Future Improvements

1. ✅ ~~Implement proper generic instantiation for `allOf` compositions~~ (Completed Dec 2, 2025)
2. ✅ ~~Self-referential generic parameter usage~~ (Completed Dec 2, 2025)
3. Generate named recursive type aliases for complex unions (Issue #3 - significant architectural change)
4. Make default type (`any` vs `unknown`) configurable
5. Optimize type parameter detection to handle more edge cases

## Post-Processing No Longer Needed

With Issues #2 and #4 resolved, the fork now correctly generates:
- Self-referential generic parameters (`children?: TAllowedNodeTypes[]`)
- Proper `allOf` instantiation (`Base<string | number>`)

This eliminates the need for post-processing scripts that previously fixed these issues. Only Issue #3 (recursive type aliases) remains unimplemented, which is a readability enhancement rather than a correctness issue.
