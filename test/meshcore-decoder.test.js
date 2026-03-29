import test from 'node:test';
import assert from 'node:assert/strict';

let dependencyError = null;
let MeshCoreDecoder;
let PayloadType;
let RouteType;

try {
  ({ MeshCoreDecoder, PayloadType, RouteType } = await import('../src/meshcore-decoder.js'));
} catch (err) {
  dependencyError = err;
}

const BOT_CHANNEL_KEY = 'eb50a1bcb3e4e5d7bf69a57c9dada211';

function skipIfMissingDeps(t) {
  if (!dependencyError) {
    return false;
  }
  t.skip(`dependencies not installed: ${dependencyError.code || dependencyError.message}`);
  return true;
}

test('decoder handles 3-byte hop labels and decrypts GroupText', (t) => {
  if (skipIfMissingDeps(t)) {
    return;
  }

  const packet = MeshCoreDecoder.decode('15833fa002860ccae0eed9ca78b9ab0775d477c1f6490a398bf4edc75240', {
    keyStore: MeshCoreDecoder.createKeyStore({
      channelSecrets: [BOT_CHANNEL_KEY]
    })
  });

  assert.equal(packet.isValid, true);
  assert.equal(packet.routeType, RouteType.Flood);
  assert.equal(packet.payloadType, PayloadType.GroupText);
  assert.equal(packet.pathHashSize, 3);
  assert.equal(packet.pathLength, 3);
  assert.deepEqual(packet.path, ['3FA002', '860CCA', 'E0EED9']);
  assert.equal(packet.payload.decoded?.decrypted?.sender, 'Roy B V4');
  assert.equal(packet.payload.decoded?.decrypted?.message, 'P');
});

test('decoder handles multibyte GroupText sender and message text', (t) => {
  if (skipIfMissingDeps(t)) {
    return;
  }

  const packet = MeshCoreDecoder.decode('1540cab3b15626481a5ba64247ab25766e410b026e0678a32da9f0c3946fae5b714cab170f', {
    keyStore: MeshCoreDecoder.createKeyStore({
      channelSecrets: [BOT_CHANNEL_KEY]
    })
  });

  assert.equal(packet.isValid, true);
  assert.equal(packet.routeType, RouteType.Flood);
  assert.equal(packet.payloadType, PayloadType.GroupText);
  assert.equal(packet.pathHashSize, 2);
  assert.equal(packet.pathLength, 0);
  assert.equal(packet.path, null);
  assert.equal(packet.payload.decoded?.decrypted?.sender, 'Howl 👾');
  assert.equal(packet.payload.decoded?.decrypted?.message, 'prefix 0101');
});

test('decoder still handles 1-byte path encoding', (t) => {
  if (skipIfMissingDeps(t)) {
    return;
  }

  const packet = MeshCoreDecoder.decode('150013752F15A1BF3C018EB1FC4F26B5FAEB417BB0F1AE8FF07655484EBAA05CB9A927D689');

  assert.equal(packet.isValid, true);
  assert.equal(packet.routeType, RouteType.Flood);
  assert.equal(packet.payloadType, PayloadType.GroupText);
  assert.equal(packet.pathHashSize, 1);
  assert.equal(packet.pathLength, 0);
  assert.equal(packet.path, null);
  assert.equal(packet.payload.decoded?.channelHash, '13');
});
