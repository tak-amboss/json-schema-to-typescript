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

## Known Limitations

### Limitation 1: allOf with $dynamicAnchor

When `allOf` is combined with `$dynamicAnchor`, the output uses intersection types instead of generic instantiation.

**Example**:
```typescript
// Current output:
export interface Field extends Base & (string | number) { ... }

// Desired output:
export interface Field extends Base<string | number> { ... }
```

**Workaround**: Use composition instead of `allOf` where possible.

**Priority**: Low (edge case, workaround available)

### Limitation 2: No Named Recursive Type Aliases

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

**Priority**: Low (DRY principle, readability improvement)

### Limitation 3: Default Type is `unknown` Instead of `any`

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

1. Implement proper generic instantiation for `allOf` compositions
2. Generate named recursive type aliases for complex unions
3. Make default type (`any` vs `unknown`) configurable
4. Optimize type parameter detection to handle more edge cases
