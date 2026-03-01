import fs from 'fs';
import path from 'path';
import mqtt from 'mqtt';
import { Client, EmbedBuilder, GatewayIntentBits } from 'discord.js';
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

if (config.discord.routeMode === 'master' && !config.discord.masterChannelId && !config.discord.defaultChannelId) {
  log('warn', 'DISCORD_ROUTE_MODE=master but no DISCORD_MASTER_CHANNEL_ID or DISCORD_DEFAULT_CHANNEL_ID is configured.');
}

if (!config.discord.defaultChannelId && config.channelMap.size === 0 && config.discord.routeMode !== 'master') {
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
const relayShowPath = Boolean(config.relay.showPath);
const relayPathWaitMs = Math.max(0, config.relay.pathWaitMs || 0);
const relayPathMaxObservers = Math.max(1, config.relay.pathMaxObservers || 8);
const relayPathEditUpdates = relayShowPath && Boolean(config.relay.pathEditUpdates);
const relayPathEditWindowMs = Math.max(0, config.relay.pathEditWindowMs || 0);
const relayPathEditMinIntervalMs = Math.max(0, config.relay.pathEditMinIntervalMs || 0);
const relayEmbedColor = config.relay.embedColor || 0x1e2938;
const trackMessageState = relayShowPath || observerAllowlist.size > 0;
const pathCacheWindowMs = Math.max(dedupeWindowMs, relayPathWaitMs + 5000);
const sentRelayCacheWindowMs = Math.max(pathCacheWindowMs, relayPathEditWindowMs + 5000);
const messagePathCache = new Map();
const pendingRelayTimers = new Map();
const sentRelayCache = new Map();

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

function extractIdPrefix(value) {
  if (!value || typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return '';
  }
  return trimmed.slice(0, 2).toLowerCase();
}

function extractObserverPrefix(observer) {
  const normalized = normalizeObserverName(observer);
  if (!normalized) {
    return '';
  }
  const match = normalized.match(/(?:^|[^0-9])([0-9]{2})(?=[^0-9]|$)/);
  return match ? match[1] : '';
}

function formatObserverHop(observer) {
  const prefix = extractObserverPrefix(observer);
  if (prefix) {
    return prefix;
  }
  const normalized = normalizeObserverName(observer)
    .replace(/\s*-\s*observer\b/g, '')
    .replace(/\s+/g, '-');
  return normalized;
}

function extractTopicObserverPrefix(topic) {
  if (!topic || typeof topic !== 'string') {
    return '';
  }
  const parts = topic.split('/');
  for (const part of parts) {
    const prefix = extractIdPrefix(part);
    if (prefix) {
      return prefix;
    }
  }
  return '';
}

function extractObserverPrefixHints(payloadBuffer) {
  if (!payloadBuffer || payloadBuffer.length === 0) {
    return new Map();
  }

  const text = payloadBuffer.toString('utf8').trim();
  if (!text || !text.startsWith('{') || !text.endsWith('}')) {
    return new Map();
  }

  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return new Map();
  }

  const hints = new Map();
  const queue = [obj];
  let visited = 0;

  while (queue.length > 0 && visited < 120) {
    const current = queue.shift();
    visited += 1;
    if (!current || typeof current !== 'object') {
      continue;
    }

    const names = [];
    const ids = [];

    for (const [key, value] of Object.entries(current)) {
      if (typeof value === 'string') {
        if (['origin', 'observer', 'observer_name', 'observerName', 'name'].includes(key)) {
          const normalized = normalizeObserverName(value);
          if (normalized) {
            names.push(normalized);
          }
        }
        if (['origin_id', 'observer_id', 'observerId', 'id'].includes(key)) {
          const prefix = extractIdPrefix(value);
          if (prefix) {
            ids.push(prefix);
          }
        }
      }

      if (value && typeof value === 'object') {
        queue.push(value);
      }
    }

    if (names.length > 0 && ids.length > 0) {
      for (const name of names) {
        if (!hints.has(name)) {
          hints.set(name, ids[0]);
        }
      }
    }
  }

  return hints;
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

function normalizeRoutePath(path) {
  if (!Array.isArray(path)) {
    return [];
  }
  return path
    .map((hop) => String(hop || '').trim().toLowerCase())
    .filter((hop) => /^[0-9a-f]{2}$/.test(hop));
}

function updateMessagePath(relayKey, observers, now, prefixHints = new Map(), fallbackPrefix = '', routePath = []) {
  if (!trackMessageState || !relayKey) {
    return {
      path: [],
      allowedSeen: observerAllowlist.size === 0
    };
  }

  let state = messagePathCache.get(relayKey);
  if (!state) {
    state = {
      observers: new Map(),
      lastSeen: now,
      allowedSeen: observerAllowlist.size === 0,
      routePath: []
    };
    messagePathCache.set(relayKey, state);
  }

  state.lastSeen = now;
  const normalizedRoutePath = normalizeRoutePath(routePath);
  if (normalizedRoutePath.length > state.routePath.length) {
    state.routePath = normalizedRoutePath;
  }
  if (observerAllowlist.size > 0 && observers.some((observer) => isObserverAllowed(observer))) {
    state.allowedSeen = true;
  }

  for (const observer of observers) {
    const normalized = normalizeObserverName(observer);
    const hintedPrefix = prefixHints.get(normalized);
    const hop = hintedPrefix || formatObserverHop(observer) || fallbackPrefix;
    if (!normalized || state.observers.has(normalized)) {
      continue;
    }
    state.observers.set(normalized, hop);
  }

  return {
    path: state.routePath.length > 0 ? [...state.routePath] : [...state.observers.values()],
    allowedSeen: state.allowedSeen
  };
}

function getMessagePath(relayKey) {
  const state = messagePathCache.get(relayKey);
  if (!state) {
    return [];
  }
  if (Array.isArray(state.routePath) && state.routePath.length > 0) {
    return [...state.routePath];
  }
  return [...state.observers.values()];
}

function applyPathSuffix(messageText, observers) {
  if (!relayShowPath || !Array.isArray(observers) || observers.length === 0) {
    return messageText;
  }

  const shown = observers.slice(0, relayPathMaxObservers);
  const hiddenCount = observers.length - shown.length;
  const formatted = shown.map((hop) => {
    const value = /^[0-9a-f]{2}$/i.test(hop) ? hop.toUpperCase() : hop;
    return `\`${String(value).replace(/`/g, '\\`')}\``;
  });
  const suffix = `\n[${formatted.join(',')}${hiddenCount > 0 ? `,+${hiddenCount}` : ''}]`;

  if (messageText.length + suffix.length <= 1900) {
    return `${messageText}${suffix}`;
  }

  const trimmedLength = Math.max(0, 1900 - suffix.length - 3);
  return `${messageText.slice(0, trimmedLength)}...${suffix}`;
}

