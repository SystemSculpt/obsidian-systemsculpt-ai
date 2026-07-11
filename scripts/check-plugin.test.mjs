import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('fast plugin gate invokes the live network-egress analyzer and reports its diagnostics', () => {
  const source = fs.readFileSync(new URL('./check-plugin.mjs', import.meta.url), 'utf8');
  assert.match(source, /network-egress-inventory\.mjs current --fixture testing\/fixtures\/managed\/egress-baseline-660e7fe\.json/);
  assert.match(source, /results\.push\(\{ name: 'egress'/);
  assert.match(source, /Network egress inventory mismatch/);
  assert.match(source, /r\.stdout \|\| r\.stderr/);
});
