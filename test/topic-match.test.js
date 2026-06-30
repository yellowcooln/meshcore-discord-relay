import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isTopicAllowed,
  isValidTopicFilter,
  normalizeTopicWhitelist,
  topicMatchesPattern
} from '../src/topic-match.js';

test('topicMatchesPattern matches exact topics', () => {
  assert.equal(topicMatchesPattern('meshcore/DEN/status', 'meshcore/DEN/status'), true);
  assert.equal(topicMatchesPattern('meshcore/DEN/status', 'meshcore/FNL/status'), false);
  assert.equal(topicMatchesPattern('meshcore/DEN/status/extra', 'meshcore/DEN/status'), false);
});

test('topicMatchesPattern supports single-level wildcards', () => {
  assert.equal(topicMatchesPattern('meshcore/DEN/status', 'meshcore/+/status'), true);
  assert.equal(topicMatchesPattern('meshcore/DEN/observer/alpha', 'meshcore/+/observer'), false);
});

test('topicMatchesPattern supports multi-level wildcards', () => {
  assert.equal(topicMatchesPattern('meshcore/DEN/status', 'meshcore/DEN/#'), true);
  assert.equal(topicMatchesPattern('meshcore/DEN/observer/alpha', 'meshcore/DEN/#'), true);
  assert.equal(topicMatchesPattern('meshcore/DEN', 'meshcore/DEN/#'), true);
  assert.equal(topicMatchesPattern('meshcore/FNL/status', 'meshcore/DEN/#'), false);
});

test('topicMatchesPattern rejects invalid MQTT filters', () => {
  assert.equal(topicMatchesPattern('meshcore/DEN/status', 'meshcore/#/status'), false);
  assert.equal(topicMatchesPattern('meshcore/DEN/status', 'meshcore/foo#'), false);
  assert.equal(topicMatchesPattern('meshcore/DEN/status', 'meshcore/+status'), false);
});

test('isValidTopicFilter enforces MQTT wildcard placement', () => {
  assert.equal(isValidTopicFilter('meshcore/DEN/#'), true);
  assert.equal(isValidTopicFilter('meshcore/+/status'), true);
  assert.equal(isValidTopicFilter('meshcore/#/status'), false);
  assert.equal(isValidTopicFilter('meshcore/foo#'), false);
  assert.equal(isValidTopicFilter('meshcore/+status'), false);
});

test('normalizeTopicWhitelist drops invalid filters and duplicates', () => {
  const warnings = [];
  assert.deepEqual(normalizeTopicWhitelist([
    ' meshcore/DEN/# ',
    'meshcore/#/status',
    'meshcore/DEN/#',
    'meshcore/FNL/+'
  ], (message) => warnings.push(message)), [
    'meshcore/DEN/#',
    'meshcore/FNL/+'
  ]);
  assert.equal(warnings.length, 1);
});

test('isTopicAllowed allows all topics when whitelist is empty', () => {
  assert.equal(isTopicAllowed('meshcore/DEN/status', []), true);
});

test('isTopicAllowed requires at least one whitelist match', () => {
  const whitelist = ['meshcore/DEN/#', 'meshcore/FNL/+'];
  assert.equal(isTopicAllowed('meshcore/DEN/observer/alpha', whitelist), true);
  assert.equal(isTopicAllowed('meshcore/FNL/status', whitelist), true);
  assert.equal(isTopicAllowed('meshcore/FNL/observer/alpha', whitelist), false);
  assert.equal(isTopicAllowed('meshcore/SEA/status', whitelist), false);
});
