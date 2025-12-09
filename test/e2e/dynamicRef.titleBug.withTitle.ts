// Test Case 2: WITH title (demonstrates the bug)
// This should generate the same type alias structure as the withoutTitle test,
// but currently fails to do so when Base schema has a title property
export const input = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'WithTitle',
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
      title: 'Base Schema', // THIS IS THE ONLY DIFFERENCE
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