function buildRelayEmbed(messageText) {
  return new EmbedBuilder()
    .setDescription(messageText)
    .setColor(relayEmbedColor);
}

async function sendToDiscordChannels(channelIds, messageText) {
  const sentMessages = await Promise.all(channelIds.map(async (channelId) => {
    const channel = await getDiscordChannel(channelId);
    if (!channel) {
      return null;
    }

    try {
      const sentMessage = await channel.send({ embeds: [buildRelayEmbed(messageText)] });
      return { channelId, sentMessage };
    } catch (err) {
      log('warn', `Failed to send Discord message to ${channelId}: ${err?.message || err}`);
      return null;
    }
  }));

  return sentMessages.filter(Boolean);
}

function clearSentRelayRecord(relayKey) {
  const record = sentRelayCache.get(relayKey);
  if (!record) {
    return;
  }
  if (record.pendingEditTimer) {
    clearTimeout(record.pendingEditTimer);
  }
  sentRelayCache.delete(relayKey);
}

function rememberSentRelay(relayKey, baseMessageText, renderedMessageText, sentMessages, now) {
  if (!relayPathEditUpdates || !relayShowPath || !relayKey || !Array.isArray(sentMessages) || sentMessages.length === 0) {
    return;
  }

  clearSentRelayRecord(relayKey);
  sentRelayCache.set(relayKey, {
    baseMessageText,
    renderedMessageText,
    sentMessages,
    sentAt: now,
    lastEditAt: now,
    pendingEditTimer: null
  });
}

