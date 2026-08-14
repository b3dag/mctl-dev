/** Minimal Minecraft protocol codec — just enough for handshake/status/login. */

export function readVarInt(buf, offset = 0) {
  let value = 0;
  let shift = 0;
  let pos = offset;
  while (true) {
    if (pos >= buf.length) return null; // need more bytes
    const byte = buf[pos++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, size: pos - offset };
    shift += 7;
    if (shift > 35) throw new Error('VarInt too big');
  }
}

export function writeVarInt(value) {
  const bytes = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    bytes.push(b);
  } while (v !== 0);
  return Buffer.from(bytes);
}

export function readString(buf, offset) {
  const len = readVarInt(buf, offset);
  if (!len) return null;
  const start = offset + len.size;
  const end = start + len.value;
  if (end > buf.length) return null;
  return { value: buf.slice(start, end).toString('utf8'), size: len.size + len.value };
}

export function writeString(str) {
  const data = Buffer.from(str, 'utf8');
  return Buffer.concat([writeVarInt(data.length), data]);
}

/** Frame a packet: [len][packetId][payload] */
export function packet(id, ...parts) {
  const body = Buffer.concat([writeVarInt(id), ...parts]);
  return Buffer.concat([writeVarInt(body.length), body]);
}

/**
 * Pull one complete length-prefixed packet off the front of a buffer.
 * Returns { id, payload, rest } or null when more data is needed.
 */
export function takePacket(buf) {
  const len = readVarInt(buf, 0);
  if (!len) return null;
  const total = len.size + len.value;
  if (buf.length < total) return null;
  const body = buf.slice(len.size, total);
  const id = readVarInt(body, 0);
  if (!id) return null;
  return {
    id: id.value,
    payload: body.slice(id.size),
    rest: buf.slice(total),
  };
}

export function parseHandshake(payload) {
  const proto = readVarInt(payload, 0);
  if (!proto) return null;
  const addr = readString(payload, proto.size);
  if (!addr) return null;
  let off = proto.size + addr.size;
  if (payload.length < off + 2) return null;
  const port = payload.readUInt16BE(off);
  off += 2;
  const next = readVarInt(payload, off);
  if (!next) return null;
  // Forge/BungeeCord append null-separated extras to the hostname.
  const host = addr.value.split('\0')[0].replace(/\.$/, '').toLowerCase();
  return { protocol: proto.value, host, port, nextState: next.value };
}
