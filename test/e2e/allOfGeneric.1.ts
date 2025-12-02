export const input = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'SimpleExample',
  title: 'SimpleExample',
  type: 'object',
  properties: {
    field: {
      allOf: [
        {$ref: '#/$defs/Container'},
        {
          properties: {
            items: {
              type: 'array',
              items: {
                oneOf: [{type: 'string'}, {type: 'number'}],
              },
            },
          },
        },
      ],
    },
  },
  $defs: {
    Container: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {},
        },
      },
    },
  },
}