function canEditSentRelay(record, now) {
  if (!record) {
    return false;
  }
  if (relayPathEditWindowMs <= 0) {
    return true;
  }
  return now - record.sentAt <= relayPathEditWindowMs;
}

async function editSentRelay(relayKey) {
  const record = sentRelayCache.get(relayKey);
  if (!record) {
    return;
  }

  const now = Date.now();
  if (!canEditSentRelay(record, now)) {
    clearSentRelayRecord(relayKey);
    return;
  }

  const latestPath = getMessagePath(relayKey);
  const nextRenderedMessageText = applyPathSuffix(record.baseMessageText, latestPath);
  if (!nextRenderedMessageText || nextRenderedMessageText === record.renderedMessageText) {
    return;
  }

  const sinceLastEdit = now - record.lastEditAt;
  if (sinceLastEdit < relayPathEditMinIntervalMs) {
    const waitMs = relayPathEditMinIntervalMs - sinceLastEdit;
    if (!record.pendingEditTimer) {
      record.pendingEditTimer = setTimeout(() => {
        const latestRecord = sentRelayCache.get(relayKey);
        if (latestRecord) {
          latestRecord.pendingEditTimer = null;
        }
        editSentRelay(relayKey).catch((err) => {
          log('warn', `Failed to update relay message ${relayKey}: ${err?.message || err}`);
        });
      }, waitMs);
    }
    return;
  }

  await Promise.all(record.sentMessages.map(async (entry) => {
    if (!entry?.sentMessage?.editable) {
      return;
    }
    try {
      await entry.sentMessage.edit({ embeds: [buildRelayEmbed(nextRenderedMessageText)] });
    } catch (err) {
      log('warn', `Failed to edit Discord message in ${entry.channelId}: ${err?.message || err}`);
    }
  }));

  record.renderedMessageText = nextRenderedMessageText;
  record.lastEditAt = Date.now();
}

function requestPathEdit(relayKey) {
  if (!relayPathEditUpdates || !relayShowPath || !relayKey) {
    return;
  }
  const record = sentRelayCache.get(relayKey);
  if (!record) {
    return;
  }

  const now = Date.now();
  if (!canEditSentRelay(record, now)) {
    clearSentRelayRecord(relayKey);
    return;
  }

  if (record.pendingEditTimer) {
    return;
  }

  const waitMs = Math.max(0, relayPathEditMinIntervalMs - (now - record.lastEditAt));
  if (waitMs === 0) {
    editSentRelay(relayKey).catch((err) => {
      log('warn', `Failed to update relay message ${relayKey}: ${err?.message || err}`);
    });
    return;
  }

  record.pendingEditTimer = setTimeout(() => {
    const latestRecord = sentRelayCache.get(relayKey);
    if (latestRecord) {
      latestRecord.pendingEditTimer = null;
    }
    editSentRelay(relayKey).catch((err) => {
      log('warn', `Failed to update relay message ${relayKey}: ${err?.message || err}`);
    });
  }, waitMs);
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
  for (const [key, state] of messagePathCache.entries()) {
    if (!state || now - state.lastSeen > pathCacheWindowMs) {
      messagePathCache.delete(key);
    }
  }
  for (const [key, record] of sentRelayCache.entries()) {
    if (!record || now - record.sentAt > sentRelayCacheWindowMs) {
      clearSentRelayRecord(key);
    }
  }
}, Math.max(10000, dedupeWindowMs));

