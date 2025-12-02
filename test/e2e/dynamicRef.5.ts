export const input = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'Issue3Test',
  title: 'Issue3Test',
  type: 'object',
  properties: {
    content: {
      $dynamicAnchor: 'allowedNodeTypes',
      oneOf: [{$ref: '#/$defs/TextNode'}, {$ref: '#/$defs/ParagraphNode'}],
    },
  },
  $defs: {
    TextNode: {
      $dynamicAnchor: 'allowedNodeTypes',
      type: 'object',
      properties: {
        type: {const: 'text'},
        text: {type: 'string'},
      },
      required: ['type'],
    },
    ParagraphNode: {
      $dynamicAnchor: 'allowedNodeTypes',
      type: 'object',
      properties: {
        type: {const: 'paragraph'},
        children: {
          type: 'array',
          items: {$dynamicRef: '#allowedNodeTypes'},
        },
      },
      required: ['type', 'children'],
    },
  },
}
