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
import { buildSubChunkRequest } from './subChunkHack.mjs'
import { ensureRaknet11, ensureGamePacketPassthrough } from './raknetPatch.mjs'

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
  const passthrough = ensureGamePacketPassthrough()
  LOG('[newbed] RakNet 协议=' + (needRaknet11 ? '11' : '10') + (patched ? ' (已patch)' : ' (无需/已就绪)') + ' · 游戏包直通=' + (passthrough ? 'OK' : '失败'))

  const { createClient } = await import(LIB)

  const world = {
    self: { eid: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, name: USER },
    players: new Map(), chunks: new Map(), subChunks: new Map(), connected: false, spawned: false,
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

  // 压缩由库自己按 network_settings 协商，不要预置 compressionReady/header/algorithm——
  // 实测预置会让连接失败（库自建服基线：不预置 2.6s 连上，预置即卡死）。
  client.on('error', e => { LOG('[newbed error] ' + (e?.message || e)); emit('error', e) })

  client.on('join', () => {
    world.connected = true
    world.online = true
    LOG('[newbed] joined')
    startAuthInput()
    // 关掉 blob 缓存 → 服务端直接在 level_chunk.payload 里给 sub_chunk 数据（省掉 blob 协商）
    // 实测该包在部分服务端会被判 unexpectedPacket 而踢，默认不发，按需开启。
    if (o.cacheStatus === false) {
      try { client.queue('client_cache_status', { enabled: false }); LOG('[newbed] client_cache_status(enabled:false) 已发') } catch (e) { LOG('[cache] ' + e.message) }
    }
    emit('join', world.self)
  })

  // 请求区块半径：必须在 start_game 之后发（join 时发会被服务端判 unexpectedPacket 踢掉）
  const requestChunks = () => {
    if (world.chunksRequested) return
    world.chunksRequested = true
    setTimeout(() => {
      try { client.queue('request_chunk_radius', { chunk_radius: 8, max_radius: 12 }); LOG('[newbed] request_chunk_radius(8) 已发') } catch (e) { LOG('[radius] ' + e.message) }
    }, 300)
  }

  // 登录成功后拿到自己的坐标（StartGame）
  client.on('start_game', pk => {
    try {
      // 保存原始字段供核对（player_position / position / spawn_position 都留一份）
      world._sgRaw = {
        player_position: pk.player_position, position: pk.position,
        spawn_position: pk.spawn_position, rotation: pk.rotation,
        entity_id: String(pk.entity_id), runtime_entity_id: String(pk.runtime_entity_id),
        // 服务端权威移动 / 物品栏管理 等开关
        server_authoritative_movement: pk.server_authoritative_movement,
        server_authoritative_inventory: pk.server_authoritative_inventory,
        server_authoritative_block_breaking: pk.server_authoritative_block_breaking,
        multiplayer_correlation_id: pk.multiplayer_correlation_id,
        player_permission: pk.player_permission,
        gamemode: pk.player_gamemode, world_gamemode: pk.world_gamemode,
        level_id: pk.level_id, world_name: pk.world_name,
      }
      const pos = pk.player_position || pk.position
      if (pos) { world.self.x = pos.x; world.self.y = pos.y; world.self.z = pos.z }
      { const e = pk.runtime_entity_id ?? pk.entity_id ?? 0; world.self.eid = typeof e === 'bigint' ? Number(e) : e }
      world.dimension = typeof pk.dimension === 'number' ? pk.dimension : 0
      world.gamemode = (pk.player_gamemode === 1 || pk.gamemode === 1) ? 'creative' : 'survival'
      world.spawned = true
      LOG('[newbed] START_GAME pos=' + world.self.x + ',' + world.self.y + ',' + world.self.z + ' gm=' + world.gamemode)
      requestChunks()
      emit('spawn', world.self)
    } catch (e) { LOG('[newbed sg] ' + e.message) }
  })

  // 命令执行结果
  client.on('command_output', pk => { try { emit('commandOutput', pk) } catch {} })
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

  // 区块：level_chunk（0x3a）。sub_chunk_count=-2 表示 Subchunk Polling 模式
  client.on('level_chunk', pk => {
    try {
      const key = pk.x + ',' + pk.z
      world.chunks.set(key, { x: pk.x, z: pk.z, dimension: pk.dimension, highest: pk.highest_subchunk_count, raw: pk.payload })
      LOG('[newbed] level_chunk ' + key + ' sc=' + pk.sub_chunk_count + ' highest=' + pk.highest_subchunk_count)
      // Subchunk Polling：发 sub_chunk_request 请求真实方块数据
      // proto.yml 的字段顺序(dimension→origin→requests)和 BDS 实际顺序(dimension→offsets→position)反了
      // 绕过库的序列化，直接构造原始字节
      if (pk.sub_chunk_count < 0) {
        const chunkX = pk.x, chunkZ = pk.z
        const position = { x: chunkX, y: 0, z: chunkZ }  // SubChunkPos: chunkX, subChunkIndex(0), chunkZ
        const offsets = []
        const h = pk.highest_subchunk_count || 10
        for (let dy = 0; dy <= h; dy++) offsets.push({ dx: 0, dy, dz: 0 })
        try {
          const payload = buildSubChunkRequest(pk.dimension || 0, position, offsets)
          // 包格式: varint(packet_id) + payload。sub_chunk_request = 0xaf
          const header = []
          let id = 0xaf
          while (true) { if ((id & ~0x7f) === 0) { header.push(id & 0xff); break } header.push((id & 0x7f) | 0x80); id >>>= 7 }
          const fullBuf = Buffer.concat([Buffer.from(header), payload])
          // 通过库的 sendBuffer 直接发原始字节
          if (client.sendBuffer) {
            client.sendBuffer(fullBuf)
            LOG('[newbed] sub_chunk_request(hack) chunk=' + chunkX + ',' + chunkZ + ' offsets=' + offsets.length)
          } else {
            // fallback: 用库的 queue（字段顺序错，但试试）
            client.queue('sub_chunk_request', { dimension: pk.dimension || 0, origin: position, requests: offsets })
            LOG('[newbed] sub_chunk_request(fallback) chunk=' + chunkX + ',' + chunkZ)
          }
        } catch (e) { LOG('[subchunk_req ERR] ' + e.message) }
      }
      emit('chunk', pk)
    } catch (e) { LOG('[chunk] ' + e.message) }
  })

  // subchunk（0xae）：真实方块数据
  client.on('subchunk', pk => {
    try {
      const entries = pk.entries || []
      LOG('[newbed] subchunk received: origin=' + JSON.stringify(pk.origin) + ' entries=' + entries.length)
      for (const ent of entries) {
        if (ent.result === 1 || ent.result === 6) { // success or success_all_air
          const scKey = (pk.origin.x + (ent.dx||0)) + ',' + (ent.dy||0) + ',' + (pk.origin.z + (ent.dz||0))
          world.subChunks.set(scKey, { payload: ent.payload, result: ent.result, origin: pk.origin, dx: ent.dx, dy: ent.dy, dz: ent.dz })
        }
      }
      emit('subchunk', pk)
    } catch (e) { LOG('[subchunk] ' + e.message) }
  })

  client.on('chunk_radius_update', pk => { try { world.chunkRadius = pk.chunk_radius } catch {} })

  // 方块变更回包：确认放/挖是否被服务端接受
  client.on('update_block', pk => {
    try { emit('blockUpdate', pk) } catch {}
  })

  // 服务端权威移动：部分服务端要求持续发 player_auth_input。
  // 但 1.20.61 实测：发了会被服务端以 disconnectionScreen.unexpectedPacket 踢掉 → 默认关闭，按需开启。
  let authTimer = null
  const startAuthInput = () => {
    if (authTimer || o.authInput !== true) return
    const iv = Number(o.authInputIntervalMs) || 50
    authTimer = setInterval(() => {
      if (!world.online) return
      try {
        client.queue('player_auth_input', {
          pitch: 0, yaw: world.self.yaw || 0,
          position: { x: world.self.x, y: world.self.y, z: world.self.z },
          move_vector: { x: 0, z: 0 }, head_yaw: world.self.yaw || 0,
          input_data: 0, input_mode: 0, play_mode: 0, interaction_model: 0,
          analogue_move_vector: { x: 0, z: 0 },
          tick: BigInt(Math.floor(Date.now() / 50) & 0x1fffffffffffff),
          delta: { x: 0, y: 0, z: 0 },
        })
      } catch (e) { /* 忽略 */ }
    }, iv)
    LOG('[newbed] player_auth_input 心跳已启动')
  }

  // 背包内容：拿到服务端认可的真实物品（含 network_id / stack_id / block_runtime_id）
  client.on('inventory_content', pk => {
    try {
      world.inventory = pk
      // 找出第一个可放置的方块物品，作为放方块默认手持
      const items = pk.input || pk.contents || []
      for (const it of items) {
        if (it && it.network_id && it.count > 0) {
          world.heldItem = { network_id: it.network_id, count: it.count, metadata: it.metadata || 0,
            has_stack_id: it.has_stack_id ?? 0, stack_id: it.stack_id, block_runtime_id: it.block_runtime_id }
          break
        }
      }
      emit('inventory', pk)
    } catch {}
  })
  client.on('container_set_slot', pk => { try { emit('slot', pk) } catch {} })

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
    // 执行游戏内命令（1.20.61 用 command_request 包，不是聊天框）
    runCommand (cmd) {
      try {
        const c = cmd.startsWith('/') ? cmd.slice(1) : cmd
        client.queue('command_request', {
          command: c,
          origin: { type: 'player', uuid: '', request_id: '' },
          internal: false,
          version: 52,
        })
        return { ok: true, sent: c }
      } catch (e) { LOG('[cmd] ' + e.message); return { ok: false, error: e.message } }
    },
    // 挖方块（1.20.61 player_action 破坏序列：start_break → crack_break 进度 → stop_break）
    digBlock (pos, opts = {}) {
      try {
        const rid = world.self.eid || 0
        const p = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }
        const face = opts.face == null ? 0 : opts.face
        const action = (a, extra) => client.queue('player_action', {
          runtime_entity_id: rid, action: a, position: p,
          result_position: { x: p.x, y: p.y, z: p.z }, face, ...(extra || {}),
        })
        action('start_break')
        // 服务端权威破坏：需要持续上报进度（crack_break 带进度）
        const total = opts.progress || 1
        let step = 0
        const iv = setInterval(() => {
          step++
          try { action('crack_break', { block_runtime_id: opts.blockRuntimeId || 0 }) } catch {}
          if (step >= total) { clearInterval(iv); try { action('stop_break') } catch {} }
        }, opts.intervalMs || 60)
        timers.push(iv)
        return { ok: true, pos: p }
      } catch (e) { LOG('[dig] ' + e.message); return { ok: false, error: e.message } }
    },
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
    // 放方块（1.20.61 inventory_transaction item_use click_block，实测序列）
    // name: stone/dirt/oak_planks...; clicked: 被点击的方块坐标; face: 面(1=+Y顶面)
    placeBlock (name = 'stone', clicked = null, face = 1) {
      try {
        const MAT = {
          stone: { net: 1, br: 1780 }, dirt: { net: 3, br: 9568 }, oak_planks: { net: 5, br: 181 },
          cobblestone: { net: 4, br: 201 }, sand: { net: 12, br: 261 }, glass: { net: 20, br: 497 },
          grass_block: { net: 2, br: 257 }, bedrock: { net: 7, br: 2013 }, gold_block: { net: 41, br: 328 },
          iron_block: { net: 42, br: 329 }, diamond_block: { net: 57, br: 354 },
        }
        const m = MAT[name] || MAT.stone
        const c = clicked || { x: Math.floor(world.self.x), y: Math.floor(world.self.y) - 1, z: Math.floor(world.self.z) }
        const rid = world.self.eid || 0
        // 服务端权威背包：优先用服务端下发的真实物品（含 stack_id），否则用本地构造
        let held = world.heldItem
        if (!held || held.network_id !== m.net) {
          held = { network_id: m.net, count: 1, metadata: 0, has_stack_id: 0, block_runtime_id: m.br }
        }
        client.queue('player_action', { runtime_entity_id: rid, action: 'start_item_use_on',
          position: c, result_position: { x: c.x, y: c.y + 1, z: c.z }, face })
        client.queue('inventory_transaction', { transaction: {
          legacy: { legacy_request_id: 0 }, transaction_type: 'item_use', actions: [],
          transaction_data: {
            action_type: 'click_block', block_position: c, face, hotbar_slot: 0, held_item: held,
            player_pos: { x: c.x + 0.5, y: c.y + 1.63, z: c.z + 0.5 },
            click_pos: { x: 0.5, y: 1, z: 0.5 }, block_runtime_id: m.br,
          },
        } })
        setTimeout(() => { try { client.queue('player_action', { runtime_entity_id: rid, action: 'stop_item_use_on', position: {x:0,y:0,z:0}, result_position: {x:0,y:0,z:0}, face: 0 }) } catch {} }, 150)
        return { ok: true, name, clicked: c, held }
      } catch (e) { LOG('[place] ' + e.message); return { ok: false, error: e.message } }
    },
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
