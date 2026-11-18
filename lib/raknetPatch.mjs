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

/**
 * 高版本基岩的游戏包首字节常 < 0x80（如 0x0/0x3），jsp-raknet 的 handlePacket
 * 在 state=1 后仍把它们当 RakNet 控制包吞掉，导致服务端的 network_settings 等
 * 永远到不了协议层 → 连上 RakNet 后卡死。实测补这一行后 7s 成功进服。
 * 幂等文件 patch：把 else if(ConnectedPong)...} 之后补一个 state=1 直通分支。
 */
export function ensureGamePacketPassthrough () {
  try {
    const fs = require('node:fs')
    const p = JSP + '/js/Connection.js'
    let s = fs.readFileSync(p, 'utf8')
    if (s.includes('__bbPassthrough')) return true
    const anchor = `            else if (id === Identifiers_1.default.ConnectedPong) {\n                await this.handleConnectedPong(packet.buffer);\n            }\n        }`
    const repl = `            else if (id === Identifiers_1.default.ConnectedPong) {\n                await this.handleConnectedPong(packet.buffer);\n            }\n            else if (this.state === 1 /* Connected */) { // __bbPassthrough\n                this.listener.emit('encapsulated', packet, this.address);\n            }\n        }`
    if (!s.includes(anchor)) return false
    fs.writeFileSync(p, s.replace(anchor, repl))
    return true
  } catch (e) {
    return false
  }
}
