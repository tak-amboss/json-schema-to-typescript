// Test for non-recursive $dynamicAnchor type aliases in inline nested objects
// Each unique $dynamicAnchor should generate its own type alias, even for non-recursive unions

export const input = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'TestInlineNestedObject',
  type: 'object',
  properties: {
    adult: {
      type: 'object',
      properties: {
        standardDosage: {
          allOf: [
            {$ref: '#/$defs/SerializedRootNode'},
            {
              properties: {
                children: {
                  items: {
                    $dynamicAnchor: 'AdultStandardDosageTypes',
                    oneOf: [{$ref: '#/$defs/SerializedTextNode'}, {$ref: '#/$defs/SerializedParagraphNode'}],
                  },
                },
              },
            },
          ],
        },
        dani: {
          allOf: [
            {$ref: '#/$defs/SerializedRootNode'},
            {
              properties: {
                children: {
                  items: {
                    $dynamicAnchor: 'AdultDaniTypes',
                    oneOf: [{$ref: '#/$defs/SerializedTextNode'}, {$ref: '#/$defs/SerializedLineBreakNode'}],
                  },
                },
              },
            },
          ],
        },
      },
    },
    pediatric: {
      type: 'object',
      properties: {
        standardDosage: {
          allOf: [
            {$ref: '#/$defs/SerializedRootNode'},
            {
              properties: {
                children: {
                  items: {
                    $dynamicAnchor: 'PediatricStandardDosageTypes',
                    oneOf: [{$ref: '#/$defs/SerializedTextNode'}],
                  },
                },
              },
            },
          ],
        },
      },
    },
  },
  $defs: {
    SerializedRootNode: {
      type: 'object',
      properties: {
        type: {const: 'root'},
        children: {type: 'array', items: {}},
      },
      required: ['type'],
    },
    SerializedTextNode: {
      $dynamicAnchor: 'AdultStandardDosageTypes',
      type: 'object',
      properties: {
        type: {const: 'text'},
        text: {type: 'string'},
      },
      required: ['type', 'text'],
    },
    SerializedParagraphNode: {
      $dynamicAnchor: 'AdultStandardDosageTypes',
      type: 'object',
      properties: {
        type: {const: 'paragraph'},
        children: {
          type: 'array',
          items: {$dynamicRef: '#AdultStandardDosageTypes'},
        },
      },
      required: ['type'],
    },
    SerializedLineBreakNode: {
      $dynamicAnchor: 'AdultDaniTypes',
      type: 'object',
      properties: {
        type: {const: 'linebreak'},
      },
      required: ['type'],
    },
  },
}

