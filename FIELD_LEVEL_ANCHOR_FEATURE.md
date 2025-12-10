# Feature Request: Field-Level `$dynamicAnchor` Support

## Status: ✅ **IMPLEMENTED** (Commit 0be31c3)

> **Solution:** Post-processing genericization approach.  
> See `POST_PROCESS_GENERICIZATION.md` for implementation details.

## Summary

Generate recursive type aliases from **field-level** `$dynamicAnchor` only (in override `items`), keeping node definitions generic without field-specific defaults.

## Test Results

### Input Schema (No `$dynamicAnchor` in nodes)

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
                    "$dynamicAnchor": "basicTextAllowedTypes",  // ← ONLY here
                    "oneOf": [
                      { "$ref": "#/$defs/Paragraph" },
                      { "$ref": "#/$defs/Text" }
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
    "Paragraph": {
      // NO $dynamicAnchor here
      "properties": {
        "children": { "items": {} }  // Empty items
      }
    }
  }
}
```

### Current Output

```typescript
// ✅ GOOD: Nodes are generic
export interface Paragraph<T = unknown> {
  type?: "paragraph";
  children?: T[];
}

export interface Root<T = unknown> {
  type?: "root";
  children?: T[];
}

// ❌ BAD: No type alias generated
// (Expected: export type MultiFieldExampleBasicTextChildren = ...)

// ❌ BAD: Self-references in inline types
export interface MultiFieldExample {
  basicText?: Base & {
    root?: {
      children?: (
        Paragraph<Paragraph | Text | Root> |  // ← Should be Paragraph<TypeAlias>
        Text |
        Root<Paragraph | Text | Root>         // ← Should be Root<TypeAlias>
      )[];
    };
  };
  
  headingOnly?: Base & {
    root?: {
      children?: (
        Heading<Heading | Text | Root> |
        Text |
        Root<Paragraph | Text | Root>  // ❌ WRONG: Uses basicText's types!
      )[];
    };
  };
}
```

## Root Cause

The current implementation detects recursive patterns by:

1. **Pre-scanning** for nodes with `$dynamicAnchor` + `$dynamicRef`
2. **Registering** those nodes as generic interfaces
3. **Creating type aliases** when fields reference those generic nodes

**Problem**: If nodes don't have `$dynamicAnchor`/`$dynamicRef`, the system doesn't recognize the pattern.

The field-level `$dynamicAnchor` is detected (for pre-collection), but without `$dynamicRef` in nodes, the fork doesn't know:
- Which nodes should use the field's type alias
- That this creates a recursive pattern
- That a type alias should be generated

## What Would Need to Change

### 1. Enhanced Pattern Detection

When finding field-level `$dynamicAnchor` with `oneOf` in override:

```typescript
// In findNestedDynamicAnchor() or similar
{
  "items": {
    "$dynamicAnchor": "fieldTypes",
    "oneOf": [
      { "$ref": "#/$defs/NodeA" },
      { "$ref": "#/$defs/NodeB" }
    ]
  }
}
```

**Action**: Mark this as a "field-level recursive pattern" that needs a type alias.

### 2. Node Analysis

For each referenced node (`NodeA`, `NodeB`):
- Check if it has `children` with empty `items: {}`
- If yes, it should use the field's type parameter
- Register it as "participating in field recursion"

### 3. Type Alias Generation

Create a type alias for the field:

```typescript
export type FieldNameChildren = 
  | NodeA<FieldNameChildren>
  | NodeB<FieldNameChildren>;
```

### 4. Node Instantiation

When parsing the nodes in the inline expansion:
- If node has empty `items` and is part of this field's pattern
- Instantiate with the field's type alias instead of self-reference

## Implementation Complexity

**Estimate**: Medium-High

**Challenges**:

1. **Detection**: Current code assumes `$dynamicRef` in nodes for recursion
2. **Scoping**: Need to track which nodes belong to which field context
3. **Parsing order**: Type alias must be created before nodes are parsed
4. **Multiple fields**: Same node in multiple fields needs different instantiations

**Changes needed**:
- `findNestedDynamicAnchor()`: Detect field-level pattern
- `identifyGenericInterfaces()`: Mark nodes with empty items as "field-generic"
- `parseNonLiteral()` (ANY_OF case): Generate type alias for field patterns
- Node parsing: Instantiate with field alias when applicable

## Workaround (Current State)

### Option A: Use `$dynamicRef` in nodes (current approach)

**Schema**:
```json
{
  "Paragraph": {
    "$dynamicAnchor": "allowedTypes",
    "properties": {
      "children": {
        "items": { "$dynamicRef": "#allowedTypes" }
      }
    }
  }
}
```

**Result**:
- ✅ Type aliases generated
- ✅ Correct recursion
- ❌ Nodes get default type parameters from first field
- ❌ Not reusable across fields with different anchors

### Option B: No `$dynamicRef` (tested above)

**Schema**:
```json
{
  "Paragraph": {
    "properties": {
      "children": { "items": {} }
    }
  }
}
```

**Result**:
- ✅ Nodes are generic `<T = unknown>`
- ❌ No type aliases generated
- ❌ Self-references in inline types
- ❌ Wrong defaults cross-contaminating fields

### Option C: Separate anchor per field + rename nodes

**Schema**:
```json
{
  "$defs": {
    "BasicTextParagraph": {
      "$dynamicAnchor": "basicTextTypes",
      "properties": {
        "children": { "items": { "$dynamicRef": "#basicTextTypes" } }
      }
    },
    "HeadingOnlyParagraph": {
      "$dynamicAnchor": "headingOnlyTypes",
      "properties": {
        "children": { "items": { "$dynamicRef": "#headingOnlyTypes" } }
      }
    }
  }
}
```

**Result**:
- ✅ Type aliases generated correctly
- ✅ No cross-contamination
- ❌ Node duplication (maintenance burden)
- ❌ Not a reusable pattern

## Recommendation

**For the user**: Use **Option C** (separate nodes per field) for now. While it requires duplication, it's the only approach that works correctly with multiple fields.

**For the maintainer**: This is a valuable feature that would complete the `$dynamicRef` implementation for real-world CMS use cases. The architectural challenge is significant but the pattern is common enough to warrant support.

## Related Issues

- Current implementation assumes bottom-up (nodes declare anchors)
- This request is top-down (fields declare anchors, nodes participate)
- JSON Schema spec supports both patterns
- Fork currently only supports bottom-up

## References

- JSON Schema Draft 2020-12 `$dynamicRef` spec
- Common in: Payload CMS, Strapi, Contentful schemas
- Similar to: Polymorphic recursion with per-context resolution

