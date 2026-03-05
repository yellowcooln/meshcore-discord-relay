import test from 'node:test';
import assert from 'node:assert/strict';

import { extractPacketHex } from '../src/packet-extract.js';

test('extracts plain hex payload', () => {
  const hex = '00112233445566778899aabbccddeeff00112233';
  const out = extractPacketHex('meshcore/BOS/public', Buffer.from(hex, 'utf8'));
  assert.equal(out, hex);
});

test('extracts base64 payload', () => {
  const hex = '00112233445566778899aabbccddeeff00112233';
  const base64 = Buffer.from(hex, 'hex').toString('base64');
  const out = extractPacketHex('meshcore/BOS/public', Buffer.from(base64, 'utf8'));
  assert.equal(out, hex);
});

test('extracts nested JSON packet field', () => {
  const hex = 'aabbccddeeff00112233445566778899aabbccdd';
  const payload = {
    observer: 'YC-Observer',
    packet: {
      payload: {
        packet_hex: hex
      }
    }
  };
  const out = extractPacketHex('meshcore/BOS/public', Buffer.from(JSON.stringify(payload), 'utf8'));
  assert.equal(out, hex);
});

test('extracts packet from JSON integer byte array', () => {
  const bytes = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const payload = { frame: bytes };
  const out = extractPacketHex('meshcore/BOS/public', Buffer.from(JSON.stringify(payload), 'utf8'));
  assert.equal(out, Buffer.from(bytes).toString('hex'));
});

test('extracts binary payload as hex', () => {
  const binary = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  const out = extractPacketHex('meshcore/BOS/public', binary);
  assert.equal(out, binary.toString('hex'));
});

test('returns null for non-packet text payloads', () => {
  const out = extractPacketHex('meshcore/BOS/public', Buffer.from('hello world', 'utf8'));
  assert.equal(out, null);
});
