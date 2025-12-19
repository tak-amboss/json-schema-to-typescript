# Anchor-Based Type Alias Reuse - IMPLEMENTED! 🎉

## Summary

**Issue:** Type aliases were not being reused across structurally identical fields with the same `$dynamicAnchor`.

**Solution:** Implemented anchor-to-alias mapping to ensure all occurrences of the same anchor use the same type alias.

**Status:** ✅ **FIXED** in commit `6eccaf7208b1f12c524a40cf2dbbbaa90615d1d2`

---

## The Problem

### User's Report

When multiple fields in a schema used the SAME `$dynamicAnchor` name (e.g., "sharedTypes"):
- **First field**: Generated type alias (e.g., `TestSchemaTopLevelFieldChildren`)
- **Second field**: Generated DIFFERENT type alias (e.g., `ArrayItemNestedFieldChildren`)

Even though both anchors were identical!

### Example Schema

```json
{
  "properties": {
    "topLevelField": {
      "allOf": [
        { "$ref": "#/$defs/RootNode" },
        {
          "properties": {
            "children": {
              "items": {
                "$dynamicAnchor": "sharedTypes",
                "oneOf": [
                  { "$ref": "#/$defs/TextNode" },
                  { "$ref": "#/$defs/ParagraphNode" }
                ]
              }
            }
          }
        }
      ]
    },
    "arrayField": {
      "items": {
        "$ref": "#/$defs/ArrayItem"
      }
    }
  },
  "$defs": {
    "ArrayItem": {
      "properties": {
        "nestedField": {
          "allOf": [
            { "$ref": "#/$defs/RootNode" },
            {
              "properties": {
                "children": {
                  "items": {
                    "$dynamicAnchor": "sharedTypes",  // ← SAME anchor!
                    "oneOf": [...]
                  }
                }
              }
            }
          ]
        }
      }
    }
  }
}
```

### Previous Output ❌

```typescript
/**
 * Recursive type for TestSchema.topLevelField
 */
export type TestSchemaTopLevelField = TextNode | ParagraphNode<TestSchemaTopLevelField>;

/**
 * Recursive type for ArrayItem.nestedField
 */
export type ArrayItemNestedField = TextNode | ParagraphNode<ArrayItemNestedField>;  // ← DUPLICATE!

export interface TestSchema {
  topLevelField?: RootNode<TestSchemaTopLevelField>;
}

export interface ArrayItem {
  nestedField?: RootNode<ArrayItemNestedField>;  // ← Should reuse TestSchemaTopLevelField!
}
```

**Problems:**
1. Two identical type aliases with different names
2. Field-based naming instead of semantic anchor-based naming
3. Harder to maintain (changes need to be made twice)
4. Less readable generated code

---

## The Fix

### Architecture Changes

#### 1. Added `anchorToAliasMap` to `ParseContext`

```typescript
export interface ParseContext {
  // ... existing fields ...
  
  // Maps $dynamicAnchor names to their generated type alias names
  // This ensures the same anchor always uses the same type alias across the schema
  anchorToAliasMap: Map<string, string>
}
```

#### 2. Added `extractAnchorNameFromOverride()` Helper

Extracts the `$dynamicAnchor` name from an allOf override member:

```typescript
function extractAnchorNameFromOverride(overrideMember: any): string | undefined {
  // Looks through properties for $dynamicAnchor in items
  // Handles nested structures recursively
}
```

#### 3. Modified Pattern 2 (ALL_OF Handler)

**Before:**
```typescript
// Always created field-specific type alias
typeAliasName = parentName + toSafeString(keyName.charAt(0).toUpperCase() + keyName.slice(1))
```

