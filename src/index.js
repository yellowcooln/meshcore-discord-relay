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

const relayDeliveryMode = config.discord.deliveryMode || 'bot';
const isWebhookDelivery = relayDeliveryMode === 'webhook';
const isBotDelivery = !isWebhookDelivery;

if (isBotDelivery && !config.discord.token) {
  log('error', 'DISCORD_TOKEN is required.');
  process.exit(1);
}

if (config.discord.routeMode === 'master'
  && isBotDelivery
  && !config.discord.masterChannelId
  && !config.discord.defaultChannelId) {
  log('warn', 'DISCORD_ROUTE_MODE=master but no DISCORD_MASTER_CHANNEL_ID or DISCORD_DEFAULT_CHANNEL_ID is configured.');
}

if (config.discord.routeMode === 'master'
  && isWebhookDelivery
  && (!config.webhooks || (config.webhooks.defaultWebhookUrls || []).length === 0)) {
  log('warn', 'DISCORD_ROUTE_MODE=master with webhook delivery but no default webhook URL is configured.');
}

if (!config.discord.defaultChannelId && config.channelMap.size === 0 && config.discord.routeMode !== 'master' && isBotDelivery) {
  log('warn', 'No default Discord channel and no channel mappings configured.');
}

if (config.discord.routeMode !== 'master'
  && isWebhookDelivery
  && (!config.webhooks || ((config.webhooks.channelMap || new Map()).size === 0 && (config.webhooks.defaultWebhookUrls || []).length === 0))) {
  log('warn', 'Webhook delivery enabled but no webhook mappings/default webhook configured.');
}

const keyStore = config.channelSecrets.length > 0
  ? MeshCoreDecoder.createKeyStore({ channelSecrets: config.channelSecrets })
  : null;

if (!keyStore) {
  log('warn', 'No channel secrets configured. Add secrets in channels.json and/or webhooks.json to decrypt GroupText.');
}

const discordClient = isBotDelivery
  ? new Client({ intents: [GatewayIntentBits.Guilds] })
  : null;

const channelCache = new Map();

async function getDiscordChannel(channelId) {
  if (!discordClient) {
    return null;
  }
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
const relayBotMessageMode = String(config.relay.botMessageMode || 'simple').toLowerCase() === 'detailed'
  ? 'detailed'
  : 'simple';
const useDetailedBotEmbeds = isBotDelivery && relayBotMessageMode === 'detailed';
const relayPathWaitMs = Math.max(0, config.relay.pathWaitMs || 0);
const relayPathMaxObservers = Math.max(1, config.relay.pathMaxObservers || 8);
const relayPathEditUpdates = relayShowPath && isBotDelivery && Boolean(config.relay.pathEditUpdates);
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

function formatPathSuffix(observers) {
  if (!relayShowPath || !Array.isArray(observers) || observers.length === 0) {
    return '';
  }
  const shown = observers.slice(0, relayPathMaxObservers);
  const hiddenCount = observers.length - shown.length;
  const formatted = shown.map((hop) => {
    const value = /^[0-9a-f]{2}$/i.test(hop) ? hop.toUpperCase() : hop;
    return `\`${String(value).replace(/`/g, '\\`')}\``;
  });
  return `[${formatted.join(',')}${hiddenCount > 0 ? `,+${hiddenCount}` : ''}]`;
}

function applyPathSuffix(messageText, observers) {
  const line = formatPathSuffix(observers);
  if (!line) {
    return messageText;
  }
  const suffix = `\n${line}`;

  if (messageText.length + suffix.length <= 1900) {
    return `${messageText}${suffix}`;
  }

  const trimmedLength = Math.max(0, 1900 - suffix.length - 3);
  return `${messageText.slice(0, trimmedLength)}...${suffix}`;
}

