// Test for commit 23687c7: Unique anchors create their own type aliases
// Fields with different $dynamicAnchor names should each create their own type alias

export const input = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'TestUniqueAnchors',
  type: 'object',
  properties: {
    topLevelField: {
      allOf: [
        {$ref: '#/$defs/RootNode'},
        {
          properties: {
            children: {
              items: {
                $dynamicAnchor: 'topLevelTypes',
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
        type: 'object',
        properties: {
          nestedField: {
            allOf: [
              {$ref: '#/$defs/RootNode'},
              {
                properties: {
                  children: {
                    items: {
                      $dynamicAnchor: 'nestedTypes',
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
      type: 'object',
      properties: {
        type: {const: 'text'},
        text: {type: 'string'}
      },
      required: ['type', 'text']
    },
    ParagraphNode: {
      type: 'object',
      properties: {
        type: {const: 'paragraph'},
        children: {
          type: 'array',
          items: {
            $dynamicRef: '#nestedTypes'
          }
        }
      },
      required: ['type']
    }
  }
}

