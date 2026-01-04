const LIKELY_PACKET_KEYS = new Set([
  'hex', 'raw', 'packet', 'packet_hex', 'frame', 'data', 'payload',
  'mesh_packet', 'meshcore_packet', 'rx_packet', 'bytes', 'packet_bytes'
]);

function looksLikeHex(value) {
  const text = value.trim();
  if (text.length < 20) {
    return false;
  }
  if (text.length % 2 !== 0) {
    return false;
  }
  return /^[0-9a-fA-F]+$/.test(text);
}

function tryBase64ToHex(value) {
  const text = value.trim();
  if (text.length < 24) {
    return null;
  }
  if (!/[+/=]/.test(text)) {
    return null;
  }
  try {
    const raw = Buffer.from(text, 'base64');
    if (raw.length < 10) {
      return null;
    }
    return raw.toString('hex');
  } catch {
    return null;
  }
}

function isProbablyBinary(buffer) {
  if (!buffer || buffer.length === 0) {
    return false;
  }
  const limit = Math.min(buffer.length, 200);
  let printable = 0;
  for (let i = 0; i < limit; i += 1) {
    const byte = buffer[i];
    if ((byte >= 32 && byte <= 126) || byte === 9 || byte === 10 || byte === 13) {
      printable += 1;
    }
  }
  return printable / limit < 0.6;
}

function findPacketBlob(value, path = 'root') {
  if (typeof value === 'string') {
    if (looksLikeHex(value)) {
      return { hex: value.trim(), path, hint: 'hex' };
    }
    const b64hex = tryBase64ToHex(value);
    if (b64hex) {
      return { hex: b64hex, path, hint: 'base64' };
    }
    return null;
  }

  if (Array.isArray(value)) {
    if (value.length > 0 && value.slice(0, Math.min(20, value.length)).every((item) => Number.isInteger(item))) {
      try {
        const raw = Buffer.from(value);
        if (raw.length >= 10) {
          return { hex: raw.toString('hex'), path, hint: 'list[int]' };
        }
      } catch {
        return null;
      }
    }
    for (let i = 0; i < value.length; i += 1) {
      const found = findPacketBlob(value[i], `${path}[${i}]`);
      if (found) {
        return found;
      }
    }
    return null;
  }

  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    keys.sort((a, b) => {
      const aScore = LIKELY_PACKET_KEYS.has(a) ? 0 : 1;
      const bScore = LIKELY_PACKET_KEYS.has(b) ? 0 : 1;
      return aScore - bScore;
    });

    for (const key of keys) {
      const child = value[key];
      const childPath = `${path}.${key}`;
      if (typeof child === 'string') {
        if (looksLikeHex(child)) {
          return { hex: child.trim(), path: childPath, hint: 'hex' };
        }
        const b64hex = tryBase64ToHex(child);
        if (b64hex) {
          return { hex: b64hex, path: childPath, hint: 'base64' };
        }
      }
      if (Array.isArray(child) && child.length > 0 && child.slice(0, Math.min(20, child.length)).every((item) => Number.isInteger(item))) {
        try {
          const raw = Buffer.from(child);
          if (raw.length >= 10) {
            return { hex: raw.toString('hex'), path: childPath, hint: 'list[int]' };
          }
        } catch {
          // ignore
        }
      }
      if (child && typeof child === 'object') {
        const found = findPacketBlob(child, childPath);
        if (found) {
          return found;
        }
      }
    }
  }

  return null;
}

export function extractPacketHex(topic, payloadBuffer) {
  if (!payloadBuffer || payloadBuffer.length === 0) {
    return null;
  }
  const text = payloadBuffer.toString('utf8').trim();
  if (text && text.startsWith('{') && text.endsWith('}')) {
    try {
      const obj = JSON.parse(text);
      const found = findPacketBlob(obj);
      if (found) {
        return found.hex;
      }
    } catch {
      // ignore JSON parse errors
    }
  }

  if (text) {
    if (looksLikeHex(text)) {
      return text.trim();
    }
    const b64hex = tryBase64ToHex(text);
    if (b64hex) {
      return b64hex;
    }
  }

  if (isProbablyBinary(payloadBuffer) && payloadBuffer.length >= 10) {
    return payloadBuffer.toString('hex');
  }

  return null;
}
