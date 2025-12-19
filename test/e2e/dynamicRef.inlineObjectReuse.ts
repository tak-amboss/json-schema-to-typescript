// Test for commit 05ff833: Inline object anchor reuse (without parentName)
// Multiple fields in inline objects (array items) should reuse the same anchor's type alias

export const input = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'TestInlineObjectReuse',
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
        type: 'object',
        properties: {
          field1: {
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
          field2: {
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
          field3: {
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
    }
  }
}

