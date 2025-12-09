// Test Case 1: WITHOUT title (should work correctly)
// This demonstrates the expected behavior when Base schema has NO title property
export const input = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'WithoutTitle',
  type: 'object',
  properties: {
    myField: {
      anyOf: [
        {
          allOf: [
            {$ref: '#/$defs/Base'},
            {
              properties: {
                root: {
                  properties: {
                    children: {
                      type: 'array',
                      items: {
                        $dynamicAnchor: 'allowedTypes',
                        oneOf: [{$ref: '#/$defs/Para'}, {$ref: '#/$defs/Text'}],
                      },
                    },
                  },
                },
              },
            },
          ],
        },
        {type: 'null'},
      ],
    },
  },
  $defs: {
    Base: {
      type: 'object',
      properties: {
        root: {
          type: 'object',
          properties: {
            type: {const: 'root'},
            children: {type: 'array', items: {}},
          },
        },
      },
    },
    Para: {
      $dynamicAnchor: 'allowedTypes',
      type: 'object',
      properties: {
        type: {const: 'paragraph'},
        children: {
          type: 'array',
          items: {$dynamicRef: '#allowedTypes'},
        },
      },
    },
    Text: {
      $dynamicAnchor: 'allowedTypes',
      type: 'object',
      properties: {
        type: {const: 'text'},
        text: {type: 'string'},
      },
    },
  },
}

export const options = {
  declareExternallyReferenced: true,
  unreachableDefinitions: true,
}
