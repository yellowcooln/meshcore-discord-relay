import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let dependencyError = null;
let ChannelCrypto;
let loadConfig;

try {
  ({ ChannelCrypto } = await import('@michaelhart/meshcore-decoder/dist/crypto/channel-crypto.js'));
  ({ loadConfig } = await import('../src/config.js'));
} catch (err) {
  dependencyError = err;
}

const CONFIG_ENV_KEYS = [
  'DISCORD_TOKEN',
  'DISCORD_DELIVERY_MODE',
  'DISCORD_ROUTE_MODE',
  'DISCORD_MASTER_CHANNEL_ID',
  'DISCORD_DEFAULT_CHANNEL_ID',
  'MQTT_HOST',
  'MQTT_PORT',
  'MQTT_USERNAME',
  'MQTT_PASSWORD',
  'MQTT_TOPIC',
  'MQTT_TLS',
  'MQTT_TLS_INSECURE',
  'MQTT_CA_CERT',
  'MQTT_TRANSPORT',
  'MQTT_WS_PATH',
  'MQTT_CLIENT_ID',
  'MQTT_QOS',
  'CHANNELS_FILE',
  'WEBHOOKS_FILE',
  'RELAY_DEDUPE_SECONDS',
  'LOG_LEVEL',
  'MQTT_OBSERVER_ALLOWLIST',
  'RELAY_SHOW_PATH',
  'RELAY_BOT_MESSAGE_MODE',
  'RELAY_EMBED_COLOR',
  'RELAY_PATH_WAIT_MS',
  'RELAY_PATH_MAX_OBSERVERS',
  'RELAY_PATH_EDIT_UPDATES',
  'RELAY_PATH_EDIT_WINDOW_MS',
  'RELAY_PATH_EDIT_MIN_INTERVAL_MS'
];

function withConfigEnv(overrides, run) {
  const prior = new Map();
  for (const key of CONFIG_ENV_KEYS) {
    prior.set(key, process.env[key]);
    if (Object.prototype.hasOwnProperty.call(overrides, key)) {
      process.env[key] = overrides[key];
    } else {
      delete process.env[key];
    }
  }

  try {
    run();
  } finally {
    for (const key of CONFIG_ENV_KEYS) {
      const oldValue = prior.get(key);
      if (oldValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = oldValue;
      }
    }
  }
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'relay-config-test-'));
}

function skipIfMissingDeps(t) {
  if (!dependencyError) {
    return false;
  }
  t.skip(`dependencies not installed: ${dependencyError.code || dependencyError.message}`);
  return true;
}

test('loadConfig merges duplicate bot channel mappings from YAML', (t) => {
  if (skipIfMissingDeps(t)) {
    return;
  }
  const dir = makeTempDir();
  const secret = '8b3387e9c5cdea6ac9e5edbaa115cd72';
  const channelHash = ChannelCrypto.calculateChannelHash(secret).toLowerCase();
  const channelsPath = path.join(dir, 'channels.yaml');
  const webhooksPath = path.join(dir, 'webhooks.yaml');

  fs.writeFileSync(channelsPath, [
    'default_channel_id: "111111111111111111"',
    'channels:',
    '  - name: "public"',
    `    secret: "${secret}"`,
    '    discord_channel_ids:',
    '      - "123456789012345678"',
    '  - name: "public-2"',
    `    secret: "${secret.toUpperCase()}"`,
    '    discord_channel_id: "234567890123456789"',
    ''
  ].join('\n'));

  fs.writeFileSync(webhooksPath, 'default_webhook_url: ""\nchannels: []\n');

  withConfigEnv({
    DISCORD_DELIVERY_MODE: 'bot',
    DISCORD_ROUTE_MODE: 'per_channel',
    CHANNELS_FILE: channelsPath,
    WEBHOOKS_FILE: webhooksPath
  }, () => {
    const config = loadConfig();
    const mapping = config.channelMap.get(channelHash);
    assert.ok(mapping);
    assert.deepEqual(mapping.discordChannelIds.sort(), [
      '123456789012345678',
      '234567890123456789'
    ]);
    assert.equal(config.discord.defaultChannelId, '111111111111111111');
    assert.ok(config.channelSecrets.includes(secret));
  });
});

