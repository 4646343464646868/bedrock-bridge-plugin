/**
 * chunkNew.mjs —— Bedrock 1.20.x 子区块（sub_chunk）解析。
 * level_chunk.payload（cache_enabled=false）= 若干子区块 + biome + border + tile entity。
 * 每个子区块：version(u8) + [storage] + [yOffset]
 *   version 3/4/5/6/8 → paletted storage: count(u8&0x0f)+1 种方块
 *     palette: count 个 varint runtime_id
 *     data: varint 长度 + packed 位索引（每格 ceil(log2(count)) 位）
 *   version 7/9 → 网络 runtime id 的 palette storage（结构同上，值是 runtime id）
 *
 * 输出：{ subChunks: [{y, blocks: Map<index, runtimeId>}], biomeY }
 */
function readVarInt (b, o) {
  let result = 0, shift = 0, byte
  do {
    if (o >= b.length) return { value: 0, next: o }
    byte = b[o++]
    result |= (byte & 0x7f) << shift
    shift += 7
  } while (byte & 0x80)
  return { value: result >>> 0, next: o }
}

function readVarIntSigned (b, o) {
  const r = readVarInt(b, o)
  // zigzag 解码
  return { value: (r.value >>> 1) ^ -(r.value & 1), next: r.next }
}

export function parseSubChunks (payload) {
  const out = { subChunks: [], biomeY: null }
  if (!payload || !payload.length) return out
  const b = payload
  let o = 0
  let y = 0
  while (o < b.length) {
    const version = b[o++]
    if (version === 0) { y++; continue }        // 空子区块
    if (version === 0x07 || version === 0x09) {
      // 网络 runtime id palette storage（1.20.x 常见）
      const cnt = b[o++] & 0x0f
      const palette = []
      for (let i = 0; i <= cnt; i++) { const r = readVarInt(b, o); palette.push(r.value); o = r.next }
      const lenR = readVarInt(b, o); o = lenR.next
      const data = b.slice(o, o + lenR.value); o += lenR.value
      const bits = Math.max(1, Math.ceil(Math.log2(palette.length)))
      const perWord = Math.floor(32 / bits)
      const blocks = new Map()
      let idx = 0
      for (let w = 0; w < data.length && idx < 4096; w++) {
        const word = data.readUInt32LE(w * 4)
        for (let k = 0; k < perWord && idx < 4096; k++, idx++) {
          const pi = (word >>> (k * bits)) & ((1 << bits) - 1)
          if (pi < palette.length) blocks.set(idx, palette[pi])
        }
      }
      out.subChunks.push({ y, version, palette, blocks })
      y++
      continue
    }
    // 其它版本：paletted storage（本地 runtime id），结构同上也解析出 palette
    const cnt = b[o++] & 0x0f
    const palette = []
    for (let i = 0; i <= cnt; i++) { const r = readVarInt(b, o); palette.push(r.value); o = r.next }
    const lenR = readVarInt(b, o); o = lenR.next
    const data = b.slice(o, o + lenR.value); o += lenR.value
    const bits = Math.max(1, Math.ceil(Math.log2(palette.length)))
    const perWord = Math.floor(32 / bits)
    const blocks = new Map()
    let idx = 0
    for (let w = 0; w < data.length && idx < 4096; w++) {
      const word = data.readUInt32LE(w * 4)
      for (let k = 0; k < perWord && idx < 4096; k++, idx++) {
        const pi = (word >>> (k * bits)) & ((1 << bits) - 1)
        if (pi < palette.length) blocks.set(idx, palette[pi])
      }
    }
    out.subChunks.push({ y, version, palette, blocks })
    y++
  }
  return out
}

// 子区块内 index → (x,y,z) 局部坐标：index = (x<<8)|(z<<4)|y  (1.20.x 布局)
export function subIndexToXYZ (idx) {
  return { x: idx >> 8, z: (idx >> 4) & 0x0f, y: idx & 0x0f }
}
