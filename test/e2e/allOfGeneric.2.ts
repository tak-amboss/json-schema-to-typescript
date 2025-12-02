export const input = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'RecursiveExample',
  title: 'RecursiveExample',
  type: 'object',
  properties: {
    richText: {
      allOf: [
        {$ref: '#/$defs/Root'},
        {
          properties: {
            children: {
              type: 'array',
              items: {
                oneOf: [
                  {$ref: '#/$defs/Text'},
                  {
                    allOf: [
                      {$ref: '#/$defs/Paragraph'},
                      {
                        properties: {
                          children: {
                            type: 'array',
                            items: {
                              oneOf: [{$ref: '#/$defs/Text'}, {$ref: '#/$defs/Paragraph'}],
                            },
                          },
                        },
                      },
                    ],
                  },
                ],
              },
            },
          },
        },
      ],
    },
  },
  $defs: {
    Root: {
      type: 'object',
      properties: {
        type: {const: 'root'},
        children: {
          type: 'array',
          items: {},
        },
      },
    },
    Paragraph: {
      type: 'object',
      properties: {
        type: {const: 'paragraph'},
        children: {
          type: 'array',
          items: {},
        },
      },
    },
    Text: {
      type: 'object',
      properties: {
        type: {const: 'text'},
        value: {type: 'string'},
      },
    },
  },
}