function formatRelayMessage(channelInfo, payload, packet) {
  const escapeInline = (value) => String(value || '').replace(/([*_`~\\])/g, '\\$1');
  const channelLabel = String(channelInfo?.name || '').trim();
  const senderRaw = String(payload.decrypted?.sender || '').trim();
  const body = (payload.decrypted?.message || '').trim();
  if (!body) {
    return '';
  }
  let text = body;

  if (config.discord.routeMode === 'master') {
    const channel = escapeInline(channelLabel || 'unknown');
    const sender = escapeInline(senderRaw || 'unknown');
    text = `${channel}: ${sender}: ${body}`;
  } else if (senderRaw) {
    const sender = escapeInline(senderRaw);
    text = `**${sender}**: ${body}`;
  }
  if (text.length > 1900) {
    text = `${text.slice(0, 1890)}...`;
  }
  return text;
}

function pickChannels(channelHash) {
  if (config.discord.routeMode === 'master') {
    const masterChannelId = config.discord.masterChannelId || config.discord.defaultChannelId;
    return {
      channelIds: masterChannelId ? [masterChannelId] : [],
      channelInfo: null
    };
  }

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
  const observers = [
    ...new Set([
      ...extractObserversFromTopic(topic),
      ...extractObserversFromPayload(payload)
    ])
  ];
  const prefixHints = extractObserverPrefixHints(payload);
  const topicPrefix = extractTopicObserverPrefix(topic);

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
  const pathState = updateMessagePath(relayKey, observers, now, prefixHints, topicPrefix, decoded.path);
  if (observerAllowlist.size > 0 && !pathState.allowedSeen) {
    log('debug', `Holding message ${relayKey} until a whitelisted observer sees it. Seen: ${observers.join(',') || 'unknown'}`);
    return;
  }

  if (!shouldRelayMessage(relayKey, now)) {
    requestPathEdit(relayKey);
    return;
  }

  const messageText = formatRelayMessage(channelInfo, payloadDecoded, decoded);
  if (!messageText) {
    return;
  }

  if (relayShowPath && relayPathWaitMs > 0) {
    if (pendingRelayTimers.has(relayKey)) {
      return;
    }
    const timer = setTimeout(() => {
      pendingRelayTimers.delete(relayKey);
      const latestPath = getMessagePath(relayKey);
      const messageWithPath = applyPathSuffix(messageText, latestPath);
      sendToDiscordChannels(channelIds, messageWithPath)
        .then((sentMessages) => {
          rememberSentRelay(relayKey, messageText, messageWithPath, sentMessages, Date.now());
        })
        .catch((err) => {
          log('warn', `Failed to send delayed Discord message: ${err?.message || err}`);
        });
    }, relayPathWaitMs);
    pendingRelayTimers.set(relayKey, timer);
    return;
  }

  const messageWithPath = applyPathSuffix(messageText, pathState.path);
  const sentMessages = await sendToDiscordChannels(channelIds, messageWithPath);
  rememberSentRelay(relayKey, messageText, messageWithPath, sentMessages, now);
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
  if (config.discord.routeMode === 'master') {
    log('info', `Routing mode: master (${config.discord.masterChannelId || config.discord.defaultChannelId || 'unset'})`);
  } else {
    log('info', 'Routing mode: per_channel');
  }
  if (observerAllowlist.size > 0) {
    log('info', `Observer filter enabled: ${[...observerAllowlist].join(', ')}`);
  }
  if (relayShowPath) {
    log('info', `Message path display enabled (wait ${relayPathWaitMs}ms, max ${relayPathMaxObservers} observers).`);
    if (relayPathEditUpdates) {
      log('info', `Path update edits enabled (window ${relayPathEditWindowMs}ms, min interval ${relayPathEditMinIntervalMs}ms).`);
    }
  }
  mqttClient = buildMqttClient();
});

discordClient.on('error', (err) => {
  log('warn', `Discord error: ${err?.message || err}`);
});

process.on('SIGINT', () => {
  log('info', 'Shutting down...');
  for (const timer of pendingRelayTimers.values()) {
    clearTimeout(timer);
  }
  pendingRelayTimers.clear();
  for (const key of sentRelayCache.keys()) {
    clearSentRelayRecord(key);
  }
  if (mqttClient) {
    mqttClient.end(true);
  }
  discordClient.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('info', 'Shutting down...');
  for (const timer of pendingRelayTimers.values()) {
    clearTimeout(timer);
  }
  pendingRelayTimers.clear();
  for (const key of sentRelayCache.keys()) {
    clearSentRelayRecord(key);
  }
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
