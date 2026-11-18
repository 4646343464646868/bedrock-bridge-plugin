/**
 * subChunkHack.mjs —— 绕过 minecraft-data 的 sub_chunk_request 字段顺序 bug。
 * 
 * 库(proto.yml)顺序: dimension → origin(vec3i) → requests([]lu32, 4字节LE计数)
 * BDS(gophertunnel)顺序: dimension → offsets(varuint32计数) → position(SubChunkPos)
 * 
 * 差异: 字段顺序反了 + 计数编码不同(lu32 vs varuint32)
 * 解决: 直接构造正确字节，推入 client.sendQ 让库的 _tick batch+frame
 */

function writeZigzagVarInt32 (buf, val) {
  let v = ((val | 0) << 1) ^ ((val | 0) >> 31) // zigzag
  v = v >>> 0
  while (true) {
    if ((v & ~0x7f) === 0) { buf.push(v & 0xff); return }
    buf.push((v & 0x7f) | 0x80); v >>>= 7
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
 * 构造 sub_chunk_request 完整包字节（含 varuint32 包 ID）。
 * 格式: varuint32(0xaf) + zigzag32(dimension) + varuint32(count) + i8×3×count + zigzag32×3(position)
 */
export function buildSubChunkRequest (dimension, position, offsets) {
  const buf = []
  // 包 ID: varuint32(0xaf=175) → af 01
  writeVarUInt32(buf, 0xaf)
  // 1. dimension: zigzag varint32
  writeZigzagVarInt32(buf, dimension)
  // 2. offsets: varuint32(count) + count × {dx:i8, dy:i8, dz:i8}
  writeVarUInt32(buf, offsets.length)
  for (const o of offsets) {
    buf.push((o.dx | 0) & 0xff)
    buf.push((o.dy | 0) & 0xff)
    buf.push((o.dz | 0) & 0xff)
  }
  // 3. position: zigzag32(x), zigzag32(y), zigzag32(z)
  writeZigzagVarInt32(buf, position.x)
  writeZigzagVarInt32(buf, position.y)
  writeZigzagVarInt32(buf, position.z)
  return Buffer.from(buf)
}
