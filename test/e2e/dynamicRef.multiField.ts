export const input = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'MultiFieldAnchor',
  type: 'object',
  properties: {
    basicText: {
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
                        $dynamicAnchor: 'basicTextTypes',
                        oneOf: [{$ref: '#/$defs/Para'}, {$ref: '#/$defs/Text'}, {$ref: '#/$defs/Root'}],
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
    headingOnly: {
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
                        $dynamicAnchor: 'headingOnlyTypes',
                        oneOf: [{$ref: '#/$defs/Heading'}, {$ref: '#/$defs/Text'}, {$ref: '#/$defs/Root'}],
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
    Text: {
      $dynamicAnchor: 'basicTextTypes',
      type: 'object',
      properties: {
        type: {const: 'text'},
        text: {type: 'string'},
      },
    },
    Para: {
      $dynamicAnchor: 'basicTextTypes',
      type: 'object',
      properties: {
        type: {const: 'para'},
        children: {
          type: 'array',
          items: {$dynamicRef: '#basicTextTypes'},
        },
      },
    },
    Heading: {
      $dynamicAnchor: 'headingOnlyTypes',
      type: 'object',
      properties: {
        type: {const: 'heading'},
        tag: {enum: ['h1', 'h2', 'h3']},
        children: {
          type: 'array',
          items: {$dynamicRef: '#headingOnlyTypes'},
        },
      },
    },
    Root: {
      $dynamicAnchor: 'basicTextTypes',
      type: 'object',
      properties: {
        type: {const: 'root'},
        children: {
          type: 'array',
          items: {$dynamicRef: '#basicTextTypes'},
        },
      },
    },
  },
}

