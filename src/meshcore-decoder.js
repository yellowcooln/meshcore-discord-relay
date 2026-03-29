import { MeshCoreKeyStore } from '@michaelhart/meshcore-decoder/dist/crypto/key-manager.js';
import { GroupTextPayloadDecoder } from '@michaelhart/meshcore-decoder/dist/decoder/payload-decoders/group-text.js';
import {
  PayloadType,
  PayloadVersion,
  RouteType
} from '@michaelhart/meshcore-decoder/dist/types/enums.js';
import {
  hexToBytes,
  bytesToHex,
  numberToHex
} from '@michaelhart/meshcore-decoder/dist/utils/hex.js';

function decodePathLenByte(pathLenByte) {
  const hashSize = (pathLenByte >> 6) + 1;
  const hopCount = pathLenByte & 63;
  return { hashSize, hopCount, byteLength: hopCount * hashSize };
}

function calculateMessageHash(bytes, routeType, payloadType, payloadVersion) {
  const constantHeader = (payloadType << 2) | (payloadVersion << 6);
  let offset = 1;

  if (routeType === RouteType.TransportFlood || routeType === RouteType.TransportDirect) {
    offset += 4;
  }

  if (bytes.length > offset) {
    const { byteLength } = decodePathLenByte(bytes[offset]);
    offset += 1 + byteLength;
  }

  const payloadData = bytes.slice(offset);
  const hashInput = [constantHeader, ...Array.from(payloadData)];

  let hash = 0;
  for (const value of hashInput) {
    hash = ((hash << 5) - hash + value) & 0xffffffff;
  }

  return numberToHex(hash, 8);
}

export class MeshCoreDecoder {
  static createKeyStore(initialKeys) {
    return new MeshCoreKeyStore(initialKeys);
  }

  static decode(hexData, options) {
    const bytes = hexToBytes(hexData);

    if (bytes.length < 2) {
      return {
        messageHash: '',
        routeType: RouteType.Flood,
        payloadType: PayloadType.RawCustom,
        payloadVersion: PayloadVersion.Version1,
        pathLength: 0,
        pathHashSize: 1,
        path: null,
        payload: { raw: '', decoded: null },
        totalBytes: bytes.length,
        isValid: false,
        errors: ['Packet too short (minimum 2 bytes required)']
      };
    }

    try {
      let offset = 0;
      const header = bytes[0];
      const routeType = header & 0x03;
      const payloadType = (header >> 2) & 0x0f;
      const payloadVersion = (header >> 6) & 0x03;

      offset = 1;

      let transportCodes;
      if (routeType === RouteType.TransportFlood || routeType === RouteType.TransportDirect) {
        if (bytes.length < offset + 4) {
          throw new Error('Packet too short for transport codes');
        }
        const code1 = bytes[offset] | (bytes[offset + 1] << 8);
        const code2 = bytes[offset + 2] | (bytes[offset + 3] << 8);
        transportCodes = [code1, code2];
        offset += 4;
      }

      if (bytes.length < offset + 1) {
        throw new Error('Packet too short for path length');
      }

      const pathLenByte = bytes[offset];
      const { hashSize: pathHashSize, hopCount: pathHopCount, byteLength: pathByteLength } = decodePathLenByte(pathLenByte);
      if (pathHashSize === 4) {
        throw new Error('Invalid path length byte: reserved hash size (bits 7:6 = 11)');
      }

      offset += 1;

      if (bytes.length < offset + pathByteLength) {
        throw new Error('Packet too short for path data');
      }

      let path = null;
      if (pathHopCount > 0) {
        path = [];
        const pathBytes = bytes.subarray(offset, offset + pathByteLength);
        for (let i = 0; i < pathHopCount; i += 1) {
          const hopBytes = pathBytes.subarray(i * pathHashSize, (i + 1) * pathHashSize);
          path.push(bytesToHex(hopBytes));
        }
      }

      offset += pathByteLength;

      const payloadBytes = bytes.subarray(offset);
      const payloadHex = bytesToHex(payloadBytes);

      let decodedPayload = null;
      if (payloadType === PayloadType.GroupText) {
        decodedPayload = GroupTextPayloadDecoder.decode(payloadBytes, options);
      }

      return {
        messageHash: calculateMessageHash(bytes, routeType, payloadType, payloadVersion),
        routeType,
        payloadType,
        payloadVersion,
        transportCodes,
        pathLength: pathHopCount,
        pathHashSize,
        path,
        payload: {
          raw: payloadHex,
          decoded: decodedPayload
        },
        totalBytes: bytes.length,
        isValid: true
      };
    } catch (error) {
      return {
        messageHash: '',
        routeType: RouteType.Flood,
        payloadType: PayloadType.RawCustom,
        payloadVersion: PayloadVersion.Version1,
        pathLength: 0,
        pathHashSize: 1,
        path: null,
        payload: { raw: '', decoded: null },
        totalBytes: bytes.length,
        isValid: false,
        errors: [error instanceof Error ? error.message : 'Unknown decoding error']
      };
    }
  }
}

export {
  PayloadType,
  PayloadVersion,
  RouteType
};
