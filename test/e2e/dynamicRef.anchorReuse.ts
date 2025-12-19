export const input = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'TestSchema',
  type: 'object',
  properties: {
    topLevelField: {
      allOf: [
        {$ref: '#/$defs/RootNode'},
        {
          properties: {
            children: {
              items: {
                $dynamicAnchor: 'sharedTypes',
                oneOf: [
                  {$ref: '#/$defs/TextNode'},
                  {$ref: '#/$defs/ParagraphNode'}
                ]
              }
            }
          }
        }
      ]
    },
    arrayField: {
      type: 'array',
      items: {
        $ref: '#/$defs/ArrayItem'
      }
    }
  },
  $defs: {
    RootNode: {
      type: 'object',
      properties: {
        type: {const: 'root'},
        children: {type: 'array', items: {}}
      },
      required: ['type']
    },
    TextNode: {
      $dynamicAnchor: 'sharedTypes',
      type: 'object',
      properties: {
        type: {const: 'text'},
        text: {type: 'string'}
      },
      required: ['type', 'text']
    },
    ParagraphNode: {
      $dynamicAnchor: 'sharedTypes',
      type: 'object',
      properties: {
        type: {const: 'paragraph'},
        children: {
          type: 'array',
          items: {
            $dynamicRef: '#sharedTypes'
          }
        }
      },
      required: ['type']
    },
    ArrayItem: {
      type: 'object',
      properties: {
        nestedField: {
          allOf: [
            {$ref: '#/$defs/RootNode'},
            {
              properties: {
                children: {
                  items: {
                    $dynamicAnchor: 'sharedTypes',
                    oneOf: [
                      {$ref: '#/$defs/TextNode'},
                      {$ref: '#/$defs/ParagraphNode'}
                    ]
                  }
                }
              }
            }
          ]
        }
      }
    }
  }
}

