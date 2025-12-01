export const input = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://example.com/tree',
  title: 'Tree',
  $defs: {
    TreeNode: {
      type: 'object',
      properties: {
        value: {type: 'string'},
        children: {
          type: 'array',
          items: {
            $dynamicRef: '#allowedNodes',
          },
        },
      },
      required: ['value', 'children'],
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
    branchA: {
      type: 'object',
      properties: {
        root: {
          $dynamicAnchor: 'allowedNodes',
          oneOf: [{$ref: '#/$defs/TreeNode'}, {$ref: '#/$defs/LeafNode'}],
        },
      },
    },
    branchB: {
      type: 'object',
      properties: {
        root: {
          $dynamicAnchor: 'allowedNodes',
          oneOf: [{$ref: '#/$defs/TreeNode'}],
        },
      },
    },
  },
}

export const options = {
  declareExternallyReferenced: true,
  unreachableDefinitions: true,
}