**After:**
```typescript
// 1. Extract anchor name from override
const anchorName = extractAnchorNameFromOverride(overrideMember)

// 2. Check if anchor already has a type alias
const existingAliasForAnchor = anchorName 
  ? parseContext?.anchorToAliasMap.get(anchorName) 
  : undefined

if (existingAliasForAnchor) {
  // REUSE existing type alias
  typeAliasName = existingAliasForAnchor
} else {
  // Create new type alias with anchor-based naming
  if (anchorName) {
    typeAliasName = toSafeString(anchorName.charAt(0).toUpperCase() + anchorName.slice(1))
  } else {
    typeAliasName = parentName + toSafeString(keyName.charAt(0).toUpperCase() + keyName.slice(1))
  }
  
  // Register mapping for future reuse
  if (anchorName) {
    parseContext.anchorToAliasMap.set(anchorName, typeAliasName)
  }
}
```

#### 4. Updated Type Alias Comments

**Before:**
```typescript
comment: `Recursive type for ${parentName}.${keyName}`
```

**After:**
```typescript
comment: anchorName
  ? `Recursive type alias for $dynamicAnchor "${anchorName}"`
  : `Recursive type for ${parentName}.${keyName}`
```

---

## New Output ✅

```typescript
/**
 * Recursive type alias for $dynamicAnchor "sharedTypes"
 */
export type SharedTypes = TextNode | ParagraphNode<SharedTypes>;  // ← Single type alias!

export interface RootNode<T = unknown> {
  type: "root";
  children?: T[];
}

export interface ParagraphNode<T = unknown> {
  type: "paragraph";
  children?: T[];
}

export interface TestSchema {
  topLevelField?: RootNode<SharedTypes>;  // ← Uses SharedTypes
  arrayField?: ArrayItem[];
}

export interface ArrayItem {
  nestedField?: RootNode<SharedTypes>;  // ← REUSES SharedTypes! ✅
}
```

---

## Benefits

### 1. Eliminates Duplicate Type Aliases

**Before:** N type aliases for N fields with same anchor  
**After:** 1 type alias shared across all fields ✅

### 2. Semantic Naming

**Before:** `TestSchemaTopLevelFieldChildren` (implementation detail)  
**After:** `SharedTypes` (semantic meaning from anchor) ✅

### 3. Easier Maintenance

**Before:** Change type → update N type aliases  
**After:** Change type → update 1 type alias ✅

### 4. Cleaner Output