function parseJsonPayload(payloadBuffer) {
  if (!payloadBuffer || payloadBuffer.length === 0) {
    return null;
  }
  const text = payloadBuffer.toString('utf8').trim();
  if (!text || !text.startsWith('{') || !text.endsWith('}')) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function findFirstDeepValue(root, keyCandidates, acceptValue, maxNodes = 180) {
  if (!root || typeof root !== 'object') {
    return null;
  }

  const keySet = new Set(keyCandidates.map((item) => String(item).toLowerCase()));
  const queue = [root];
  let visited = 0;

  while (queue.length > 0 && visited < maxNodes) {
    const current = queue.shift();
    visited += 1;
    if (!current || typeof current !== 'object') {
      continue;
    }

    for (const [key, value] of Object.entries(current)) {
      const lowerKey = String(key || '').toLowerCase();
      if (keySet.has(lowerKey) && acceptValue(value)) {
        return value;
      }
      if (value && typeof value === 'object') {
        queue.push(value);
      }
    }
  }

  return null;
}

function toFiniteNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const cleaned = value.trim().replace(/[^\d+.\-]/g, '');
    if (!cleaned) {
      return null;
    }
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function extractReceiverNode(topic, decoded, payloadBuffer, observers) {
  const direct = [
    decoded?.receiverName,
    decoded?.receiver,
    decoded?.receiverId,
    decoded?.rxBy
  ].find((value) => typeof value === 'string' && value.trim());
  if (direct) {
    return String(direct).trim();
  }

  const json = parseJsonPayload(payloadBuffer);
  if (json) {
    const found = findFirstDeepValue(
      json,
      ['receiver', 'receiver_name', 'receiver_id', 'receiverid', 'rx_by', 'gateway', 'observer', 'origin'],
      (value) => typeof value === 'string' && value.trim()
    );
    if (found) {
      return String(found).trim();
    }
  }

  if (Array.isArray(observers) && observers.length > 0) {
    return observers[0];
  }

  if (topic && typeof topic === 'string') {
    const parts = topic.split('/');
    for (const part of parts) {
      const trimmed = String(part || '').trim();
      if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
        return trimmed.slice(0, 8).toUpperCase();
      }
    }
  }

  return '';
}

function extractLinkMetrics(decoded, payloadBuffer) {
  const fromDecodedRssi = toFiniteNumber(decoded?.rssi);
  const fromDecodedSnr = toFiniteNumber(decoded?.snr);
  if (fromDecodedRssi !== null || fromDecodedSnr !== null) {
    return {
      rssi: fromDecodedRssi,
      snr: fromDecodedSnr
    };
  }

  const json = parseJsonPayload(payloadBuffer);
  if (!json) {
    return { rssi: null, snr: null };
  }

  const rawRssi = findFirstDeepValue(
    json,
    ['rssi', 'rx_rssi', 'last_rssi', 'signal', 'dbm'],
    (value) => toFiniteNumber(value) !== null
  );
  const rawSnr = findFirstDeepValue(
    json,
    ['snr', 'rx_snr', 'last_snr', 'signal_to_noise'],
    (value) => toFiniteNumber(value) !== null
  );

  return {
    rssi: toFiniteNumber(rawRssi),
    snr: toFiniteNumber(rawSnr)
  };
}

function buildRelayEmbed(messageText, embedDetails = null) {
  if (!useDetailedBotEmbeds || !embedDetails) {
    return new EmbedBuilder()
      .setDescription(messageText)
      .setColor(relayEmbedColor);
  }

  const trimField = (value, max = 1024) => {
    const text = String(value || '').trim();
    if (!text) {
      return 'unknown';
    }
    if (text.length <= max) {
      return text;
    }
    return `${text.slice(0, Math.max(0, max - 3))}...`;
  };

  const channelLabel = String(embedDetails.channelLabel || '').trim();
  const senderLabel = String(embedDetails.senderRaw || embedDetails.senderName || 'MeshCore').trim() || 'MeshCore';
  const bodyText = String(embedDetails.body || messageText || '').trim() || messageText;
  const path = Array.isArray(embedDetails.path) ? embedDetails.path : [];
  const pathLine = formatPathSuffix(path);
  const hopsValue = path.length > 0 ? String(path.length) : 'direct';
  const receiverNode = String(embedDetails.receiverNode || '').trim() || 'unknown';
  const rssiText = Number.isFinite(embedDetails.rssi) ? `${Math.round(embedDetails.rssi)} dBm` : 'unknown';
  const snrText = Number.isFinite(embedDetails.snr) ? `${Number(embedDetails.snr).toFixed(1)} dB` : 'unknown';

  const embed = new EmbedBuilder()
    .setColor(relayEmbedColor)
    .setTitle(trimField(senderLabel, 256))
    .setDescription(trimField(bodyText, 4096))
    .setTimestamp(new Date());

  const fields = [];
  if (config.discord.routeMode === 'master' && channelLabel) {
    fields.push({ name: 'Channel', value: trimField(channelLabel), inline: true });
  }
  fields.push(
    { name: 'Receiver Node', value: receiverNode, inline: true },
    { name: 'RSSI', value: rssiText, inline: true },
    { name: 'SNR', value: snrText, inline: true },
    { name: 'Hops', value: hopsValue, inline: true },
    { name: 'Path', value: trimField(pathLine || '`direct`'), inline: false }
  );
  embed.addFields(fields);

  return embed;
}

function normalizeWebhookUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '';
    }
    return parsed.toString();
  } catch {
    return '';
  }
}

function buildWebhookSendUrl(webhookUrl) {
  const parsed = new URL(webhookUrl);
  parsed.searchParams.set('wait', 'true');
  return parsed.toString();
}

function buildWebhookEditUrl(webhookUrl, messageId) {
  const parsed = new URL(webhookUrl);
  parsed.search = '';
  parsed.hash = '';
  parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}/messages/${encodeURIComponent(String(messageId || ''))}`;
  return parsed.toString();
}

function sanitizeWebhookUsername(value) {
  const fallback = 'MeshCore';
  const raw = String(value || '').replace(/[\r\n\t]+/g, ' ').trim();
  if (!raw) {
    return fallback;
  }
  return raw.slice(0, 80);
}

function buildWebhookAvatarUrl(username) {
  const seed = String(username || 'MeshCore').trim() || 'MeshCore';
  return `https://robohash.org/${encodeURIComponent(seed)}.png?set=set1&size=128x128`;
}

async function sendToDiscordChannels(channelIds, messageText, embedDetails = null) {
  if (!discordClient) {
    return [];
  }
  const sentMessages = await Promise.all(channelIds.map(async (channelId) => {
    const channel = await getDiscordChannel(channelId);
    if (!channel) {
      return null;
    }

    try {
      const payload = {
        embeds: [buildRelayEmbed(messageText, embedDetails)]
      };

      const sentMessage = await channel.send(payload);
      return { kind: 'bot', channelId, sentMessage };
    } catch (err) {
      log('warn', `Failed to send Discord message to ${channelId}: ${err?.message || err}`);
      return null;
    }
  }));

  return sentMessages.filter(Boolean);
}

async function sendToWebhookUrls(webhookUrls, messageText, senderName) {
  const username = sanitizeWebhookUsername(senderName);
  const avatarUrl = buildWebhookAvatarUrl(username);
  const sentMessages = await Promise.all(webhookUrls.map(async (urlValue) => {
    const webhookUrl = normalizeWebhookUrl(urlValue);
    if (!webhookUrl) {
      log('warn', 'Skipping invalid webhook URL in webhook mapping.');
      return null;
    }

    let response;
    try {
      response = await fetch(buildWebhookSendUrl(webhookUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          avatar_url: avatarUrl,
          embeds: [buildRelayEmbed(messageText).toJSON()],
          allowed_mentions: { parse: [] }
        })
      });
    } catch (err) {
      log('warn', `Failed to send webhook message: ${err?.message || err}`);
      return null;
    }

    if (!response.ok) {
      let detail = '';
      try {
        detail = await response.text();
      } catch {
        detail = '';
      }
      log('warn', `Webhook send failed (${response.status}): ${detail.slice(0, 180) || 'no response body'}`);
      return null;
    }

    let messageId = '';
    try {
      const body = await response.json();
      messageId = String(body?.id || '').trim();
    } catch {
      messageId = '';
    }

    return { kind: 'webhook', webhookUrl, messageId, username };
  }));

  return sentMessages.filter(Boolean);
}

async function editWebhookMessage(entry, messageText) {
  if (!entry?.webhookUrl || !entry?.messageId) {
    return;
  }

  let response;
  try {
    response = await fetch(buildWebhookEditUrl(entry.webhookUrl, entry.messageId), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [buildRelayEmbed(messageText).toJSON()],
        allowed_mentions: { parse: [] }
      })
    });
  } catch (err) {
    log('warn', `Failed to edit webhook message: ${err?.message || err}`);
    return;
  }

  if (!response.ok) {
    let detail = '';
    try {
      detail = await response.text();
    } catch {
      detail = '';
    }
    log('warn', `Webhook edit failed (${response.status}): ${detail.slice(0, 180) || 'no response body'}`);
  }
}

