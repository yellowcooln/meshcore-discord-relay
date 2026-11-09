import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { EmbedBuilder } from 'discord.js';
import { MeshCoreDecoder, PayloadType, RouteType } from '../src/meshcore-decoder.js';
import * as paths from '../src/path-display.js';
import * as scopes from '../src/scope-display.js';
import { extractPacketHex } from '../src/packet-extract.js';
import { isTopicAllowed } from '../src/topic-match.js';
import { calcTransportCodeForRegion } from '@michaelhart/meshcore-decoder/dist/crypto/region-transport.js';

const raw = 'ca78b9ab0775d477c1f6490a398bf4edc75240';
const key = 'eb50a1bcb3e4e5d7bf69a57c9dada211';
function wire(route = RouteType.TransportFlood, code = calcTransportCodeForRegion('#Test', PayloadType.GroupText, Buffer.from(raw, 'hex')), home = 42, hops = '') {
  const header = Buffer.alloc(route === 0 || route === 3 ? 6 : 2);
  header[0] = 20 | route;
  if (header.length === 6) {
    header.writeUInt16LE(code, 1);
    header.writeUInt16LE(home, 3);
  }
  header[header.length - 1] = hops.length / 2;
  return header.toString('hex') + hops + raw;
}

// Execute the real index pipeline, replacing only startup, clocks and network I/O.
// Anchors fail closed on source drift; decoding/formatting/caches are production code.
function harness({ mode = 'simple', delivery = 'bot', showScope = true, wait = 0, showPath = false, names = ['#Test'] } = {}) {
  const sends = [], edits = [], timers = new Map();
  let timerId = 0;
  class Client {
    channels = { fetch: async () => ({ isTextBased: () => true, send: async (payload) => {
      sends.push(payload.embeds[0].toJSON());
      return { editable: true, edit: async (next) => { edits.push(next.embeds[0].toJSON()); } };
    } }) };
  }
  const config = {
    discord: { token: 'offline-test', deliveryMode: delivery, routeMode: 'per_channel', defaultChannelId: 'offline' },
    relay: { dedupeSeconds: 45, showScope, scopeNames: names, showPath, pathWaitMs: wait, pathEditUpdates: true,
      pathEditMinIntervalMs: 0, botMessageMode: mode },
    channelSecrets: [key], channelMap: new Map(), webhooks: { defaultWebhookUrls: ['https://example.invalid/webhook'], channelMap: new Map() }
  };
  const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.equal(source.split('let mqttClient = null;').length, 2, 'unique runtime startup boundary');
  const body = source.split('let mqttClient = null;')[0].replace(/^import\s[\s\S]*?;\n/gm, '');
  assert.doesNotMatch(body, /^import\s/m);
  const context = vm.createContext({
    ...paths, ...scopes, MeshCoreDecoder, PayloadType, extractPacketHex, isTopicAllowed,
    fs, path, Client, EmbedBuilder, GatewayIntentBits: { Guilds: 1 }, loadConfig: () => config,
    dotenv: { config() {} }, console, Buffer, URL, Date,
    process: { exit: () => { throw new Error('unexpected process exit'); } },
    setInterval: () => 0, setTimeout: (callback) => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: (id) => timers.delete(id),
    fetch: async (url, options) => {
      assert.equal(new URL(url).hostname, 'example.invalid');
      sends.push(JSON.parse(options.body).embeds[0]);
      return { ok: true, json: async () => ({ id: 'offline-message' }) };
    }
  });
  vm.runInContext(body + '\nglobalThis.handle = handlePacket;', context, { filename: 'index-under-test.js' });
  return { sends, edits, handle: (hex) => context.handle('meshcore/test', Buffer.from(hex, 'hex')),
    flush: async () => {
      const pending = [...timers.values()]; timers.clear();
      for (const callback of pending) callback();
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
}

test('dedupe separates unscoped and different scopes but ignores home code and transport route', async () => {
  for (const showScope of [false, true]) {
    const h = harness({ showScope });
    await h.handle(wire(RouteType.Flood));
    await h.handle(wire(RouteType.TransportFlood));
    await h.handle(wire(RouteType.TransportDirect, undefined, 999));
    await h.handle(wire(RouteType.TransportFlood, 0));
    await h.handle(wire(RouteType.TransportDirect, 0, 1000));
    assert.equal(h.sends.length, 3, 'global, known scope and unknown zero scope are distinct');
    assert.equal(h.sends[0].description, '**Roy B V4**: P');
    if (showScope) {
      assert.equal(h.sends[1].description, '**Roy B V4**: P\n\n`#Test`');
      assert.equal(h.sends[2].description, '**Roy B V4**: P\n\n`0x0000`');
    } else {
      assert.ok(h.sends.every((embed) => embed.description === '**Roy B V4**: P'));
    }
  }
});

test('detailed scope metadata survives delayed sends and real path edits', async () => {
  for (const wait of [0, 1200]) {
    const h = harness({ mode: 'detailed', wait, showPath: true });
    await h.handle(wire(RouteType.TransportDirect));
    if (wait) {
      assert.equal(h.sends.length, 0);
      await h.flush();
    }
    assert.equal(h.sends.length, 1);
    const scopeField = h.sends[0].fields.find((field) => field.name === 'Scope');
    assert.equal(scopeField?.value, '#Test');
    assert.equal(h.sends[0].description, 'P');
    await h.handle(wire(RouteType.TransportDirect, undefined, 999, 'aabb'));
    await h.flush();
    assert.equal(h.edits.length, 1);
    assert.equal(h.edits[0].fields.find((field) => field.name === 'Scope')?.value, '#Test');
    assert.match(h.edits[0].fields.find((field) => field.name === 'Path')?.value, /AA.*BB/);
  }
});

test('simple bot and webhook retain scope through delayed collection and bot edits', async () => {
  for (const delivery of ['bot', 'webhook']) {
    const h = harness({ delivery, wait: 1200, showPath: true });
    await h.handle(wire());
    await h.handle(wire(RouteType.TransportDirect, undefined, 99, 'aa'));
    assert.equal(h.sends.length, 0);
    await h.flush();
    assert.equal(h.sends.length, 1);
    assert.equal(h.sends[0].description,
      `${delivery === 'bot' ? '**Roy B V4**: ' : ''}P\n\n\`#Test\` · [\`AA\`]`);
    await h.handle(wire(RouteType.TransportFlood, undefined, 44, 'aabb'));
    await h.flush();
    if (delivery === 'bot') {
      assert.equal(h.edits.length, 1);
      assert.equal(h.edits[0].description, '**Roy B V4**: P\n\n`#Test` · [`AA`,`BB`]');
    } else {
      assert.equal(h.edits.length, 0);
      assert.equal(h.sends.length, 1);
    }
  }
});

test('immediate simple bot and webhook sends use compact scope/path metadata', async () => {
  for (const delivery of ['bot', 'webhook']) {
    const h = harness({ delivery, showPath: true });
    await h.handle(wire(RouteType.TransportFlood, undefined, 42, '97'));
    const body = delivery === 'bot' ? '**Roy B V4**: P' : 'P';
    assert.equal(h.sends.length, 1);
    assert.equal(h.sends[0].description, `${body}\n\n\`#Test\` · [\`97\`]`);
    await h.handle(wire(RouteType.TransportDirect, undefined, 99, '97aa'));
    await h.flush();
    assert.equal(h.sends.length, 1);
    assert.equal(h.edits.length, delivery === 'bot' ? 1 : 0);
    if (delivery === 'bot') assert.equal(h.edits[0].description, `${body}\n\n\`#Test\` · [\`97\`,\`AA\`]`);
  }
});

test('path-only simple bot and webhook metadata has a blank separator, including bot edits', async () => {
  for (const delivery of ['bot', 'webhook']) {
    for (const wait of [0, 1200]) {
      for (const showScope of [false, true]) {
        const h = harness({ delivery, wait, showPath: true, showScope });
        const route = showScope ? RouteType.Flood : RouteType.TransportFlood;
        await h.handle(wire(route, undefined, 42, '97'));
        if (wait) await h.flush();
        const body = delivery === 'bot' ? '**Roy B V4**: P' : 'P';
        assert.equal(h.sends.length, 1);
        assert.equal(h.sends[0].description, `${body}\n\n[\`97\`]`);
        await h.handle(wire(route, undefined, 42, '97aa'));
        await h.flush();
        assert.equal(h.sends.length, 1);
        assert.equal(h.edits.length, delivery === 'bot' ? 1 : 0);
        if (delivery === 'bot') assert.equal(h.edits[0].description, `${body}\n\n[\`97\`,\`AA\`]`);
      }
    }
  }
});

test('unscoped and disabled scope output is unchanged across output modes', async () => {
  for (const delivery of ['bot', 'webhook']) {
    for (const mode of ['simple', 'detailed']) {
      for (const showScope of [false, true]) {
        const h = harness({ delivery, mode, showScope });
        await h.handle(wire(showScope ? RouteType.Flood : RouteType.TransportFlood));
        assert.equal(h.sends.length, 1);
        assert.equal(h.sends[0].description, delivery === 'bot' && mode === 'simple' ? '**Roy B V4**: P' : 'P');
        assert.ok(!(h.sends[0].fields || []).some((field) => field.name === 'Scope'));
      }
    }
  }
});

test('unknown and zero scopes render honestly in every delivery format; malformed wire is skipped', async () => {
  for (const delivery of ['bot', 'webhook']) {
    for (const mode of ['simple', 'detailed']) {
      const h = harness({ delivery, mode, names: ['#Wrong'] });
      for (const malformed of ['14', '140000', '1400000000ff']) await h.handle(malformed);
      assert.equal(h.sends.length, 0);
      await h.handle(wire(RouteType.TransportFlood, 0));
      await h.handle(wire(RouteType.TransportDirect, 0x6261));
      assert.equal(h.sends.length, 2);
      for (const [index, code] of ['0x0000', '0x6261'].entries()) {
        if (delivery === 'bot' && mode === 'detailed') {
          assert.equal(h.sends[index].fields.find((field) => field.name === 'Scope')?.value, code);
        } else {
          assert.ok(h.sends[index].description.endsWith(`\n\n\`${code}\``));
        }
      }
    }
  }
});

test('real wire -> decrypted simple bot and webhook show optional scope', async () => {
  for (const delivery of ['bot', 'webhook']) {
    const h = harness({ delivery });
    await h.handle(wire());
    assert.equal(h.sends.length, 1);
    assert.ok(h.sends[0].description.endsWith('\n\n`#Test`'));
    assert.match(h.sends[0].description, /P/);
  }
});
