/**
 * blockMapNew.mjs —— 1.20.x runtime_id ↔ 方块名 映射。
 * 运行时读 minecraft-data 的 blocks.json（按版本目录），建 runtimeId 区间 → 名字 的索引。
 * 数据源：/root/bedrock-bridge/node_modules/minecraft-data/minecraft-data/data/bedrock/<version>/
 */
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const MD = '/root/bedrock-bridge/node_modules/minecraft-data/minecraft-data/data/bedrock'

const cache = new Map() // version -> { byRuntime: Map<rtid, name>, byName: Map<name, {net, rt}> }

function load (version) {
  if (cache.has(version)) return cache.get(version)
  const out = { byRuntime: new Map(), byName: new Map(), blocks: [] }
  try {
    const blocks = require(MD + '/' + version + '/blocks.json')
    const items = require(MD + '/' + version + '/items.json')
    const arr = Array.isArray(blocks) ? blocks : (blocks.blocks || [])
    for (const b of arr) {
      const lo = b.minStateId != null ? b.minStateId : b.defaultState
      const hi = b.maxStateId != null ? b.maxStateId : b.defaultState
      if (lo == null) continue
      out.blocks.push(b)
      // 区间映射：runtime id 落在 [lo,hi] → 该方块名
      for (let rt = lo; rt <= hi && rt - lo < 4096; rt++) out.byRuntime.set(rt, b.name)
    }
    const iarr = Array.isArray(items) ? items : (items.items || [])
    for (const it of iarr) {
      if (!it || !it.name) continue
      const b = out.blocks.find(x => x.name === it.name)
      out.byName.set(it.name, { net: it.id, rt: b ? (b.minStateId != null ? b.minStateId : b.defaultState) : undefined })
    }
  } catch (e) { /* 数据不可用时留空 */ }
  cache.set(version, out)
  return out
}

export function runtimeToName (version, runtimeId) {
  const m = load(version)
  return m.byRuntime.get(runtimeId) || ('unknown_' + runtimeId)
}

export function nameToItem (version, name) {
  const m = load(version)
  return m.byName.get(name) || null
}

export function blockNameByRuntime (version, runtimeId) {
  return runtimeToName(version, runtimeId)
}
