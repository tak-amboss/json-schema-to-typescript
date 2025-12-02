export const input = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'Issue4Test',
  title: 'Issue4Test',
  allOf: [
    {$ref: '#/$defs/Base'},
    {
      $dynamicAnchor: 'allowedTypes',
      oneOf: [{type: 'string'}, {type: 'number'}],
    },
  ],
  $defs: {
    Base: {
      $dynamicAnchor: 'allowedTypes',
      type: 'object',
      properties: {
        children: {
          type: 'array',
          items: {$dynamicRef: '#allowedTypes'},
        },
      },
    },
  },
}
