// Test with 3-level deep recursion to verify context is maintained
export const input = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://example.com/deep-tree',
  title: 'DeepTree',
  $defs: {
    BranchNode: {
      type: 'object',
      properties: {
        value: {type: 'string'},
        branches: {
          type: 'array',
          items: {
            $dynamicRef: '#allowedNodes',
          },
        },
      },
      required: ['value', 'branches'],
    },
    LeafNode: {
      type: 'object',
      properties: {
        value: {type: 'string'},
      },
      required: ['value'],
    },
  },
  type: 'object',
  properties: {
    // Allows BranchNode and LeafNode
    fullTree: {
      type: 'object',
      properties: {
        root: {
          $dynamicAnchor: 'allowedNodes',
          oneOf: [{$ref: '#/$defs/BranchNode'}, {$ref: '#/$defs/LeafNode'}],
        },
      },
    },
    // Allows only BranchNode (infinite depth)
    infiniteTree: {
      type: 'object',
      properties: {
        root: {
          $dynamicAnchor: 'allowedNodes',
          $ref: '#/$defs/BranchNode',
        },
      },
    },
  },
}

export const options = {
  declareExternallyReferenced: true,
  unreachableDefinitions: true,
}
