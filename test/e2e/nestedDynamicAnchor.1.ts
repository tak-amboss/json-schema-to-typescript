export const input = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'FeatureRequest',
  title: 'FeatureRequest',
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
                        $dynamicAnchor: 'basicTextAllowedTypes',
                        oneOf: [{$ref: '#/$defs/ParagraphNode'}, {$ref: '#/$defs/TextNode'}],
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
    richContent: {
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
                        $dynamicAnchor: 'richContentAllowedTypes',
                        oneOf: [
                          {$ref: '#/$defs/ParagraphNode'},
                          {$ref: '#/$defs/TextNode'},
                          {$ref: '#/$defs/HeadingNode'},
                        ],
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
          required: ['type', 'children'],
          additionalProperties: false,
        },
      },
      required: ['root'],
      additionalProperties: false,
    },
    ParagraphNode: {
      $dynamicAnchor: 'basicTextAllowedTypes',
      type: 'object',
      properties: {
        type: {const: 'paragraph'},
        children: {
          type: 'array',
          items: {$dynamicRef: '#basicTextAllowedTypes'},
        },
      },
      required: ['type', 'children'],
      additionalProperties: false,
    },
    TextNode: {
      $dynamicAnchor: 'basicTextAllowedTypes',
      type: 'object',
      properties: {
        type: {const: 'text'},
        text: {type: 'string'},
      },
      required: ['type', 'text'],
      additionalProperties: false,
    },
    HeadingNode: {
      $dynamicAnchor: 'richContentAllowedTypes',
      type: 'object',
      properties: {
        type: {const: 'heading'},
        level: {type: 'number'},
        children: {
          type: 'array',
          items: {$dynamicRef: '#richContentAllowedTypes'},
        },
      },
      required: ['type', 'level', 'children'],
      additionalProperties: false,
    },
  },
}