async function sendRelayTargets(targetIds, messageText, senderName, embedDetails = null) {
  if (isWebhookDelivery) {
    return sendToWebhookUrls(targetIds, messageText, senderName);
  }
  return sendToDiscordChannels(targetIds, messageText, embedDetails);
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

function rememberSentRelay(relayKey, baseMessageText, renderedMessageText, sentMessages, now, embedDetails = null) {
  if (!relayPathEditUpdates || !relayShowPath || !relayKey || !Array.isArray(sentMessages) || sentMessages.length === 0) {
    return;
  }

  clearSentRelayRecord(relayKey);
  sentRelayCache.set(relayKey, {
    baseMessageText,
    renderedMessageText,
    embedDetails,
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
  const isDetailedRecord = Boolean(record.embedDetails && useDetailedBotEmbeds);
  const nextRenderedMessageText = isDetailedRecord
    ? record.baseMessageText
    : applyPathSuffix(record.baseMessageText, latestPath);
  if (!isDetailedRecord && (!nextRenderedMessageText || nextRenderedMessageText === record.renderedMessageText)) {
    return;
  }
  if (isDetailedRecord) {
    const previousPathLine = formatPathSuffix(record.embedDetails.path || []);
    const nextPathLine = formatPathSuffix(latestPath);
    if (previousPathLine === nextPathLine) {
      return;
    }
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
    if (!entry || typeof entry !== 'object') {
      return;
    }

    if (entry.kind === 'webhook') {
      await editWebhookMessage(entry, nextRenderedMessageText);
      return;
    }

    if (!entry?.sentMessage?.editable) {
      return;
    }
    try {
      const nextEmbedDetails = isDetailedRecord
        ? { ...record.embedDetails, path: latestPath }
        : null;
      await entry.sentMessage.edit({ embeds: [buildRelayEmbed(nextRenderedMessageText, nextEmbedDetails)] });
    } catch (err) {
      log('warn', `Failed to edit Discord message in ${entry.channelId}: ${err?.message || err}`);
    }
  }));

  record.renderedMessageText = nextRenderedMessageText;
  if (isDetailedRecord) {
    record.embedDetails = { ...record.embedDetails, path: latestPath };
  }
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
    return {
      messageText: '',
      senderName: '',
      senderRaw: '',
      channelLabel: '',
      body: ''
    };
  }
  let text = body;
  const senderName = senderRaw || 'MeshCore';

  if (isWebhookDelivery) {
    if (config.discord.routeMode === 'master') {
      const channel = escapeInline(channelLabel || 'unknown');
      text = `${channel}: ${body}`;
    } else {
      text = body;
    }
    if (text.length > 1900) {
      text = `${text.slice(0, 1890)}...`;
    }
    return {
      messageText: text,
      senderName,
      senderRaw,
      channelLabel,
      body
    };
  }

  if (useDetailedBotEmbeds) {
    if (text.length > 1900) {
      text = `${text.slice(0, 1890)}...`;
    }
    return {
      messageText: text,
      senderName,
      senderRaw,
      channelLabel,
      body
    };
  }

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
  return {
    messageText: text,
    senderName,
    senderRaw,
    channelLabel,
    body
  };
}

function pickBotTargets(channelHash) {
  if (config.discord.routeMode === 'master') {
    const masterChannelId = config.discord.masterChannelId || config.discord.defaultChannelId;
    return {
      targetIds: masterChannelId ? [masterChannelId] : [],
      channelInfo: null
    };
  }

  const channelInfo = config.channelMap.get(channelHash) || null;
  if (channelInfo?.discordChannelIds?.length) {
    return {
      targetIds: channelInfo.discordChannelIds,
      channelInfo
    };
  }
  return {
    targetIds: config.discord.defaultChannelId ? [config.discord.defaultChannelId] : [],
    channelInfo
  };
}

function pickWebhookTargets(channelHash) {
  if (config.discord.routeMode === 'master') {
    return {
      targetIds: config.webhooks.defaultWebhookUrls || [],
      channelInfo: null
    };
  }

  const channelInfo = config.channelMap.get(channelHash) || null;
  const mapped = config.webhooks.channelMap.get(channelHash);
  if (mapped?.webhookUrls?.length) {
    return {
      targetIds: mapped.webhookUrls,
      channelInfo
    };
  }
  return {
    targetIds: config.webhooks.defaultWebhookUrls || [],
    channelInfo
  };
}

