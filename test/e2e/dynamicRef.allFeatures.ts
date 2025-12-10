export const input = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'AllFeaturesCMS',
  type: 'object',
  properties: {
    basicText: {
      anyOf: [
        {
          allOf: [
            {$ref: '#/$defs/RichTextBase'},
            {
              properties: {
                root: {
                  properties: {
                    children: {
                      type: 'array',
                      items: {
                        $dynamicAnchor: 'basicTextTypes',
                        oneOf: [
                          {$ref: '#/$defs/ParagraphNode'},
                          {$ref: '#/$defs/TextNode'},
                          {$ref: '#/$defs/RootNode'},
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
    constrainedHeading: {
      anyOf: [
        {
          allOf: [
            {$ref: '#/$defs/RichTextBase'},
            {
              properties: {
                root: {
                  properties: {
                    children: {
                      type: 'array',
                      items: {
                        $dynamicAnchor: 'constrainedHeadingTypes',
                        oneOf: [
                          {
                            allOf: [
                              {$ref: '#/$defs/HeadingNode'},
                              {
                                properties: {
                                  tag: {enum: ['h2', 'h3', 'h4']},
                                },
                              },
                            ],
                          },
                          {$ref: '#/$defs/TextNode'},
                          {$ref: '#/$defs/RootNode'},
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
    RichTextBase: {
      type: 'object',
      properties: {
        root: {
          type: 'object',
          properties: {
            type: {const: 'root'},
            children: {
              type: 'array',
              items: {},
            },
          },
        },
      },
    },
    RootNode: {
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
    ParagraphNode: {
      $dynamicAnchor: 'basicTextTypes',
      type: 'object',
      properties: {
        type: {const: 'paragraph'},
        children: {
          type: 'array',
          items: {$dynamicRef: '#basicTextTypes'},
        },
      },
    },
    HeadingNode: {
      $dynamicAnchor: 'constrainedHeadingTypes',
      type: 'object',
      properties: {
        type: {const: 'heading'},
        tag: {type: 'string'},
        children: {
          type: 'array',
          items: {$dynamicRef: '#constrainedHeadingTypes'},
        },
      },
    },
    TextNode: {
      $dynamicAnchor: 'basicTextTypes',
      type: 'object',
      properties: {
        type: {const: 'text'},
        text: {type: 'string'},
      },
    },
  },
}

