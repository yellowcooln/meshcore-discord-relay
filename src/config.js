import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { ChannelCrypto } from '@michaelhart/meshcore-decoder/dist/crypto/channel-crypto.js';

function env(name, fallback = '') {
  const value = process.env[name];
  return value === undefined ? fallback : value;
}

function envBool(name, fallback = false) {
  const raw = env(name, '').trim().toLowerCase();
  if (!raw) {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function envInt(name, fallback) {
  const raw = env(name, '').trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function envList(name, fallback = []) {
  const raw = env(name, '').trim();
  if (!raw) {
    return fallback;
  }
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeRouteMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'master') {
    return 'master';
  }
  return 'per_channel';
}

function normalizeDeliveryMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'webhook') {
    return 'webhook';
  }
  return 'bot';
}

function normalizeBotMessageMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'detailed') {
    return 'detailed';
  }
  return 'simple';
}

function normalizeEmbedColor(value, fallback = 0x1e2938) {
  const raw = String(value || '')
    .trim()
    .replace(/^['"]+|['"]+$/g, '')
    .toLowerCase();
  if (!raw) {
    return fallback;
  }
  const normalized = raw.replace(/^#/, '').replace(/^0x/, '');
  if (!/^[0-9a-f]{6}$/.test(normalized)) {
    return fallback;
  }
  const parsed = Number.parseInt(normalized, 16);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function resolvePath(filePath) {
  if (!filePath) {
    return '';
  }
  if (path.isAbsolute(filePath)) {
    return filePath;
  }
  return path.join(process.cwd(), filePath);
}

function parseStructuredFile(resolved, label) {
  const raw = fs.readFileSync(resolved, 'utf8');
  const ext = path.extname(resolved).toLowerCase();

  let data;
  if (ext === '.yaml' || ext === '.yml') {
    data = yaml.load(raw);
  } else if (ext === '.json') {
    data = JSON.parse(raw);
  } else {
    // Unknown extension: try JSON first, then YAML.
    try {
      data = JSON.parse(raw);
    } catch {
      data = yaml.load(raw);
    }
  }

  if (!data || typeof data !== 'object') {
    console.warn(`[config] ${label} ${resolved} did not contain an object; using defaults.`);
    return {};
  }

  return data;
}

function loadChannelsFile(filePath) {
  if (!filePath) {
    return { defaultChannelId: '', channels: [] };
  }
  const resolved = resolvePath(filePath);
  if (!fs.existsSync(resolved)) {
    return { defaultChannelId: '', channels: [] };
  }
  try {
    const data = parseStructuredFile(resolved, 'Channels file');
    const defaultChannelId = data.default_channel_id || data.defaultChannelId || '';
    const channels = Array.isArray(data.channels) ? data.channels : [];
    return { defaultChannelId, channels };
  } catch (err) {
    console.warn(`[config] Failed to read channels file ${resolved}: ${err?.message || err}`);
    return { defaultChannelId: '', channels: [] };
  }
}

function normalizeHex(value) {
  if (!value || typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed.length % 2 !== 0) {
    return '';
  }
  if (!/^[0-9a-f]+$/.test(trimmed)) {
    return '';
  }
  return trimmed;
}

function normalizeDiscordChannelIds(entry) {
  const ids = [];

  const fromArray = entry.discord_channel_ids || entry.discordChannelIds;
  if (Array.isArray(fromArray)) {
    for (const item of fromArray) {
      const id = String(item || '').trim();
      if (id) {
        ids.push(id);
      }
    }
  }

  const singleId = String(entry.discord_channel_id || entry.discordChannelId || '').trim();
  if (singleId) {
    ids.push(singleId);
  }

  return [...new Set(ids)];
}

function normalizeWebhookUrls(entry) {
  const urls = [];

  const fromArray = entry.webhook_urls || entry.webhookUrls || entry.default_webhook_urls || entry.defaultWebhookUrls;
  if (Array.isArray(fromArray)) {
    for (const item of fromArray) {
      const url = String(item || '').trim();
      if (url) {
        urls.push(url);
      }
    }
  }

  const singleUrl = String(entry.webhook_url || entry.webhookUrl || entry.default_webhook_url || entry.defaultWebhookUrl || '').trim();
  if (singleUrl) {
    urls.push(singleUrl);
  }

  return [...new Set(urls)];
}

function loadWebhooksFile(filePath) {
  if (!filePath) {
    return { defaultWebhookUrls: [], channels: [] };
  }
  const resolved = resolvePath(filePath);
  if (!fs.existsSync(resolved)) {
    return { defaultWebhookUrls: [], channels: [] };
  }
  try {
    const data = parseStructuredFile(resolved, 'Webhooks file');
    const defaultWebhookUrls = normalizeWebhookUrls(data);
    const channels = Array.isArray(data.channels) ? data.channels : [];
    return { defaultWebhookUrls, channels };
  } catch (err) {
    console.warn(`[config] Failed to read webhooks file ${resolved}: ${err?.message || err}`);
    return { defaultWebhookUrls: [], channels: [] };
  }
}

export function loadConfig() {
  const channelsFile = env('CHANNELS_FILE', 'channels.yaml');
  const channelsFileData = loadChannelsFile(channelsFile);
  const defaultChannelId = env('DISCORD_DEFAULT_CHANNEL_ID', channelsFileData.defaultChannelId || '').trim();
  const discordDeliveryMode = normalizeDeliveryMode(env('DISCORD_DELIVERY_MODE', 'bot'));

  const channelSecrets = new Set();
  const channelMap = new Map();
  const channelNameMap = new Map();

  for (const entry of channelsFileData.channels) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const secret = normalizeHex(entry.secret || '');
    const hashOverride = normalizeHex(entry.hash || '');
    const name = String(entry.name || entry.label || '').trim();

    let channelHash = '';
    if (secret) {
      channelHash = ChannelCrypto.calculateChannelHash(secret).toLowerCase();
      channelSecrets.add(secret);
    } else if (hashOverride) {
      channelHash = hashOverride;
    }

    if (!channelHash) {
      console.warn('[config] Channel entry missing secret/hash, skipping.');
      continue;
    }

    const discordChannelIds = normalizeDiscordChannelIds(entry);
    if (discordDeliveryMode === 'bot' && discordChannelIds.length === 0) {
      console.warn(`[config] Channel entry ${name || channelHash} missing discord_channel_id(s), skipping in bot mode.`);
      continue;
    }

    const existing = channelMap.get(channelHash);
    if (existing) {
      const mergedChannelIds = [...new Set([...existing.discordChannelIds, ...discordChannelIds])];
      if (mergedChannelIds.length !== existing.discordChannelIds.length) {
        console.warn(`[config] Duplicate channel hash ${channelHash} detected, merging Discord channel mappings.`);
      }
      existing.discordChannelIds = mergedChannelIds;
      if (!existing.name && name) {
        existing.name = name;
      }
      if (!existing.secret && secret) {
        existing.secret = secret;
      }
      if (name) {
        channelNameMap.set(name.toLowerCase(), channelHash);
      }
      continue;
    }

    channelMap.set(channelHash, {
      name,
      channelHash,
      discordChannelIds,
      secret: secret || ''
    });
    if (name) {
      channelNameMap.set(name.toLowerCase(), channelHash);
    }
  }

  const webhooksFile = env('WEBHOOKS_FILE', 'webhooks.yaml').trim();
  const webhooksFileData = loadWebhooksFile(webhooksFile);
  const webhookMap = new Map();

  if (discordDeliveryMode === 'webhook') {
    for (const entry of webhooksFileData.channels) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }

      const webhookUrls = normalizeWebhookUrls(entry);
      if (webhookUrls.length === 0) {
        console.warn('[config] Webhook entry missing webhook_url(s), skipping.');
        continue;
      }

      const secret = normalizeHex(entry.secret || '');
      const hashOverride = normalizeHex(entry.hash || '');
      const name = String(entry.name || entry.label || '').trim();

      let channelHash = '';
      if (secret) {
        channelHash = ChannelCrypto.calculateChannelHash(secret).toLowerCase();
      } else if (hashOverride) {
        channelHash = hashOverride;
      } else if (name) {
        channelHash = channelNameMap.get(name.toLowerCase()) || '';
      }

      if (!channelHash) {
        console.warn(`[config] Webhook entry ${name || '(unnamed)'} missing secret/hash/name match, skipping.`);
        continue;
      }

      if (secret) {
        channelSecrets.add(secret);
      }
      if (name) {
        channelNameMap.set(name.toLowerCase(), channelHash);
      }

      const existingChannel = channelMap.get(channelHash);
      if (existingChannel) {
        if (!existingChannel.secret && secret) {
          existingChannel.secret = secret;
        }
        if (!existingChannel.name && name) {
          existingChannel.name = name;
        }
      } else {
        // In webhook mode, allow webhook config to define channel hash/name/secret
        // so decryption and label lookup can work without channel mappings.
        channelMap.set(channelHash, {
          name,
          channelHash,
          discordChannelIds: [],
          secret: secret || ''
        });
      }

      const existing = webhookMap.get(channelHash);
      if (existing) {
        existing.webhookUrls = [...new Set([...existing.webhookUrls, ...webhookUrls])];
        if (!existing.name && name) {
          existing.name = name;
        }
        continue;
      }

      webhookMap.set(channelHash, {
        name,
        channelHash,
        webhookUrls
      });
    }
  }

  const mqttHost = env('MQTT_HOST', 'localhost');
  const mqttPort = envInt('MQTT_PORT', 1883);
  const mqttTopic = env('MQTT_TOPIC', 'meshcore/#');
  const mqttTransport = env('MQTT_TRANSPORT', 'tcp').trim().toLowerCase();
  const mqttWsPath = env('MQTT_WS_PATH', '/mqtt');
  const mqttTls = envBool('MQTT_TLS', false);
  const mqttTlsInsecure = envBool('MQTT_TLS_INSECURE', false);
  const mqttCaCertPath = env('MQTT_CA_CERT', '').trim();

  const mqtt = {
    host: mqttHost,
    port: mqttPort,
    topic: mqttTopic,
    transport: mqttTransport,
    wsPath: mqttWsPath,
    tls: mqttTls,
    tlsInsecure: mqttTlsInsecure,
    caCertPath: mqttCaCertPath,
    clientId: env('MQTT_CLIENT_ID', '').trim(),
    username: env('MQTT_USERNAME', '').trim(),
    password: env('MQTT_PASSWORD', '').trim(),
    qos: envInt('MQTT_QOS', 0)
  };

  const relay = {
    dedupeSeconds: envInt('RELAY_DEDUPE_SECONDS', 45),
    logLevel: env('LOG_LEVEL', 'info').trim().toLowerCase(),
    observerAllowlist: [...new Set(envList('MQTT_OBSERVER_ALLOWLIST').map((name) => name.toLowerCase()))],
    showPath: envBool('RELAY_SHOW_PATH', false),
    botMessageMode: normalizeBotMessageMode(env('RELAY_BOT_MESSAGE_MODE', 'simple')),
    pathWaitMs: Math.max(0, envInt('RELAY_PATH_WAIT_MS', 1200)),
    pathMaxObservers: Math.max(1, envInt('RELAY_PATH_MAX_OBSERVERS', 8)),
    pathEditUpdates: envBool('RELAY_PATH_EDIT_UPDATES', true),
    pathEditWindowMs: Math.max(0, envInt('RELAY_PATH_EDIT_WINDOW_MS', 15000)),
    pathEditMinIntervalMs: Math.max(0, envInt('RELAY_PATH_EDIT_MIN_INTERVAL_MS', 3000)),
    embedColor: normalizeEmbedColor(env('RELAY_EMBED_COLOR', '#1e2938'))
  };

  const discord = {
    token: env('DISCORD_TOKEN', '').trim(),
    deliveryMode: discordDeliveryMode,
    defaultChannelId,
    routeMode: normalizeRouteMode(env('DISCORD_ROUTE_MODE', 'per_channel')),
    masterChannelId: env('DISCORD_MASTER_CHANNEL_ID', '').trim()
  };

  return {
    mqtt,
    relay,
    discord,
    webhooks: {
      file: webhooksFile,
      defaultWebhookUrls: webhooksFileData.defaultWebhookUrls,
      channelMap: webhookMap
    },
    channelSecrets: [...channelSecrets],
    channelMap
  };
}