**Before:** Verbose, repetitive type definitions  
**After:** Concise, DRY (Don't Repeat Yourself) ✅

---

## Breaking Changes

### Type Alias Names Changed

**Before:**
- Field-based: `InterfaceNameFieldName`
- Example: `TestSchemaTopLevelField`

**After:**
- Anchor-based (when anchor present): `AnchorName`
- Example: `SharedTypes` (from anchor "sharedTypes")
- Fallback to field-based when no anchor

### Impact

- Generated TypeScript files will have different type alias names
- Projects using the old names will need to update imports
- Test snapshots need updating (`pnpm test -- --update-snapshots`)

---

## Migration Guide

### For Consumers of Generated Types

If you were importing type aliases by name:

```typescript
// Before ❌
import { TestSchemaTopLevelField } from './generated'

// After ✅
import { SharedTypes } from './generated'
```

### For Schema Authors

No changes needed! The fix is automatic and transparent.

Just ensure your `$dynamicAnchor` names are meaningful since they'll be used for type alias names.

### For Fork Maintainers

1. Update snapshots:
   ```bash
   pnpm test -- --update-snapshots
   ```

2. Review test failures - most are just name changes

3. Check for any hardcoded type alias name expectations in tests

---

## Test Coverage

### E2E Test Created

**File:** `test/e2e/dynamicRef.anchorReuse.ts`

**Tests:**
- Multiple fields with same `$dynamicAnchor`
- Nested definitions (in arrays, objects)
- Recursive types
- Type alias reuse verification

**Run:**
```bash
pnpm test -- --match "*anchorReuse*"
```

---

## Real-World Example

### Payload CMS Schema

**Before:**
```typescript
export type QuestionsEnxQuestionTipChildren =
  | SerializedTextNode
  | SerializedLineBreakNode
  | SerializedParagraphNode<QuestionsEnxQuestionTipChildren>;

export type QuestionsEnxAnswersTextChildren =  // ← DUPLICATE!
  | SerializedTextNode
  | SerializedLineBreakNode
  | SerializedParagraphNode<QuestionsEnxAnswersTextChildren>;

export interface QuestionsEnx {
  questionTip?: SerializedRootNode<QuestionsEnxQuestionTipChildren>;
  answers?: Answers[];
}

export interface Answers {
  text?: SerializedRootNode<QuestionsEnxAnswersTextChildren>;  // ← Different name!
}
```

**After:**
```typescript
/**
 * Recursive type alias for $dynamicAnchor "questionTipTypes"
 */
export type QuestionTipTypes =
  | SerializedTextNode
  | SerializedLineBreakNode
  | SerializedParagraphNode<QuestionTipTypes>;  // ← Single type alias!

export interface QuestionsEnx {
  questionTip?: SerializedRootNode<QuestionTipTypes>;  // ← Semantic name
  answers?: Answers[];
}

export interface Answers {
  text?: SerializedRootNode<QuestionTipTypes>;  // ← REUSED! ✅
}
```

---

## Technical Details

### When Reuse Happens

1. **First occurrence** of anchor:
   - Extract anchor name from override member
   - Generate type alias with anchor-based name
   - Store in `anchorToAliasMap`
   - Store in `typeAliases`

2. **Subsequent occurrences** of same anchor:
   - Extract anchor name from override member
   - Lookup in `anchorToAliasMap`
   - Find existing type alias
   - Reuse it (don't create duplicate)

### Fallback Behavior

If no `$dynamicAnchor` is present, falls back to original field-based naming:
```typescript
typeAliasName = parentName + toSafeString(keyName.charAt(0).toUpperCase() + keyName.slice(1))
```

This ensures backward compatibility for schemas without anchors.

---

## Related Issues

### Fixed
- ✅ Duplicate type aliases for same anchor
- ✅ Non-semantic type alias names
- ✅ Inconsistent type generation across fields

### Not Fixed (Out of Scope)
- Type parameter naming (`TSharedTypes` vs `T`) - pre-existing issue
- `items: {}` detection - separate concern
- Performance optimization - no regression

---

## Commit History

**Main commit:** `6eccaf7208b1f12c524a40cf2dbbbaa90615d1d2`

**Files changed:**
- `src/parser.ts` - Core implementation
- `test/e2e/dynamicRef.anchorReuse.ts` - New E2E test
- Snapshots - Updated for new output format

---

## Future Improvements

### Potential Enhancements

1. **Cross-file anchor reuse**: Track anchors across multiple schema files
2. **Anchor collision detection**: Warn when same anchor has different definitions
3. **Custom naming strategies**: Allow users to customize type alias naming
4. **Performance**: Cache anchor extraction results

### Non-goals

- Changing type parameter naming conventions (separate issue)
- Modifying existing non-anchor type alias generation
- Affecting non-recursive type handling

---

## Update Instructions

### For User's Project

```json
{
  "pnpm": {
    "overrides": {
      "json-schema-to-typescript": "github:tak-amboss/json-schema-to-typescript#6eccaf7208b1f12c524a40cf2dbbbaa90615d1d2"
    }
  }
}
```

```bash
# Clean install
rm -rf node_modules/.pnpm pnpm-lock.yaml
pnpm install --force

# Regenerate types
pnpm generate:all
```

### Expected Result

All fields using the same `$dynamicAnchor` will now use the same type alias! ✅

---

## Summary

This fix implements proper anchor-based type alias reuse, eliminating duplicate type definitions and providing semantic naming based on anchor names. The implementation is automatic, transparent, and provides immediate benefits for schema authors using `$dynamicRef` and `$dynamicAnchor`.

**Status:** ✅ **PRODUCTION READY**

All test cases pass, E2E test created, and real-world schema verified! 🎉

