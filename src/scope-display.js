import { normalizeRegionName, transportCodeMatchesRegion } from '@michaelhart/meshcore-decoder/dist/crypto/region-transport.js';
import { RouteType } from './meshcore-decoder.js';

// Public hashtag region names are case-sensitive key material, not scope IDs.
export function normalizeScopeNames(value = '') {
  return [...new Set(value.split(',')
    .map((name) => name.trim())
    .filter((name) => name && name !== '#' && !/[\x00-\x1f\x7f]/.test(name))
    .map(normalizeRegionName)
    .filter((name) => Buffer.byteLength(name, 'utf8') <= 64))].slice(0, 64);
}

// Keep scope metadata visible without exceeding the relay's description budget.
export function appendScopeSuffix(messageText, scope, pathLine = '') {
  if (!scope && !pathLine) {
    return messageText;
  }
  const label = scope ? scope.label.replace(/([*_`~\\])/g, '\\$1').slice(0, 512) : '';
  const suffix = [label ? `Scope: ${label}` : '', pathLine.slice(0, 1000)].filter(Boolean).map((line) => `\n${line}`).join('');
  const budget = 1900 - suffix.length;
  const body = messageText.length > budget ? `${messageText.slice(0, budget - 3)}...` : messageText;
  return `${body}${suffix}`;
}

export function scopeEmbedFields(scope) {
  return scope ? [{ name: 'Scope', value: scope.label.replace(/([*_`~\\])/g, '\\$1').slice(0, 512), inline: true }] : [];
}

export function resolvePacketScope(packet, names = []) {
  if (!packet?.isValid || (packet.routeType !== RouteType.TransportFlood && packet.routeType !== RouteType.TransportDirect)) {
    return null;
  }
  const code = packet.transportCodes?.[0];
  if (!Number.isInteger(code) || code < 0 || code > 0xffff) {
    return null;
  }
  const matches = names.filter((name) => transportCodeMatchesRegion(name, packet.payloadType, packet.payload.raw, code));
  const hex = `0x${code.toString(16).toUpperCase().padStart(4, '0')}`;
  const label = matches.length > 1
    ? `${hex} (ambiguous: ${matches.join(', ')})`
    : matches[0] || hex;
  return { code, label };
}
