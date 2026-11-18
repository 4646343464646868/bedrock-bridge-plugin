/**
 * probeBedrock.mjs —— 高版本基岩服版本探测（不依赖 native binding）。
 * 用 jsp-raknet 的裸 UnconnectedPing 拿 PONG，解析出协议号，
 * 再从 bedrock-protocol 的全版本表反查版本名。这样不填版本也能自动适配。
 *
 * PONG 格式：MCPE;MOTD;协议号;版本名;在线;上限;serverId;level;gamemode;gamemodeId;portV4;portV6;0;
 */
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const JSP = '/root/bedrock-bridge/node_modules/jsp-raknet'
const OPTS = '/root/bedrock-bridge/node_modules/bedrock-protocol/src/options.js'

let _Versions = null
async function versions () {
  if (_Versions) return _Versions
  try {
    const O = require(OPTS)
    _Versions = O.Versions || {}
  } catch { _Versions = {} }
  return _Versions
}

export function parsePong (s) {
  const raw = s.includes('MCPE;') ? s.slice(s.indexOf('MCPE;')) : s
  const p = raw.split(';')
  return {
    header: p[0] || '', motd: p[1] || '', protocol: parseInt(p[2]) || 0,
    rawVersion: p[3] || '', playersOnline: parseInt(p[4]) || 0, playersMax: parseInt(p[5]) || 0,
    serverId: p[6] || '', levelName: p[7] || '', gamemode: p[8] || '',
    portV4: parseInt(p[10]) || 0, portV6: parseInt(p[11]) || 0, raw: s,
  }
}

export async function probeBedrock (host, port = 19132, timeoutMs = 4000) {
  const Versions = await versions()
  return new Promise(async (resolve) => {
    let done = false, client
    const finish = (v) => { if (done) return; done = true; try { client?.close?.() } catch {}; resolve(v) }
    try {
      const { Client } = require(JSP)
      client = new Client(host, Number(port))
      client.on('error', () => finish({ ok: false, error: 'raknet error' }))
      client.ping((serverName, guid) => {
        const info = parsePong(String(serverName || ''))
        let version = null
        for (const [name, proto] of Object.entries(Versions)) {
          if (Number(proto) === info.protocol) { version = name; break }
        }
        finish({ ok: true, ...info, version, guid: String(guid || '') })
      })
    } catch (e) {
      finish({ ok: false, error: String(e?.message || e) })
    }
    setTimeout(() => finish({ ok: false, error: 'ping timeout' }), timeoutMs)
  })
}
