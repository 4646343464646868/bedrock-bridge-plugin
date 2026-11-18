/**
 * engineBedrockNew.mjs —— 高版本基岩服（Bedrock 1.16+ / 协议 >= 400）连接引擎。
 * 与 engine2.mjs（裸 UDP 的 MCPE 0.14）并列，走现成的 bedrock-protocol 库。
 * 对外暴露和 engine2 相似的接口：chat/say/moveTo/getSelf/getPlayers/on/close/wait，
 * 让 fakebot / botcore 那套能复用。
 *
 * 库位置：/root/bedrock-bridge/node_modules/bedrock-protocol（用户已装，避免插件塞 654M）。
 */
const LIB = '/root/bedrock-bridge/node_modules/bedrock-protocol/index.js'
import { probeBedrock } from './probeBedrock.mjs'
import { ensureRaknet11 } from './raknetPatch.mjs'

// 版本名比较：'1.20.61' >= '1.19.30'
function gteVersion (a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0
    if (x !== y) return x > y
  }
  return true
}

export async function connectBedrockNew(o = {}) {
  const HOST = o.host || '127.0.0.1'
  const PORT = Number(o.port) || 19132
  const USER = o.user || 'DeepSeek'
  const LOG = o.log || (() => {})
  const ONMSG = o.onMessage || (() => {})
  // 高版本基岩登录：offline=true 用离线名直连，跳过 Xbox 认证
  const OFFLINE = o.offline !== false
  let VERSION = o.version || null // 可选，如 '1.20.40'；不填靠 ping 自动匹配
  let probeInfo = null
  if (!VERSION) {
    probeInfo = await probeBedrock(HOST, PORT, 5000)
    if (probeInfo.ok && probeInfo.version) {
      VERSION = probeInfo.version
      LOG('[newbed] 自动探测版本: ' + VERSION + ' (协议 ' + probeInfo.protocol + ', ' + probeInfo.motd + ')')
    } else if (probeInfo.ok && probeInfo.rawVersion) {
      // PONG 自带版本串（即使 Versions 表里查不到也直接用）
      VERSION = probeInfo.rawVersion
      LOG('[newbed] 用 PONG 自带版本: ' + VERSION)
    } else {
      // 绝不硬编码 1.26.60——用错版本会让服务端静默不回 network_settings（已实测复现）
      throw new Error('[new bedrock] 版本探测失败，请手动指定 version 参数（探测结果: ' + JSON.stringify(probeInfo) + '）')
    }
  }

  // >=1.19.30 的服要求 RakNet 协议 11：运行时 patch（幂等，不手改 node_modules）
  const needRaknet11 = gteVersion(VERSION, '1.19.30')
  const patched = ensureRaknet11(needRaknet11)
  LOG('[newbed] RakNet 协议=' + (needRaknet11 ? '11' : '10') + (patched ? ' (已patch)' : ' (无需/已就绪)'))

  const { createClient } = await import(LIB)

  const world = {
    self: { eid: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, name: USER },
    players: new Map(), chunks: new Map(), connected: false, spawned: false,
    online: false, gamemode: 'survival', dimension: 0, time: 6000,
    health: 20, food: 20,
  }
  const listeners = new Map()
  const emit = (ev, d) => { const l = listeners.get(ev); if (l) l.forEach(f => { try { f(d) } catch {} }) }
  const wait = ms => new Promise(r => timers.push(setTimeout(r, ms)))
  const timers = []

  LOG('=== [new bedrock] connecting ' + HOST + ':' + PORT + ' as ' + USER + ' offline=' + OFFLINE + ' ===')

  const client = createClient({
    host: HOST, port: PORT, username: USER, offline: OFFLINE,
    ...(VERSION ? { version: VERSION } : {}),
    connectTimeout: 15000,
    // 安卓 proot 编不了 C++ binding：跳过 native ping，用纯 JS RakNet
    skipPing: true,
    transport: 'raknet',
    raknetBackend: 'jsp-raknet',
    // 避免 worker 子进程加载未 patch 的 jsp-raknet（协议号还是 10）
    useRaknetWorkers: false,
  })

  // 1.20.61+ (compressorInPacketHeader=true) 的严格 BDS 要求每个 batch 首包带压缩标记字节。
  // 库默认 compressionReady=false 直到收到 network_settings，导致首个 request_network_settings
  // 缺 0xff 标记被 BDS 静默丢弃 → 卡死。这里提前置 ready + header=255(无压缩)，让首包合规。
  if (gteVersion(VERSION, '1.20.61')) {
    client.compressionReady = true
    client.compressionHeader = 255
    client.compressionAlgorithm = 'none' // 首包不压缩；收到 network_settings 后库会改回服务端算法
    LOG('[newbed] 预置压缩帧头 (1.20.61+ 严格 BDS 兼容)')
  }

  client.on('error', e => { LOG('[newbed error] ' + (e?.message || e)); emit('error', e) })

  client.on('join', () => {
    world.connected = true
    world.online = true
    LOG('[newbed] joined')
    emit('join', world.self)
  })

  // 登录成功后拿到自己的坐标（StartGame）
  client.on('start_game', pk => {
    try {
      if (pk.position) { world.self.x = pk.position.x; world.self.y = pk.position.y; world.self.z = pk.position.z }
      world.dimension = pk.dimension ?? 0
      world.gamemode = (pk.player_gamemode === 1 || pk.gamemode === 1) ? 'creative' : 'survival'
      world.spawned = true
      LOG('[newbed] START_GAME pos=' + world.self.x + ',' + world.self.y + ',' + world.self.z + ' gm=' + world.gamemode)
      emit('spawn', world.self)
    } catch (e) { LOG('[newbed sg] ' + e.message) }
  })

  // 聊天/公告
  client.on('text', pk => {
    let msg = ''
    if (typeof pk.message === 'string') msg = pk.message
    else if (pk.message?.raw_text) msg = pk.message.raw_text
    else if (Array.isArray(pk.message)) msg = pk.message.map(x => typeof x === 'string' ? x : (x.text || '')).join('')
    LOG('[MSG] ' + msg)
    ONMSG(msg)
    emit('chat', msg)
  })

  // 玩家列表（高版本用 player_list）
  client.on('player_list', pk => {
    try {
      for (const e of (pk.records || [])) {
        if (e.action === 0 || e.action === 'add') {
          const p = { eid: e.uuid || String(e.entity_id), name: e.username || e.display_name || '?', x: 0, y: 0, z: 0 }
          world.players.set(p.eid, p)
          emit('player', p)
        }
      }
    } catch {}
  })

  // 自身移动
  client.on('move_player', pk => {
    try {
      if (!pk.runtime_entity_id || pk.runtime_entity_id === world.self.eid || pk.entity_self_id === 0) {
        if (pk.position) { world.self.x = pk.position.x; world.self.y = pk.position.y; world.self.z = pk.position.z; emit('move', world.self) }
      }
    } catch {}
  })

  client.on('disconnect', pk => {
    world.online = false
    LOG('[newbed] DISCONNECT ' + (pk?.message || ''))
    emit('dead', pk?.message || 'disconnect')
  })
  client.on('close', () => { world.online = false; emit('dead', 'close') })

  const api = {
    // 发聊天 / 命令
    chat (msg) { try { client.queue('text', { type: 'chat', needs_translation: false, source_name: USER, message: String(msg), xuid: '', platform_chat_id: '', filtered_message: '' }) } catch (e) { LOG('[chat] ' + e.message) } },
    say (msg) { this.chat(msg) },
    command (cmd) { this.chat(cmd.startsWith('/') ? cmd : '/' + cmd) },
    // 移动：高版本 MovePlayer
    moveTo (x, y, z, yaw = 0, pitch = 0) {
      try {
        client.queue('move_player', {
          runtime_entity_id: 0, position: { x, y, z }, rotation: { x: pitch, y: yaw, z: yaw },
          mode: 0, on_ground: true, ridden_runtime_entity_id: 0, tick: 0,
        })
        world.self.x = x; world.self.y = y; world.self.z = z
      } catch (e) { LOG('[move] ' + e.message) }
    },
    jump () { this.moveTo(world.self.x, world.self.y + 1.2, world.self.z) },
    getSelf () { return { ...world.self } },
    getPlayers () { return [...world.players.values()].map(p => ({ ...p })) },
    getWorld () { return world },
    on (ev, fn) { if (!listeners.has(ev)) listeners.set(ev, []); listeners.get(ev).push(fn) },
    isAlive () { return world.online },
    close () { timers.forEach(clearTimeout); try { client.close() } catch {} },
    wait (ms) { return wait(ms) },
    // 服务器探测信息（版本/协议号/MOTD）——PONG 里没有正版标志位
    getServerInfo () { return probeInfo || client.advertisement || null },
  }

  // 等待 join / 失败 / 超时。正版服会发 server_to_client_handshake（库 verify 失败会 emit error，
  // 首页规则靠 index.js 捕获错误判定），这里不再用超时猜正版——那会误判离线服。
  await new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn, val) => { if (settled) return; settled = true; clearTimeout(to); fn(val) }
    const to = setTimeout(() => { try { client.close() } catch {}; finish(reject, new Error('[new bedrock] connect timeout (25s)')) }, 25000)
    client.on('join', () => { finish(resolve) })
    client.on('error', e => { try { client.close() } catch {}; finish(reject, e) })
    client.on('disconnect', pk => { finish(reject, new Error('[new bedrock] disconnected: ' + (pk?.message || ''))) })
  })

  return api
}
