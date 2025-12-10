# Field Simplification: All Phases Complete! ✅

## Summary

Successfully implemented all three phases to achieve clean, idiomatic TypeScript output for `$dynamicAnchor` patterns.

---

## Before (Initial State)

```typescript
// Base interface didn't use type parameter
export interface Base<T = unknown> {
  root?: {
    children?: unknown[];  // ❌ Not using T
  };
}

// Field had verbose inline expansion
export interface Schema {
  field?: Base<NodeA<FieldChildren> | NodeB>;  // ❌ Raw union
}
```

**With Constraints:**
```typescript
// Constraints in field, not in type alias
export type FieldChildren = NodeA<FieldChildren> | TextNode;  // ❌ No constraints

field?: Base & {  // ❌ Intersection + inline expansion
  root?: {
    children?: (
      | (NodeA<FieldChildren> & { constraint: "value"; })
      | TextNode
    )[];
  };
};
```

---

## After (All Phases Complete)

```typescript
// ✅ Base uses type parameter
export interface Base<T = unknown> {
  root?: {
    children?: T[];  // ✅ Uses T!
  };
}

// ✅ Type alias includes constraints
export type FieldChildren =
  | (HeadingNode<FieldChildren> & { tag?: "h2" | "h3"; })
  | TextNode;

// ✅ Field is clean and uses type alias
export interface Schema {
  field?: Base<FieldChildren> | null;  // ✅ Perfect!
}
```

---

## Phase 1: Generic Interfaces Use Type Parameter

**Commit:** `75d3798c09bc54ac1590efa8961676e71f0ba4ca`

### Problem
Generic interfaces had `<T = unknown>` but their body still used `unknown[]` instead of `T[]`.

### Solution
Post-processing in `genericizeInterfaces()` to update ALL generic interface bodies:
- Recursively walk interface params
- Find arrays with UNKNOWN/ANY items
- Replace with REFERENCE to type parameter

### Impact
```typescript
// Before:
export interface Base<T = unknown> {
  children?: unknown[];  // ❌
}

// After:
export interface Base<T = unknown> {
  children?: T[];  // ✅
}
```

---

## Phase 2: Use Type Aliases in Pattern 2

**Commit:** `764cf92e88e8188d669ede76d57e8dfe6d15a13e`

### Problem
Pattern 2 (allOf with Base + override) instantiated Base with raw unions instead of type aliases created by anyOf.

### Solution
- Added `currentTypeAliasName` to ParseContext
- anyOf handler sets it before parsing members
- Pattern 2 checks and uses it if present
- Clears it after anyOf completes

### Impact
```typescript
// Before:
field?: Base<NodeA<TypeAlias> | NodeB>  // ❌ Raw union

// After:
field?: Base<TypeAlias>  // ✅ Uses alias!
```

---

## Phase 3: Fix Recursive Union Detection for Constraints

**Commit:** `7971801fdaa421624ef8f0711416b3b0601c9d62`

### Problem
When oneOf items had allOf constraints, the `isRecursiveUnion` check failed because it only looked for direct REFERENCE types, missing those nested in INTERSECTIONs.

### Solution
Extended `isRecursiveUnion` to recursively check within intersections:
```typescript
const hasGenericRef = (ast: AST): boolean => {
  if (ast.type === 'REFERENCE' && isGeneric(ast)) return true
  if (ast.type === 'INTERSECTION') {
    return ast.params.some(p => hasGenericRef(p))  // ✅ Recursive
  }
  return false
}
```

### Impact
```typescript
// Before:
field?: Base<
  | (Node<TypeAlias> & { constraint })  // ❌ Inline expansion
  | Text
>

// After:
field?: Base<TypeAlias>  // ✅ Clean!
```

---

## Combined Feature: allOf Constraints in Type Aliases

**Commit:** `87276e392f64febe028c76b2b99f5581f4076c5f`

### What It Does
Extracts allOf constraint patterns from oneOf items and includes them in the type alias.

### Impact
```typescript
// oneOf with allOf constraint:
{
  "oneOf": [{
    "allOf": [
      { "$ref": "#/$defs/HeadingNode" },
      { "properties": { "tag": { "enum": ["h2", "h3"] } } }
    ]
  }]
}

// Generates:
export type TypeAlias =
  | (HeadingNode<TypeAlias> & { tag?: "h2" | "h3"; })  // ✅ Constraint included
  | ...;
```

---

## Final Output Example

### Input Schema
```json
{
  "field": {
    "anyOf": [{
      "allOf": [
        { "$ref": "#/$defs/Base" },
        {
          "properties": {
            "root": {
              "properties": {
                "children": {
                  "items": {
                    "$dynamicAnchor": "fieldTypes",
                    "oneOf": [{
                      "allOf": [
                        { "$ref": "#/$defs/HeadingNode" },
                        { "properties": { "tag": { "enum": ["h2", "h3"] } } }
                      ]
                    }]
                  }
                }
              }
            }
          }
        }
      ]
    }]
  }
}
```

### Generated Output
```typescript
/**
 * Recursive type alias for Schema.field
 */
export type SchemaFieldChildren =
  | (HeadingNode<SchemaFieldChildren> & { tag?: "h2" | "h3"; })
  | TextNode;

export interface Base<T = unknown> {
  root?: {
    children?: T[];
  };
}

export interface HeadingNode<TConstrainedTypes = TextNode> {
  type?: "heading";
  tag?: string;
  children?: TConstrainedTypes[];
}

export interface Schema {
  field?: Base<SchemaFieldChildren> | null;  // ✅ Perfect!
}
```

---

## Benefits

1. **Clean Output** - No redundant inline expansions
2. **Idiomatic TypeScript** - Uses generics properly
3. **Type Aliases Work** - Complete with constraints
4. **Reusable Types** - Type aliases are self-contained
5. **Better DX** - Easier to read and understand

---

## Test Results

✅ All 174 tests pass

---

## Commits Summary

1. **Phase 1:** `75d3798` - Generic interfaces use type parameter
2. **Phase 2:** `764cf92` - Pattern 2 uses type aliases
3. **Phase 3:** `7971801` - Fix recursive detection for constraints
4. **Constraints:** `87276e3` - Include allOf constraints in type aliases

Branch: `feature/dynamic-ref-support`
Fork: https://github.com/tak-amboss/json-schema-to-typescript.git

---

## What This Means for Your CMS

You can now use the pattern:

```json
{
  "basicText": {
    "anyOf": [{
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
                      { "$ref": "#/$defs/ParagraphNode" },
                      { 
                        "allOf": [
                          { "$ref": "#/$defs/ListNode" },
                          { "properties": { "listType": { "const": "number" } } }
                        ]
                      }
                    ]
                  }
                }
              }
            }
          }
        }
      ]
    }]
  }
}
```

And get:

```typescript
export type BasicTextChildren =
  | ParagraphNode<BasicTextChildren>
  | (ListNode<BasicTextChildren> & { listType?: "number"; })
  | ...;

export interface Base<T = unknown> {
  root?: { children?: T[]; };
}

export interface Schema {
  basicText?: Base<BasicTextChildren> | null;  // ✅ Clean!
}
```

Perfect for CMS use cases with multiple rich text fields! 🎉

