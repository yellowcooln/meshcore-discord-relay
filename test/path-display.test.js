import test from 'node:test';
import assert from 'node:assert/strict';

import { formatPathSuffix, normalizeRoutePath } from '../src/path-display.js';

test('normalizeRoutePath keeps 1-byte, 2-byte, and 3-byte hop hashes', () => {
  assert.deepEqual(
    normalizeRoutePath(['22', '97af', '25b1c0', 'bad-hop', '', null]),
    ['22', '97af', '25b1c0']
  );
});

test('formatPathSuffix uppercases 2-byte and 3-byte hop hashes', () => {
  assert.equal(
    formatPathSuffix(['22', '97af', '25b1c0'], true, 8),
    '[`22`,`97AF`,`25B1C0`]'
  );
});

test('formatPathSuffix respects max path entries', () => {
  assert.equal(
    formatPathSuffix(['22', '97af', '25b1c0'], true, 2),
    '[`22`,`97AF`,+1]'
  );
});
