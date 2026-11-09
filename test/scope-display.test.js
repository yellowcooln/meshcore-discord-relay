import test from 'node:test';
import assert from 'node:assert/strict';
import * as scope from '../src/scope-display.js';
import { MeshCoreDecoder, PayloadType, RouteType } from '../src/meshcore-decoder.js';
import { calcTransportCodeForRegion } from '@michaelhart/meshcore-decoder/dist/crypto/region-transport.js';

const raw = 'ca78b9ab0775d477c1f6490a398bf4edc75240';
function wire(route = RouteType.TransportFlood, code = calcTransportCodeForRegion('#Test', PayloadType.GroupText, Buffer.from(raw, 'hex')), home = 42) {
  const header = Buffer.alloc(6);
  header[0] = (PayloadType.GroupText << 2) | route;
  header.writeUInt16LE(code, 1);
  header.writeUInt16LE(home, 3);
  return header.toString('hex') + raw;
}

test('combined scope and path metadata survive long message truncation', () => {
  const text = scope.appendScopeSuffix('x'.repeat(1900), { label: '#Test', code: 1 }, '`AA → BB`');
  assert.ok(text.length <= 1900);
  assert.match(text, /Scope: #Test/);
  assert.match(text, /AA → BB/);
  assert.equal(scope.appendScopeSuffix('unchanged', null), 'unchanged');
});

test('recognizes a configured scope from actual decoded wire payload', () => {
  assert.equal(typeof scope.resolvePacketScope, 'function', 'scope recognition is implemented');
  const packet = MeshCoreDecoder.decode(wire());
  assert.equal(packet.isValid, true);
  assert.equal(scope.resolvePacketScope(packet, ['#Wrong', '#Test']).label, '#Test');
});

test('scope recognition uses encrypted payload and payload type, not a static region ID', () => {
  const packet = MeshCoreDecoder.decode(wire(RouteType.TransportFlood, 0x6261));
  assert.equal(scope.resolvePacketScope(packet, ['#Scope194']).label, '#Scope194');
  const changed = MeshCoreDecoder.decode(wire(RouteType.TransportFlood, 0x6261).slice(0, -2) + '41');
  assert.equal(scope.resolvePacketScope(changed, ['#Scope194']).label, '0x6261');
  const differentType = { ...packet, payloadType: PayloadType.GroupData };
  assert.equal(scope.resolvePacketScope(differentType, ['#Scope194']).label, '0x6261');
});

test('does not guess between colliding 16-bit scope names', () => {
  const packet = MeshCoreDecoder.decode(wire(RouteType.TransportFlood, 0x6261));
  assert.equal(scope.resolvePacketScope(packet, ['#Scope194', '#Scope281']).label,
    '0x6261 (ambiguous: #Scope194, #Scope281)');
});

test('only valid scoped transports have scope, including zero and unknown codes', () => {
  for (const route of [RouteType.TransportFlood, RouteType.TransportDirect]) {
    const packet = MeshCoreDecoder.decode(wire(route, 0, 123));
    assert.deepEqual(scope.resolvePacketScope(packet, ['#Test']), { code: 0, label: '0x0000' });
    const known = MeshCoreDecoder.decode(wire(route));
    assert.match(scope.resolvePacketScope(known, ['#Wrong']).label, /^0x[0-9A-F]{4}$/);
    assert.equal(scope.resolvePacketScope(known, ['#Test']).label, '#Test');
  }
  for (const route of [RouteType.Flood, RouteType.Direct]) {
    const packet = MeshCoreDecoder.decode(((PayloadType.GroupText << 2) | route).toString(16) + '00' + raw);
    assert.equal(scope.resolvePacketScope(packet, ['#Test']), null);
  }
  for (const hex of ['14', '140000', '1400000000ff', '']) {
    assert.equal(scope.resolvePacketScope(MeshCoreDecoder.decode(hex), ['#Test']), null);
  }
  const packet = MeshCoreDecoder.decode(wire());
  const onlyHomeMatches = { ...packet, transportCodes: [0, packet.transportCodes[0]] };
  assert.equal(scope.resolvePacketScope(onlyHomeMatches, ['#Test']).label, '0x0000');
});