test('loadConfig supports webhook-only channels from YAML', (t) => {
  if (skipIfMissingDeps(t)) {
    return;
  }
  const dir = makeTempDir();
  const secret = '735aa8e36f9b2913a996fd760d621263';
  const channelHash = ChannelCrypto.calculateChannelHash(secret).toLowerCase();
  const channelsPath = path.join(dir, 'channels.yaml');
  const webhooksPath = path.join(dir, 'webhooks.yaml');

  fs.writeFileSync(channelsPath, 'channels: []\n');
  fs.writeFileSync(webhooksPath, [
    'default_webhook_urls:',
    '  - "https://discord.com/api/webhooks/default/one"',
    'channels:',
    '  - name: "Northbridge-Status"',
    `    secret: "${secret.toUpperCase()}"`,
    '    webhook_urls:',
    '      - "https://discord.com/api/webhooks/1/abc"',
    '      - "https://discord.com/api/webhooks/1/abc"',
    ''
  ].join('\n'));

  withConfigEnv({
    DISCORD_DELIVERY_MODE: 'webhook',
    CHANNELS_FILE: channelsPath,
    WEBHOOKS_FILE: webhooksPath
  }, () => {
    const config = loadConfig();
    const webhookRoute = config.webhooks.channelMap.get(channelHash);
    const channelRoute = config.channelMap.get(channelHash);

    assert.deepEqual(config.webhooks.defaultWebhookUrls, [
      'https://discord.com/api/webhooks/default/one'
    ]);
    assert.ok(webhookRoute);
    assert.deepEqual(webhookRoute.webhookUrls, [
      'https://discord.com/api/webhooks/1/abc'
    ]);
    assert.ok(channelRoute);
    assert.deepEqual(channelRoute.discordChannelIds, []);
    assert.ok(config.channelSecrets.includes(secret));
  });
});

test('loadConfig supports JSON files and normalizes relay settings', (t) => {
  if (skipIfMissingDeps(t)) {
    return;
  }
  const dir = makeTempDir();
  const secret = '9cd8fcf22a47333b591d96a2b848b73f';
  const channelHash = ChannelCrypto.calculateChannelHash(secret).toLowerCase();
  const channelsPath = path.join(dir, 'channels.json');
  const webhooksPath = path.join(dir, 'webhooks.json');

  fs.writeFileSync(channelsPath, JSON.stringify({
    default_channel_id: '345678901234567890',
    channels: [
      {
        name: 'test',
        secret: secret.toUpperCase(),
        discord_channel_id: '345678901234567890'
      }
    ]
  }, null, 2));

  fs.writeFileSync(webhooksPath, JSON.stringify({
    default_webhook_url: '',
    channels: [
      {
        hash: channelHash,
        webhook_url: 'https://discord.com/api/webhooks/2/xyz'
      }
    ]
  }, null, 2));

  withConfigEnv({
    DISCORD_DELIVERY_MODE: 'webhook',
    CHANNELS_FILE: channelsPath,
    WEBHOOKS_FILE: webhooksPath,
    RELAY_BOT_MESSAGE_MODE: 'DETAILED',
    MQTT_OBSERVER_ALLOWLIST: 'DeputyDawg - Observer, YC-Observer, deputydawg - observer',
    RELAY_EMBED_COLOR: 'not-a-color',
    RELAY_PATH_WAIT_MS: '-100',
    RELAY_PATH_MAX_OBSERVERS: '0',
    RELAY_PATH_EDIT_WINDOW_MS: '-1',
    RELAY_PATH_EDIT_MIN_INTERVAL_MS: '-2'
  }, () => {
    const config = loadConfig();
    const webhookRoute = config.webhooks.channelMap.get(channelHash);

    assert.ok(webhookRoute);
    assert.deepEqual(config.relay.observerAllowlist, [
      'deputydawg - observer',
      'yc-observer'
    ]);
    assert.equal(config.relay.botMessageMode, 'detailed');
    assert.equal(config.relay.embedColor, 0x1e2938);
    assert.equal(config.relay.pathWaitMs, 0);
    assert.equal(config.relay.pathMaxObservers, 1);
    assert.equal(config.relay.pathEditWindowMs, 0);
    assert.equal(config.relay.pathEditMinIntervalMs, 0);
  });
});
