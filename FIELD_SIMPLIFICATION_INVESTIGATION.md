# Field Simplification Investigation

## Problem Statement

Currently, fields with `$dynamicAnchor` generate both:
1. A type alias with constraints: `type FieldChildren = (Node & { constraint })| ...`
2. Inline expansion in the field: `Base & { root?: { children?: (Node & { constraint })[] } }`

**Goal**: Simplify to just `Base<FieldChildren>`

## Current Output

```typescript
export type TestConstrainedFieldChildren =
  | (HeadingNode<TestConstrainedFieldChildren> & { tag?: "h2" | "h3"; })
  | TextNode;

export interface TestSchema {
  field?: Base & {
    root?: {
      children?: (
        | (HeadingNode<TestConstrainedFieldChildren> & { tag?: "h2" | "h3"; })
        | TextNode
      )[];
    };
  };
}
```

**Issues:**
1. Redundancy: Constraints appear in both type alias AND field
2. Verbosity: Field definition is very long
3. The type alias is not used in the field!

## Desired Output

```typescript
export type TestConstrainedFieldChildren =
  | (HeadingNode<TestConstrainedFieldChildren> & { tag?: "h2" | "h3"; })
  | TextNode;

export interface Base<T = unknown> {
  root?: {
    children?: T[];  // <- Use type parameter
  };
}

export interface TestSchema {
  field?: Base<TestConstrainedFieldChildren>;  // <- Clean!
}
```

## Investigation: Two Interpretation Approaches

### Approach 1: Intersection (Current)

**Interpretation:** `allOf` = TypeScript intersection

```json
{
  "allOf": [
    { "$ref": "#/$defs/Base" },
    { "properties": { "root": { "properties": { "children": { "items": {...} } } } } }
  ]
}
```

↓

```typescript
Base & { root?: { children?: TypeAlias[] } }
```

**Pros:**
- Faithful to JSON Schema semantics
- Works when Base doesn't have type parameters
- Handles property additions/refinements

**Cons:**
- Verbose output
- Redundant with type alias
- Not idiomatic TypeScript for this pattern

### Approach 2: Instantiation (Proposed)

**Interpretation:** `allOf` with `$dynamicAnchor` override = Type parameter instantiation

```json
{
  "allOf": [
    { "$ref": "#/$defs/Base" },
    { "properties": { "root": { "properties": { "children": { "items": { "$dynamicAnchor": "..." } } } } } }
  ]
}
```

↓

```typescript
Base<TypeAlias>
```

**Pros:**
- Clean, idiomatic TypeScript
- Uses the type alias we generate
- Matches common CMS/recursive structure patterns
- Less redundancy

**Cons:**
- Requires Base to use its type parameter
- May not work if override has other property changes
- Less general than intersection

## Key Questions

### 1. How to Detect Pattern 2 Should Apply?

Conditions for using instantiation instead of intersection:
- `allOf` has Base reference + override
- Override ONLY adds/refines `children.items` with `$dynamicAnchor`
- No other property changes
- Base is generic (has type parameter)

### 2. How to Make Base Generic?

**Option A:** Schema author must define Base generically
```json
{
  "Base": {
    "properties": {
      "root": {
        "properties": {
          "children": { "type": "array", "items": {} }  // Generic items
        }
      }
    }
  }
}
```

Then we detect `$dynamicRef` usage and mark Base as generic.

**Option B:** Infer Base should be generic when used in `allOf` pattern
- During pre-scan, detect Base is used in Pattern 2
- Automatically make Base generic
- Replace its `children.items` with type parameter

### 3. What About Non-Children Properties?

If override adds OTHER properties beyond children refinement:
```json
{
  "allOf": [
    { "$ref": "#/$defs/Base" },
    {
      "properties": {
        "root": { "properties": { "children": {...} } },
        "metadata": { "type": "object" }  // <- Additional property
      }
    }
  ]
}
```

Then we MUST use intersection: `Base<TypeAlias> & { metadata?: object }`

## Implementation Strategy

### Phase 1: Detect the Pattern (Current State)

✅ We already detect:
- `allOf` with Base + override
- `$dynamicAnchor` in override
- Generate type alias

### Phase 2: Check If Base Is Generic

```typescript
// In the allOf handling:
if (baseMember.$ref) {
  const baseName = extractName(baseMember.$ref)
  const isBaseGeneric = parseContext.genericInterfaces.has(baseName)
  
  if (isBaseGeneric && onlyChildrenRefined(overrideMember)) {
    // Use instantiation approach
    return {
      type: 'REFERENCE',
      params: baseName,
      typeArguments: [{ type: 'REFERENCE', params: typeAliasName }]
    }
  } else {
    // Fall back to intersection approach
    return { type: 'INTERSECTION', params: [base, override] }
  }
}
```

### Phase 3: Helper - Check If Only Children Refined

```typescript
function onlyChildrenRefined(override: any): boolean {
  // Check if override ONLY refines root.children
  // and doesn't add/modify other properties
  
  if (!override.properties) return false
  
  // Should have root property
  if (!override.properties.root) return false
  
  // Root should only have children (and maybe type)
  const rootProps = Object.keys(override.properties.root.properties || {})
  const allowedProps = ['children', 'type']
  if (!rootProps.every(p => allowedProps.includes(p))) {
    return false
  }
  
  // Override should not have properties other than root
  const overrideProps = Object.keys(override.properties)
  if (overrideProps.length > 1 || overrideProps[0] !== 'root') {
    return false
  }
  
  return true
}
```

### Phase 4: Update Base to Use Type Parameter

When Base is detected as generic, ensure it uses the type parameter:

```typescript
// When generating Base interface:
if (parseContext.genericInterfaces.has('Base')) {
  // Find the children property
  const childrenParam = findChildrenParam(interfaceParams)
  if (childrenParam) {
    // Replace its AST with type parameter reference
    childrenParam.ast = {
      type: 'ARRAY',
      params: {
        type: 'REFERENCE',
        params: 'T'  // Use the type parameter name
      }
    }
  }
}
```

## Recommendation

### Short Term (Quickest Win)

Implement **Approach 2 (Instantiation)** with these conditions:
1. Base must already be marked as generic (user uses `$dynamicRef` in Base)
2. Override must only refine children (use `onlyChildrenRefined` check)
3. If conditions met: use `Base<TypeAlias>`
4. Otherwise: fall back to current intersection approach

This gives clean output for the common case without breaking other patterns.

### Long Term (More General)

Add option to infer generic Base:
1. During pre-scan, detect when schemas are used in Pattern 2
2. Automatically mark them as generic
3. Update their children type to use type parameter
4. Generate instantiation instead of intersection

## Next Steps

1. Add `onlyChildrenRefined` helper function
2. Modify `allOf` handling to detect the pattern
3. Return `REFERENCE` with `typeArguments` instead of `INTERSECTION`
4. Ensure Base's children property uses type parameter
5. Test with existing patterns

## Open Questions

1. Should this be behind a flag? Or automatic when detected?
2. How to handle Base that's generic but has DEFAULT type parameter that's not `unknown`?
3. What if Base has multiple type parameters?
4. Should we update existing tests or add new ones?

