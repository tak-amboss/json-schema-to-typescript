// Test for commit 0047aba: anyOf wrapper reuse (without keyName)
// Multiple fields wrapped in anyOf (nullable pattern) should all reuse the same anchor's type alias

export const input = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'TestAnyOfWrapper',
  type: 'object',
  properties: {
    topLevelField: {
      anyOf: [
        {
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
        {type: 'null'}
      ]
    },
    arrayField: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          field1: {
            anyOf: [
              {
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
              {type: 'null'}
            ]
          },
          field2: {
            anyOf: [
              {
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
              {type: 'null'}
            ]
          },
          field3: {
            anyOf: [
              {
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
              {type: 'null'}
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

