# $dynamicRef Implementation TODO

## ✅ Completed

1. **Basic $dynamicRef and $dynamicAnchor support**
   - Added JSON Schema types for `$dynamicRef` and `$dynamicAnchor`
   - Created AST types for dynamic references
   - Implemented context tracking during parsing

2. **Generic type parameter generation**
   - Interfaces with `$dynamicRef` get generic type parameters
   - Type parameters have appropriate default types
   - Pre-scanning identifies generic interfaces

3. **Context-dependent type resolution**
   - `$dynamicAnchor` creates anchor contexts
   - `$dynamicRef` resolves to context-specific types
   - Proper instantiation of generic interfaces

4. **Inline vs standalone schema handling**
   - Inline schemas use default types directly
   - Standalone interfaces use type parameters
   - No undefined type parameter references

5. **Architectural fix for instantiation**
   - Use REFERENCE nodes with typeArguments instead of modifying interfaces
   - Base generic interfaces preserved in AST
   - Clean separation between declarations and usage

6. **Global generic interface collection** (Dec 1, 2025)
   - Added `ParseContext.genericInterfaceASTs` to track all generic interfaces
   - Created `parseWithContext()` that returns AST and context
   - Modified `generate()` to accept parseContext
   - Added `declareCollectedGenericInterfaces()` to emit all collected interfaces
   - Generic interfaces parse without anchor context to preserve type parameters
   - Works correctly for external file references

## 🔴 Critical Issues Remaining

**None!** All critical issues are resolved.

## 🟡 Known Limitations

### Limitation 1: allOf with $dynamicAnchor Composition

**Problem**: When using `allOf` to compose a base schema with a `$dynamicAnchor`, the output uses intersection types instead of proper generic instantiation.

**Example**:
```typescript
// Current output:
export type Field = Base & (string | number);  // ❌ Confusing

// Expected output:
export type Field = Base<string | number>;  // ✅ Clear
```

**Priority**: Medium (works but not ergonomic)

## 📋 Test Coverage Needed

- [ ] External file generic interfaces (Issue 1)
- [ ] allOf with $dynamicAnchor composition (Issue 2)
- [ ] Multiple $dynamicAnchors in one schema
- [ ] Deeply nested $dynamicRef resolution
- [ ] $dynamicRef without matching $dynamicAnchor (fallback behavior)
- [ ] Cross-file $dynamicRef chains

## 🔧 Implementation Notes

### Key Files
- `src/parser.ts`: Core parsing logic, context tracking, generic interface identification
- `src/generator.ts`: TypeScript code generation, interface/type alias emission
- `src/types/AST.ts`: AST type definitions
- `src/types/JSONSchema.ts`: JSON Schema type extensions

### Important Functions
- `identifyGenericInterfaces()`: Pre-scans schema to find interfaces needing type parameters
- `parseDynamicReference()`: Resolves $dynamicRef based on context
- `newInterface()`: Creates interface AST with optional type parameters
- `declareNamedInterfaces()`: Walks AST to emit interface declarations

