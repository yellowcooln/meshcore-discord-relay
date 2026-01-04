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
  const channelLabel = channelInfo?.name
    ? `#${channelInfo.name}`
    : channelInfo?.channelHash
      ? `hash ${channelInfo.channelHash}`
      : 'unknown';

  const sender = payload.decrypted?.sender ? `${payload.decrypted.sender}: ` : '';
  const body = (payload.decrypted?.message || '').trim();
  if (!body) {
    return '';
  }
  const prefix = `[MeshCore ${channelLabel}]`;

  let text = `${prefix} ${sender}${body}`.trim();
  if (text.length > 1900) {
    text = `${text.slice(0, 1890)}...`;
  }
  return text;
}

function pickChannel(channelHash) {
  const channelInfo = config.channelMap.get(channelHash) || null;
  const channelId = channelInfo?.discordChannelId || config.discord.defaultChannelId;
  return { channelId, channelInfo };
}

async function handlePacket(topic, payload) {
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
  const { channelId, channelInfo } = pickChannel(channelHash);
  if (!channelId) {
    log('debug', `No Discord channel for hash ${channelHash || 'unknown'}`);
    return;
  }

  const relayKey = `${decoded.messageHash || payloadDecoded.decrypted.timestamp || 'no-hash'}:${channelHash}`;
  const now = Date.now();
  if (!shouldRelayMessage(relayKey, now)) {
    return;
  }

  const channel = await getDiscordChannel(channelId);
  if (!channel) {
    return;
  }

  const messageText = formatRelayMessage(channelInfo, payloadDecoded, decoded);
  if (!messageText) {
    return;
  }

  try {
    await channel.send({ content: messageText });
  } catch (err) {
    log('warn', `Failed to send Discord message: ${err?.message || err}`);
  }
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
