/**
 * subChunkHack.mjs —— 绕过 minecraft-data 的 sub_chunk_request 字段顺序 bug。
 * proto.yml: dimension → origin → requests
 * gophertunnel/BDS: dimension → offsets → position
 * 字段顺序反了，库序列化的包服务端读不懂。
 * 这里直接构造原始字节，按 gophertunnel 的正确顺序。
 */

function writeVarInt32 (buf, val) {
  val = val | 0
  while (true) {
    if ((val & ~0x7f) === 0) { buf.push(val & 0xff); return }
    buf.push((val & 0x7f) | 0x80); val >>>= 7
  }
}

function writeVarUInt32 (buf, val) {
  val = val >>> 0
  while (true) {
    if ((val & ~0x7f) === 0) { buf.push(val & 0xff); return }
    buf.push((val & 0x7f) | 0x80); val >>>= 7
  }
}

/**
 * 构造 sub_chunk_request 的原始 payload（不含包头）。
 * @param {number} dimension - 维度 (0=overworld)
 * @param {{x,y,z}} position - SubChunkPos: x=chunkX, y=subChunkIndex(0), z=chunkZ
 * @param {{dx,dy,dz}[]} offsets - 请求的子区块偏移
 * @returns {Buffer} 原始字节
 */
export function buildSubChunkRequest (dimension, position, offsets) {
  const buf = []
  // 1. dimension: varint32
  writeVarInt32(buf, dimension)
  // 2. offsets: varuint32(count) + count × {dx:i8, dy:i8, dz:i8}
  writeVarUInt32(buf, offsets.length)
  for (const o of offsets) {
    buf.push((o.dx | 0) & 0xff)
    buf.push((o.dy | 0) & 0xff)
    buf.push((o.dz | 0) & 0xff)
  }
  // 3. position: varint32(x), varint32(y), varint32(z)
  writeVarInt32(buf, position.x)
  writeVarInt32(buf, position.y)
  writeVarInt32(buf, position.z)
  return Buffer.from(buf)
}
