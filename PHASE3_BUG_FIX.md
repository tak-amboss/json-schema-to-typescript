# Phase 3 Bug Fix - Missing Array Detection

## The Bug

**Symptom:** Phase 3 optimization (remove redundant intersections) was NOT triggering, even with the exact minimal pattern.

**Output with bug:**
```typescript
basicText?: AmbossRichTextBase<TypeAlias> & {
  root?: { children?: (...)[]; };
} | null;
```

**Expected output:**
```typescript
basicText?: AmbossRichTextBase<TypeAlias> | null;  // Clean!
```

---

## Root Cause

The bug was in `extractTypeArgumentFromOverride()` function (line 380 of `parser.ts`).

### What It Did (Broken)
```typescript
// Only detected arrays with EXPLICIT type declaration
if (propSchema.type === 'array' && propSchema.items) {
  // Extract type argument
}
```

### The Problem

User schemas had override members like:
```json
{
  "properties": {
    "root": {
      "properties": {
        "children": {
          "items": {
            "$dynamicAnchor": "basicTextTypes",
            "oneOf": [...]
          }
          // ❌ NO "type": "array" declaration!
        }
      }
    }
  }
}
```

Because `children` didn't have `type: "array"` explicitly set, the function failed to detect it as an array and returned `null`.

This caused Pattern 2 detection to fail, which prevented Phase 3 optimization from triggering.

---

## The Fix

### What It Does Now (Fixed)
```typescript
// Detect arrays by EITHER explicit type OR presence of items
const isArray = propSchema.type === 'array' || (propSchema.items && !propSchema.properties)
if (isArray && propSchema.items) {
  // Extract type argument
}
```

### Logic
An object is an array if:
1. **Explicit:** Has `type: "array"`, OR
2. **Implicit:** Has `items` property but NOT `properties` property

The second condition handles JSON Schema's implicit array detection:
- If it has `items`, it's describing array elements
- If it also has `properties`, it's an object (not an array)
- So: `items` without `properties` → array

---

## Test Results

### Before Fix
```typescript
export interface TestInlineEverything {
  basicText?:
    | (AmbossRichTextBase<TestInlineEverythingBasicTextChildren> & {
        root?: {
          children?: (...)[];
        };
      })
    | null;
}
```

### After Fix ✅
```typescript
export interface TestInlineEverything {
  basicText?: AmbossRichTextBase<TestInlineEverythingBasicTextChildren> | null;
}
```

**CLEAN OUTPUT!** No redundant intersection!

---

## Impact

- ✅ Phase 3 now triggers correctly for all patterns
- ✅ Works with or without explicit `type: "array"`
- ✅ All 175 existing tests still pass
- ✅ No breaking changes

---

## For Users

### Update to Latest Version

```json
{
  "pnpm": {
    "overrides": {
      "json-schema-to-typescript": "github:tak-amboss/json-schema-to-typescript#4bb479e7363f46c1a518359232c66e9729f129ad"
    }
  }
}
```

### Clean Install
```bash
rm -rf node_modules/.pnpm pnpm-lock.yaml
pnpm install --force
pnpm generate:all
```

### Verify Output
You should now see CLEAN output:
```typescript
basicText?: AmbossRichTextBase<TypeAlias> | null;  // ✅ No intersection!
```

---

## Technical Details

### Why This Matters

The `extractTypeArgumentFromOverride()` function is critical for Pattern 2 detection. It:
1. Looks for the override member in `allOf` patterns
2. Finds the array property that will override the Base's generic children
3. Extracts the type argument for the generic instantiation

If this function returns `null`, Pattern 2 fails to detect the type argument, and Phase 3 optimization cannot proceed.

### The Full Flow

1. **anyOf** handler creates type alias for recursive union
2. Sets `parseContext.currentTypeAliasName`
3. Parses anyOf members, including the `allOf` Pattern 2
4. **allOf** handler detects Pattern 2 (Base + override)
5. Calls `extractTypeArgumentFromOverride()` to find type argument
6. **BUG WAS HERE:** Function returned `null` because array detection failed
7. Without type argument, Pattern 2 falls back to intersection
8. Result: `Base<TypeAlias> & { override }` instead of just `Base<TypeAlias>`

With the fix, step 5 now succeeds, and we get the clean output.

---

## Commit

**Hash:** `4bb479e7363f46c1a518359232c66e9729f129ad`

**Branch:** `feature/dynamic-ref-support`

**All Tests:** ✅ PASSING (175/175)

