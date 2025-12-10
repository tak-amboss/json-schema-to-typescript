# Diagnosis: Multi-Field `$dynamicAnchor` Issue

## Root Cause: Using Same Anchor Name for All Fields

### The Problem

Your schema uses:
```json
{
  "basicText": {
    "items": {
      "$dynamicAnchor": "allowedNodeTypes",  // ← Same name
      "oneOf": [/* 4 nodes */]
    }
  },
  "constrainedHeading": {
    "items": {
      "$dynamicAnchor": "allowedNodeTypes",  // ← Same name!
      "oneOf": [/* 4 different nodes */]
    }
  }
}
```

**Result**: The implementation merges ALL fields into ONE anchor context called "allowedNodeTypes" containing ALL 7 nodes from all fields combined.

### Why This Happens

The `collectAnchorContexts()` function collects anchor contexts by NAME:

```typescript
// If multiple fields use the same anchor name, they OVERWRITE each other
anchorContexts.set(obj.$dynamicAnchor, {
  anchorName: obj.$dynamicAnchor,
  allowedTypeNames: [/* nodes from THIS field */]
})
```

The LAST field processed wins, so all previous fields' node lists are lost.

## The Solution: Different Anchor Names Per Field

### Required Schema Pattern

```json
{
  "basicText": {
    "items": {
      "$dynamicAnchor": "basicTextTypes",  // ← Unique name
      "oneOf": [
        { "$ref": "#/$defs/SerializedParagraphNode" },
        { "$ref": "#/$defs/SerializedTextNode" },
        { "$ref": "#/$defs/SerializedLineBreakNode" },
        { "$ref": "#/$defs/SerializedRootNode" }
      ]
    }
  },
  "constrainedHeading": {
    "items": {
      "$dynamicAnchor": "constrainedHeadingTypes",  // ← Different unique name
      "oneOf": [
        { "$ref": "#/$defs/SerializedHeadingNode" },
        { "$ref": "#/$defs/SerializedLineBreakNode" },
        { "$ref": "#/$defs/SerializedParagraphNode" },
        { "$ref": "#/$defs/SerializedRootNode" }
      ]
    }
  }
}
```

### Node Schema Changes

Nodes need:
1. **`$dynamicAnchor`** - Pick ANY one of the field anchor names (doesn't matter which)
2. **`$dynamicRef`** - Reference the anchor for recursion

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "SerializedRootNode",
  "$dynamicAnchor": "basicTextTypes",  // ← Add this (any field name works)
  "type": "object",
  "properties": {
    "type": { "const": "root" },
    "children": {
      "type": "array",
      "items": {
        "$dynamicRef": "#basicTextTypes"  // ← Add this for recursion
      }
    }
  }
}
```

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "SerializedParagraphNode",
  "$dynamicAnchor": "basicTextTypes",  // ← Same anchor
  "type": "object",
  "properties": {
    "type": { "const": "paragraph" },
    "children": {
      "type": "array",
      "items": {
        "$dynamicRef": "#basicTextTypes"  // ← Recursion
      }
    }
  }
}
```

Leaf nodes (no children) don't need `$dynamicRef`:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "SerializedTextNode",
  "$dynamicAnchor": "basicTextTypes",  // ← Still need anchor
  "type": "object",
  "properties": {
    "type": { "const": "text" },
    "text": { "type": "string" }
    // No children, no $dynamicRef needed
  }
}
```

## How It Works

### 1. Collection Phase
```
Field: basicText
  Anchor: "basicTextTypes"
  Nodes: [Paragraph, Text, LineBreak, Root]

Field: constrainedHeading
  Anchor: "constrainedHeadingTypes"
  Nodes: [Heading, LineBreak, Paragraph, Root]
```

### 2. Identification Phase
- Nodes with `$dynamicRef` are marked as generic interfaces
- Each gets a type parameter based on their `$dynamicAnchor`

### 3. Type Alias Generation
- Each field-level `$dynamicAnchor` + `oneOf` triggers a type alias
- Type alias name: `{SchemaName}{FieldName}Children`

```typescript
export type SchemaBasicTextChildren =
  | SerializedParagraphNode<SchemaBasicTextChildren>
  | SerializedTextNode
  | SerializedLineBreakNode
  | SerializedRootNode<SchemaBasicTextChildren>;

export type SchemaConstrainedHeadingChildren =
  | SerializedHeadingNode<SchemaConstrainedHeadingChildren>
  | SerializedLineBreakNode
  | SerializedParagraphNode<SchemaConstrainedHeadingChildren>
  | SerializedRootNode<SchemaConstrainedHeadingChildren>;
```

### 4. Genericization Phase (Post-Processing)
- Detects `SerializedRootNode` is used in BOTH type aliases
- Genericizes it to `<T = unknown>`

```typescript
export interface SerializedRootNode<T = unknown> {
  type: 'root';
  children: T[];
}

// Nodes used in only one context keep their specific defaults
export interface SerializedHeadingNode<TConstrainedHeadingTypes = ...> {
  type: 'heading';
  children: TConstrainedHeadingTypes[];
}
```

## Action Items for You

1. **Update collection schemas**: Use unique anchor names per field
   - `basicTextTypes`
   - `constrainedHeadingTypes`
   - `onlyOrderedListTypes`
   - `mixedListsTypes`

2. **Update node schemas**: Add `$dynamicAnchor` and `$dynamicRef`
   - Each node picks ONE anchor name (recommend using the most common field)
   - Nodes with children need `$dynamicRef` for recursion

3. **Regenerate**: Run `pnpm generate:all`

## Expected Result

```typescript
// Shared nodes → fully generic
export interface SerializedRootNode<T = unknown> {
  type: 'root';
  children: T[];
}

export interface SerializedTextNode {
  type: 'text';
  text: string;
}

// Field-specific nodes → context-aware defaults
export interface SerializedHeadingNode<TConstrainedHeadingTypes = ...> {
  type: 'heading';
  children: TConstrainedHeadingTypes[];
}

// Type aliases → field-specific
export type SchemaBasicTextChildren =
  | SerializedRootNode<SchemaBasicTextChildren>
  | SerializedTextNode
  | SerializedParagraphNode<SchemaBasicTextChildren>;

export type SchemaConstrainedHeadingChildren =
  | SerializedRootNode<SchemaConstrainedHeadingChildren>
  | SerializedHeadingNode<SchemaConstrainedHeadingChildren>
  | SerializedTextNode;
```

## Why `$dynamicAnchor` on Nodes Is Required

Even though it seems redundant, the `$dynamicAnchor` on node schemas serves two purposes:

1. **Marks the node as part of the dynamic reference system** - Without it, the node isn't recognized as needing a type parameter
2. **Associates it with an anchor context** - Used during identification phase

The field-level `$dynamicAnchor` + `oneOf` defines WHICH nodes are allowed in each context, but the node-level `$dynamicAnchor` is what marks the node as participating in the system.

## Alternative: If You Can't Add `$dynamicAnchor` to Nodes

If your build system or schema organization prevents adding `$dynamicAnchor` to node definitions, you'd need a different approach. The current implementation REQUIRES node-level `$dynamicAnchor` to function.

Possible alternatives (would require fork modifications):
1. Detect nodes based on being referenced in field-level `oneOf` lists
2. Use a custom `x-dynamic-node: true` property
3. Configure nodes explicitly via compiler options

But the simplest path forward is to use the pattern the fork expects: unique anchor names per field + `$dynamicAnchor`/`$dynamicRef` in node schemas.

