# Debug Instructions for Phase 3 Not Working

## The Issue

Your environment shows an intersection, but my tests show clean output with the same schema. Let's debug this systematically.

---

## Step 1: Verify the Fix is Installed

Check that the array detection fix is actually in your installed version:

```bash
# Navigate to the installed package
cd node_modules/.pnpm/json-schema-to-typescript@*/node_modules/json-schema-to-typescript/

# Check the specific line in parser.ts (or parser.js if built)
grep -A2 "Look for array with items" src/parser.ts

# Expected output should include:
# const isArray = propSchema.type === 'array' || (propSchema.items && !propSchema.properties)
```

If you see the old code (`if (propSchema.type === 'array' && propSchema.items)`), the fix is NOT installed.

---

## Step 2: Check Build Artifacts

The TypeScript source needs to be compiled to JavaScript:

```bash
# Check if dist/ directory exists
ls -la node_modules/.pnpm/json-schema-to-typescript@*/node_modules/json-schema-to-typescript/dist/src/

# Check the compiled parser.js file
grep -A2 "Look for array with items" node_modules/.pnpm/json-schema-to-typescript@*/node_modules/json-schema-to-typescript/dist/src/parser.js
```

The fix needs to be in BOTH `src/parser.ts` AND `dist/src/parser.js`.

---

## Step 3: Run with Verbose Logging

```bash
# Create a test schema file
cat > /tmp/test-phase3.json << 'EOF'
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "TestPhase3",
  "type": "object",
  "properties": {
    "basicText": {
      "anyOf": [
        {
          "allOf": [
            { "$ref": "#/$defs/Base" },
            {
              "properties": {
                "root": {
                  "properties": {
                    "children": {
                      "items": {
                        "$dynamicAnchor": "types",
                        "oneOf": [
                          { "$ref": "#/$defs/Node1" }
                        ]
                      }
                    }
                  }
                }
              }
            }
          ]
        },
        { "type": "null" }
      ]
    }
  },
  "$defs": {
    "Base": {
      "type": "object",
      "properties": {
        "root": {
          "type": "object",
          "properties": {
            "children": { "type": "array", "items": {} }
          }
        }
      }
    },
    "Node1": {
      "$dynamicAnchor": "types",
      "type": "object",
      "properties": {
        "type": { "const": "node1" }
      }
    }
  }
}
EOF

# Run with verbose logging
VERBOSE=1 pnpm json-schema-to-typescript -i /tmp/test-phase3.json 2>&1 | grep -E "(Pattern 2|isRecursiveUnion|Using type alias)"
```

**Expected output:**
```
debug parser Pattern 2: baseMember=true, overrideMember=true, baseName=Base
debug parser Pattern 2: interfaceName=Base, isGeneric=true
debug parser Pattern 2: isRecursiveUnion=true, ...
debug parser Pattern 2: Using currentTypeAliasName from context: TestPhase3BasicTextChildren
debug parser Pattern 2: Using type alias TestPhase3BasicTextChildren instead of raw union
```

If you DON'T see "Using type alias", Pattern 2 is not triggering.

---

## Step 4: Check the Generated Output

```bash
# Generate the types
pnpm json-schema-to-typescript -i /tmp/test-phase3.json -o /tmp/test-phase3.d.ts

# Check the specific field
grep -A5 "basicText" /tmp/test-phase3.d.ts
```

**Expected (CLEAN):**
```typescript
basicText?: Base<TestPhase3BasicTextChildren> | null;
```

**Broken (with intersection):**
```typescript
basicText?: Base<TestPhase3BasicTextChildren> & {
  root?: { children?: ...; };
} | null;
```

---

## Step 5: Verify Git Commit

```bash
cd node_modules/.pnpm/json-schema-to-typescript@*/node_modules/json-schema-to-typescript/

# Check git history (if .git exists)
git log --oneline -5
```

**Expected to see:**
```
4bb479e fix: Phase 3 not working - extractTypeArgumentFromOverride missing arrays without explicit type
```

---

## Common Issues

### Issue A: Not Rebuilt After Install

**Problem:** The fix is in `src/parser.ts` but not in `dist/src/parser.js`

**Solution:**
```bash
cd node_modules/.pnpm/json-schema-to-typescript@*/node_modules/json-schema-to-typescript/
npm run build
```

### Issue B: Wrong Package Version

**Problem:** pnpm installed a cached version

**Solution:**
```bash
rm -rf node_modules/.pnpm
rm -rf ~/.pnpm-store  # Nuclear option!
pnpm install --force
```

### Issue C: Multiple Installations

**Problem:** Multiple versions of json-schema-to-typescript installed

**Solution:**
```bash
# Check all installations
find node_modules -name "json-schema-to-typescript" -type d

# Should only be ONE in .pnpm
```

### Issue D: Looking at Old Files

**Problem:** Generated types are from before the fix

**Solution:**
```bash
# Delete ALL generated files
rm -rf src/generated-types.ts
rm -rf public/schemas/**/*.d.ts

# Regenerate
pnpm generate:all
```

---

## Share Results

Please run Steps 1-4 and share:

1. **Step 1 output:** Does the fix appear in `parser.ts`?
2. **Step 2 output:** Does the fix appear in `dist/src/parser.js`?
3. **Step 3 output:** Does verbose logging show "Using type alias"?
4. **Step 4 output:** What does the generated `basicText` field look like?

This will help us identify exactly where the issue is!

