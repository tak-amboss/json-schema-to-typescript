// Test for external file generic interfaces
// This test ensures that generic interfaces defined in external files
// are properly emitted in the output, not just referenced

export const input = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://example.com/main',
  title: 'Main',
  $defs: {
    Container: {
      type: 'object',
      properties: {
        value: {type: 'string'},
        children: {
          type: 'array',
          items: {
            $dynamicRef: '#nodeTypes',
          },
        },
      },
      required: ['value', 'children'],
    },
    Leaf: {
      type: 'object',
      properties: {
        value: {type: 'string'},
      },
      required: ['value'],
    },
  },
  type: 'object',
  properties: {
    tree: {
      $dynamicAnchor: 'nodeTypes',
      oneOf: [{$ref: '#/$defs/Container'}, {$ref: '#/$defs/Leaf'}],
    },
  },
}

export const options = {
  declareExternallyReferenced: true,
  unreachableDefinitions: true,
}
