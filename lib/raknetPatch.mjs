/**
 * raknetPatch.mjs —— 运行时把 jsp-raknet 的 RakNet 协议号 10 改成 11。
 * >=1.19.30 的基岩服要求 RakNet 协议 11；jsp-raknet 硬编码 10，不改就连不上。
 * 用运行时 monkey-patch 而非手改 node_modules，这样进 git 后也能用、幂等。
 *
 * 注意：worker 子进程加载的是独立模块实例，patch 不到——所以引擎必须 useRaknetWorkers:false。
 */
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const JSP = '/root/bedrock-bridge/node_modules/jsp-raknet'

export function ensureRaknet11 (want11 = true) {
  if (!want11) return false // 低版本服(<1.19.30)要 10，不动
  try {
    const OC1mod = require(JSP + '/js/protocol/OpenConnectionRequest1.js')
    const OC1 = OC1mod.default || OC1mod
    if (OC1.prototype.__bbRaknet11) return true
    const orig = OC1.prototype.encode
    OC1.prototype.encode = function (...a) {
      if (this.protocol === 10) this.protocol = 11
      return orig.apply(this, a)
    }
    OC1.prototype.__bbRaknet11 = true
    return true
  } catch (e) {
    return false
  }
}
