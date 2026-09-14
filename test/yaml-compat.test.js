import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';

function fixture(t, channels, webhooks = 'channels: []\n', extension = 'yaml') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-yaml-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const prior = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (/^(DISCORD_|MQTT_|RELAY_|CHANNELS_FILE$|WEBHOOKS_FILE$)/.test(key)) delete process.env[key];
  }
  t.after(() => { process.env = prior; });
  process.env.DISCORD_DELIVERY_MODE = 'webhook';
  process.env.CHANNELS_FILE = path.join(dir, `channels.${extension}`);
  process.env.WEBHOOKS_FILE = path.join(dir, `webhooks.${extension}`);
  fs.writeFileSync(process.env.CHANNELS_FILE, channels);
  fs.writeFileSync(process.env.WEBHOOKS_FILE, webhooks);
  const warnings = [];
  t.mock.method(console, 'warn', (message) => warnings.push(message));
  return warnings;
}

for (const extension of ['yaml', 'yml', 'config']) {
  test(`YAML ${extension} config preserves merge keys and scalar names`, (t) => {
    const warnings = fixture(t, [
      'defaults: &defaults',
      '  discord_channel_id: "123456789012345678"',
      'channels:',
      '  - <<: *defaults',
      '    hash: "ab"',
      '    name: on',
      ''
    ].join('\n'), [
      'defaults: &defaults',
      '  webhook_url: "https://discord.com/api/webhooks/1/example"',
      'channels:',
      '  - <<: *defaults',
      '    hash: "ab"',
      ''
    ].join('\n'), extension);
    const config = loadConfig();
    assert.deepEqual(config.channelMap.get('ab').discordChannelIds, ['123456789012345678']);
    assert.equal(config.channelMap.get('ab').name, 'on');
    assert.deepEqual(config.webhooks.channelMap.get('ab').webhookUrls, ['https://discord.com/api/webhooks/1/example']);
    assert.deepEqual(warnings, []);
  });
}

for (const content of ['', '  \n# only a comment\n']) {
  test(`empty YAML config keeps defaults (${JSON.stringify(content)})`, (t) => {
    const warnings = fixture(t, content, content);
    const config = loadConfig();
    assert.equal(config.channelMap.size, 0);
    assert.deepEqual(config.webhooks.defaultWebhookUrls, []);
    assert.equal(warnings.some((message) => message.includes('Failed to read')), false);
  });
}

for (const content of ['default_channel_id: "123"\n---\ndefault_channel_id: "456"', 'channels: [']) {
  test(`invalid or multi-document YAML is rejected (${JSON.stringify(content)})`, (t) => {
    const warnings = fixture(t, content);
    const config = loadConfig();
    assert.equal(config.discord.defaultChannelId, '');
    assert.ok(warnings.some((message) => message.includes('Failed to read channels file')));
  });
}
