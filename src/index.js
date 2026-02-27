import fs from 'fs';
import path from 'path';
import mqtt from 'mqtt';
import { Client, GatewayIntentBits } from 'discord.js';
import { MeshCoreDecoder, PayloadType } from '@michaelhart/meshcore-decoder';
import dotenv from 'dotenv';

import { loadConfig } from './config.js';
import { extractPacketHex } from './packet-extract.js';

dotenv.config();

const config = loadConfig();

const LOG_LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};
const currentLogLevel = LOG_LEVELS[config.relay.logLevel] || LOG_LEVELS.info;

function log(level, message) {
  const value = LOG_LEVELS[level] || LOG_LEVELS.info;
  if (value < currentLogLevel) {
    return;
  }
  const prefix = `[relay] ${level.toUpperCase()}`;
  if (level === 'error') {
    console.error(`${prefix} ${message}`);
  } else if (level === 'warn') {
    console.warn(`${prefix} ${message}`);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

if (!config.discord.token) {
  log('error', 'DISCORD_TOKEN is required.');
  process.exit(1);
}

if (!config.discord.defaultChannelId && config.channelMap.size === 0) {
  log('warn', 'No default Discord channel and no channel mappings configured.');
}

const keyStore = config.channelSecrets.length > 0
  ? MeshCoreDecoder.createKeyStore({ channelSecrets: config.channelSecrets })
  : null;

const discordClient = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const channelCache = new Map();

async function getDiscordChannel(channelId) {
  if (channelCache.has(channelId)) {
    return channelCache.get(channelId);
  }
  try {
    const channel = await discordClient.channels.fetch(channelId);
    if (channel && channel.isTextBased()) {
      channelCache.set(channelId, channel);
      return channel;
    }
  } catch (err) {
    log('warn', `Failed to fetch Discord channel ${channelId}: ${err?.message || err}`);
  }
  return null;
}

const dedupeWindowMs = Math.max(5, config.relay.dedupeSeconds) * 1000;
const dedupeCache = new Map();
const observerAllowlist = new Set(config.relay.observerAllowlist || []);
const observerAllowlistCompact = [...observerAllowlist]
  .map((name) => name.replace(/[^a-z0-9]+/g, ''))
  .filter(Boolean);

function normalizeObserverName(value) {
  if (!value || typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim().replace(/^['"]+|['"]+$/g, '').toLowerCase();
  return trimmed;
}

function compactObserverName(value) {
  return normalizeObserverName(value).replace(/[^a-z0-9]+/g, '');
}

function isObserverAllowed(observer) {
  const normalized = normalizeObserverName(observer);
  if (!normalized) {
    return false;
  }
  if (observerAllowlist.has(normalized)) {
    return true;
  }

  const compact = compactObserverName(normalized);
  if (!compact) {
    return false;
  }

  return observerAllowlistCompact.some((allowed) => compact.includes(allowed) || allowed.includes(compact));
}

function extractObserversFromTopic(topic) {
  if (!topic || typeof topic !== 'string') {
    return [];
  }

  const decodedTopic = topic
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });

  const observers = new Set();

  for (let i = 0; i < decodedTopic.length; i += 1) {
    const segment = decodedTopic[i];
    const lower = segment.toLowerCase();

    if ((lower === 'status' || lower === 'observer' || lower === 'observers') && i + 1 < decodedTopic.length) {
      const next = normalizeObserverName(decodedTopic[i + 1]);
      if (next) {
        observers.add(next);
      }
    }

    const kvMatch = segment.match(/^(status|observer|observers)\s*[:=]\s*(.+)$/i);
    if (kvMatch) {
      const value = normalizeObserverName(kvMatch[2]);
      if (value) {
        observers.add(value);
      }
    }
  }

  const joined = decodedTopic.join('/');
  const regex = /(?:^|\/)(?:status|observer|observers)(?:\/|:|=)([^/]+)/gi;
  let match;
  while ((match = regex.exec(joined)) !== null) {
    const value = normalizeObserverName(match[1]);
    if (value) {
      observers.add(value);
    }
  }

  return [...observers];
}

function extractObserversFromPayload(payloadBuffer) {
  if (!payloadBuffer || payloadBuffer.length === 0) {
    return [];
  }

  const text = payloadBuffer.toString('utf8').trim();
  if (!text || !text.startsWith('{') || !text.endsWith('}')) {
    return [];
  }

  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return [];
  }

  const observers = new Set();
  const queue = [obj];
  const observerKeys = new Set(['origin', 'observer', 'observer_name', 'observerName', 'name']);
  let visited = 0;

  while (queue.length > 0 && visited < 100) {
    const current = queue.shift();
    visited += 1;
    if (!current || typeof current !== 'object') {
      continue;
    }

    for (const [key, value] of Object.entries(current)) {
      if (observerKeys.has(key) && typeof value === 'string') {
        const normalized = normalizeObserverName(value);
        if (normalized) {
          observers.add(normalized);
        }
      }

      if (value && typeof value === 'object') {
        queue.push(value);
      }
    }
  }

  return [...observers];
}

function shouldRelayMessage(key, now) {
  const lastSeen = dedupeCache.get(key);
  if (lastSeen && now - lastSeen < dedupeWindowMs) {
    return false;
  }
  dedupeCache.set(key, now);
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of dedupeCache.entries()) {
    if (now - ts > dedupeWindowMs) {
      dedupeCache.delete(key);
    }
  }
}, Math.max(10000, dedupeWindowMs));

