export const input = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'PayloadStyleTest',
  title: 'PayloadStyleTest',
  type: 'object',
  properties: {
    basicText: {
      allOf: [
        {$ref: '#/$defs/AmbossRichTextBase'},
        {
          properties: {
            root: {
              properties: {
                children: {
                  type: 'array',
                  items: {
                    $dynamicAnchor: 'allowedNodeTypes',
                    oneOf: [{$ref: '#/$defs/SerializedParagraphNode'}, {$ref: '#/$defs/SerializedTextNode'}],
                  },
                },
              },
            },
          },
        },
      ],
    },
  },
  $defs: {
    AmbossRichTextBase: {
      $dynamicAnchor: 'allowedNodeTypes',
      type: 'object',
      properties: {
        root: {
          type: 'object',
          properties: {
            type: {const: 'root'},
            children: {
              type: 'array',
              items: {$dynamicRef: '#allowedNodeTypes'},
            },
          },
        },
      },
    },
    SerializedParagraphNode: {
      $dynamicAnchor: 'allowedNodeTypes',
      type: 'object',
      properties: {
        type: {const: 'paragraph'},
        children: {
          type: 'array',
          items: {$dynamicRef: '#allowedNodeTypes'},
        },
      },
    },
    SerializedTextNode: {
      $dynamicAnchor: 'allowedNodeTypes',
      type: 'object',
      properties: {
        type: {const: 'text'},
        text: {type: 'string'},
      },
    },
  },
}