function pickRelayTargets(channelHash) {
  if (isWebhookDelivery) {
    return pickWebhookTargets(channelHash);
  }
  return pickBotTargets(channelHash);
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
  const { targetIds, channelInfo } = pickRelayTargets(channelHash);
  const effectiveChannelInfo = channelInfo || config.channelMap.get(channelHash) || null;
  if (targetIds.length === 0) {
    if (isWebhookDelivery) {
      log('debug', `No webhook mapping for hash ${channelHash || 'unknown'}`);
    } else {
      log('debug', `No Discord channel for hash ${channelHash || 'unknown'}`);
    }
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

  const relayMessage = formatRelayMessage(effectiveChannelInfo, payloadDecoded, decoded);
  const messageText = relayMessage.messageText;
  if (!messageText) {
    return;
  }
  const linkMetrics = extractLinkMetrics(decoded, payload);
  const receiverNode = extractReceiverNode(topic, decoded, payload, observers);

  if (relayShowPath && relayPathWaitMs > 0) {
    if (pendingRelayTimers.has(relayKey)) {
      return;
    }
    const timer = setTimeout(() => {
      pendingRelayTimers.delete(relayKey);
      const latestPath = getMessagePath(relayKey);
      const messageWithPath = useDetailedBotEmbeds ? messageText : applyPathSuffix(messageText, latestPath);
      const embedDetails = useDetailedBotEmbeds
        ? {
          channelLabel: relayMessage.channelLabel,
          senderName: relayMessage.senderName,
          senderRaw: relayMessage.senderRaw,
          body: relayMessage.body,
          receiverNode,
          rssi: linkMetrics.rssi,
          snr: linkMetrics.snr,
          path: latestPath
        }
        : null;
      sendRelayTargets(targetIds, messageWithPath, relayMessage.senderName, embedDetails)
        .then((sentMessages) => {
          rememberSentRelay(relayKey, messageText, messageWithPath, sentMessages, Date.now(), embedDetails);
        })
        .catch((err) => {
          log('warn', `Failed to send delayed relay message: ${err?.message || err}`);
        });
    }, relayPathWaitMs);
    pendingRelayTimers.set(relayKey, timer);
    return;
  }

  const messageWithPath = useDetailedBotEmbeds ? messageText : applyPathSuffix(messageText, pathState.path);
  const embedDetails = useDetailedBotEmbeds
    ? {
      channelLabel: relayMessage.channelLabel,
      senderName: relayMessage.senderName,
      senderRaw: relayMessage.senderRaw,
      body: relayMessage.body,
      receiverNode,
      rssi: linkMetrics.rssi,
      snr: linkMetrics.snr,
      path: pathState.path
    }
    : null;
  const sentMessages = await sendRelayTargets(targetIds, messageWithPath, relayMessage.senderName, embedDetails);
  rememberSentRelay(relayKey, messageText, messageWithPath, sentMessages, now, embedDetails);
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

function logRuntimeSettings() {
  if (isWebhookDelivery) {
    log('info', 'Discord delivery mode: webhook');
  } else {
    log('info', `Discord logged in as ${discordClient?.user?.tag || 'unknown'}`);
    log('info', 'Discord delivery mode: bot');
  }

  if (config.discord.routeMode === 'master') {
    if (isWebhookDelivery) {
      const fallback = (config.webhooks.defaultWebhookUrls || []).length > 0 ? 'configured' : 'unset';
      log('info', `Routing mode: master (default webhook ${fallback})`);
    } else {
      log('info', `Routing mode: master (${config.discord.masterChannelId || config.discord.defaultChannelId || 'unset'})`);
    }
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
    } else if (isWebhookDelivery) {
      log('info', 'Path update edits disabled in webhook mode; hop collection uses RELAY_PATH_WAIT_MS before send.');
    }
  }
  if (isBotDelivery) {
    log('info', `Bot message mode: ${relayBotMessageMode}`);
  }
}

function startRelayRuntime() {
  logRuntimeSettings();
  mqttClient = buildMqttClient();
}

if (isBotDelivery && discordClient) {
  discordClient.once('ready', () => {
    startRelayRuntime();
  });

  discordClient.on('error', (err) => {
    log('warn', `Discord error: ${err?.message || err}`);
  });
} else {
  startRelayRuntime();
}

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
  if (discordClient) {
    discordClient.destroy();
  }
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
  if (discordClient) {
    discordClient.destroy();
  }
  process.exit(0);
});

if (isBotDelivery && discordClient) {
  discordClient.login(config.discord.token).catch((err) => {
    log('error', `Discord login failed: ${err?.message || err}`);
    process.exit(1);
  });
}