function formatRelayMessage(channelInfo, payload, packet) {
  const sender = payload.decrypted?.sender ? `${payload.decrypted.sender}: ` : '';
  const body = (payload.decrypted?.message || '').trim();
  if (!body) {
    return '';
  }
  let text = `${sender}${body}`.trim();
  if (text.length > 1900) {
    text = `${text.slice(0, 1890)}...`;
  }
  return text;
}

function pickChannels(channelHash) {
  const channelInfo = config.channelMap.get(channelHash) || null;
  if (channelInfo?.discordChannelIds?.length) {
    return {
      channelIds: channelInfo.discordChannelIds,
      channelInfo
    };
  }
  return {
    channelIds: config.discord.defaultChannelId ? [config.discord.defaultChannelId] : [],
    channelInfo
  };
}

async function handlePacket(topic, payload) {
  if (observerAllowlist.size > 0) {
    const observers = [
      ...extractObserversFromTopic(topic),
      ...extractObserversFromPayload(payload)
    ];
    const allowed = observers.some((observer) => isObserverAllowed(observer));
    if (!allowed) {
      log('debug', `Skipping packet from observer(s) ${observers.join(',') || 'unknown'} (not in allowlist).`);
      return;
    }
  }

  const hex = extractPacketHex(topic, payload);
  if (!hex) {
    return;
  }

  let decoded;
  try {
    decoded = MeshCoreDecoder.decode(hex, keyStore ? { keyStore } : undefined);
  } catch (err) {
    log('debug', `Decode failed: ${err?.message || err}`);
    return;
  }

  if (decoded.payloadType !== PayloadType.GroupText) {
    return;
  }

  const payloadDecoded = decoded.payload?.decoded;
  if (!payloadDecoded || !payloadDecoded.decrypted || !payloadDecoded.decrypted.message) {
    log('debug', `Encrypted GroupText (no key): ${decoded.messageHash || 'no-hash'}`);
    return;
  }

  const channelHash = String(payloadDecoded.channelHash || '').toLowerCase();
  const { channelIds, channelInfo } = pickChannels(channelHash);
  if (channelIds.length === 0) {
    log('debug', `No Discord channel for hash ${channelHash || 'unknown'}`);
    return;
  }

  const relayKey = `${decoded.messageHash || payloadDecoded.decrypted.timestamp || 'no-hash'}:${channelHash}`;
  const now = Date.now();
  if (!shouldRelayMessage(relayKey, now)) {
    return;
  }

  const messageText = formatRelayMessage(channelInfo, payloadDecoded, decoded);
  if (!messageText) {
    return;
  }

  await Promise.all(channelIds.map(async (channelId) => {
    const channel = await getDiscordChannel(channelId);
    if (!channel) {
      return;
    }

    try {
      await channel.send({ content: messageText });
    } catch (err) {
      log('warn', `Failed to send Discord message to ${channelId}: ${err?.message || err}`);
    }
  }));
}

function buildMqttClient() {
  const useWebsockets = config.mqtt.transport === 'websockets';
  const protocol = useWebsockets
    ? (config.mqtt.tls ? 'wss' : 'ws')
    : (config.mqtt.tls ? 'mqtts' : 'mqtt');

  const url = `${protocol}://${config.mqtt.host}:${config.mqtt.port}`;
  const options = {
    username: config.mqtt.username || undefined,
    password: config.mqtt.password || undefined,
    clientId: config.mqtt.clientId || undefined
  };

  if (useWebsockets) {
    options.path = config.mqtt.wsPath || '/mqtt';
  }

  if (config.mqtt.tls) {
    if (config.mqtt.tlsInsecure) {
      options.rejectUnauthorized = false;
    }
    if (config.mqtt.caCertPath) {
      const resolved = path.isAbsolute(config.mqtt.caCertPath)
        ? config.mqtt.caCertPath
        : path.join(process.cwd(), config.mqtt.caCertPath);
      try {
        options.ca = fs.readFileSync(resolved);
      } catch (err) {
        log('warn', `Failed to read MQTT CA cert at ${resolved}: ${err?.message || err}`);
      }
    }
  }

  const client = mqtt.connect(url, options);

  client.on('connect', () => {
    log('info', `MQTT connected (${url}), subscribing to ${config.mqtt.topic}`);
    client.subscribe(config.mqtt.topic, { qos: config.mqtt.qos }, (err) => {
      if (err) {
        log('warn', `MQTT subscribe error: ${err?.message || err}`);
      }
    });
  });

  client.on('message', (topic, payload) => {
    handlePacket(topic, payload).catch((err) => {
      log('debug', `Handle packet error: ${err?.message || err}`);
    });
  });

  client.on('error', (err) => {
    log('warn', `MQTT error: ${err?.message || err}`);
  });

  client.on('reconnect', () => {
    log('info', 'MQTT reconnecting...');
  });

  return client;
}

let mqttClient = null;

discordClient.once('ready', () => {
  log('info', `Discord logged in as ${discordClient.user?.tag || 'unknown'}`);
  if (observerAllowlist.size > 0) {
    log('info', `Observer filter enabled: ${[...observerAllowlist].join(', ')}`);
  }
  mqttClient = buildMqttClient();
});

discordClient.on('error', (err) => {
  log('warn', `Discord error: ${err?.message || err}`);
});

process.on('SIGINT', () => {
  log('info', 'Shutting down...');
  if (mqttClient) {
    mqttClient.end(true);
  }
  discordClient.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('info', 'Shutting down...');
  if (mqttClient) {
    mqttClient.end(true);
  }
  discordClient.destroy();
  process.exit(0);
});

discordClient.login(config.discord.token).catch((err) => {
  log('error', `Discord login failed: ${err?.message || err}`);
  process.exit(1);
});
