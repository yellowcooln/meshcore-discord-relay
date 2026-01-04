import fs from 'fs';
import path from 'path';
import { ChannelCrypto } from '@michaelhart/meshcore-decoder';

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

function resolvePath(filePath) {
  if (!filePath) {
    return '';
  }
  if (path.isAbsolute(filePath)) {
    return filePath;
  }
  return path.join(process.cwd(), filePath);
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
    const raw = fs.readFileSync(resolved, 'utf8');
    const data = JSON.parse(raw);
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

export function loadConfig() {
  const channelsFile = env('CHANNELS_FILE', 'channels.json');
  const channelsFileData = loadChannelsFile(channelsFile);
  const defaultChannelId = env('DISCORD_DEFAULT_CHANNEL_ID', channelsFileData.defaultChannelId || '').trim();

  const channelSecrets = [];
  const channelMap = new Map();

  for (const entry of channelsFileData.channels) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const discordChannelId = String(entry.discord_channel_id || entry.discordChannelId || '').trim();
    if (!discordChannelId) {
      console.warn('[config] Channel entry missing discord_channel_id, skipping.');
      continue;
    }

    const secret = normalizeHex(entry.secret || '');
    const hashOverride = normalizeHex(entry.hash || '');
    const name = String(entry.name || entry.label || '').trim();

    let channelHash = '';
    if (secret) {
      channelHash = ChannelCrypto.calculateChannelHash(secret).toLowerCase();
      channelSecrets.push(secret);
    } else if (hashOverride) {
      channelHash = hashOverride;
    }

    if (!channelHash) {
      console.warn(`[config] Channel entry missing secret/hash for ${discordChannelId}, skipping.`);
      continue;
    }

    if (channelMap.has(channelHash)) {
      console.warn(`[config] Duplicate channel hash ${channelHash} detected, keeping first mapping.`);
      continue;
    }

    channelMap.set(channelHash, {
      name,
      channelHash,
      discordChannelId,
      secret: secret || ''
    });
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
    logLevel: env('LOG_LEVEL', 'info').trim().toLowerCase()
  };

  const discord = {
    token: env('DISCORD_TOKEN', '').trim(),
    defaultChannelId
  };

  return {
    mqtt,
    relay,
    discord,
    channelSecrets,
    channelMap
  };
}
