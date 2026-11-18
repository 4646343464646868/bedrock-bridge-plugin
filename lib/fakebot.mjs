/**
 * 把 engine2 的基岩连接包装成 mineflayer bot 接口，塞进自带 BotCore，让全套工具驱动基岩角色。
 * 实现 MINEFLAYSURFACE.md §3 A 档全部必须项 + 世界状态闭环（blockAt/place/dig）。
 */
import { Vec3 } from './vec3.mjs'
import { javaName, idByName } from './blockmap.mjs'

const key = (x,y,z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`

export function makeFakeBot(engine, opts = {}) {
  const nameCache = new Map()         // id -> javaName（最多256项，省内存）
  const edits = new Map()             // 玩家放/挖的增量 "x,y,z"->name（少量）
  const cname = (id,data) => { const k=(id<<4)|(data&15); let n=nameCache.get(k); if(n===undefined){n=javaName(id,data);nameCache.set(k,n)} return n }
  const self = engine.getSelf()
  const gamemode = opts.gamemode === 'creative' ? 'creative' : 'survival'

  const fake = {
    username: opts.user || self.name || 'DeepSeek',
    version: '1.14.0',
    game: { gameMode: gamemode, dimension: 0, minY: 0, height: 128, minecraftVersion: '0.14.0' },
    time: { timeOfDay: 6000, bigTime: 6000 },
    health: 20, food: 20, foodSaturation: 5, oxygenLevel: 300,
    experience: { level: 0, points: 0, total: 0 },
    heldItem: null,
    quickBarSlot: 0,
    controlState: {},
    physics: { gravity: 0.08 },
    players: {},
    entities: {},

    entity: {
      position: new Vec3(self.x||0, self.y||64, self.z||0),
      yaw: 0, pitch: 0, velocity: new Vec3(0,0,0),
      onGround: true, isInWater: false, isInLava: false,
      absorption: 0, effects: {}, passengers: [],
    },

    inventory: {
      slots: new Array(45).fill(null),
      items () { return this.slots.filter(Boolean) },
    },

    registry: {
      itemsByName: {
        stone:{id:1,stackSize:64}, dirt:{id:3,stackSize:64}, oak_planks:{id:5,stackSize:64},
        cobblestone:{id:4,stackSize:64}, sand:{id:12,stackSize:64}, grass_block:{id:2,stackSize:64},
        oak_log:{id:17,stackSize:64}, glass:{id:20,stackSize:64}, torch:{id:50,stackSize:64},
      },
      items: {},
    },

    creative: {
      startFlying () {}, stopFlying () {},
      async setInventorySlot (slot, item) { fake.inventory.slots[slot] = item ? {name:item.name,count:item.count,type:item.type||fake.registry.itemsByName[item.name]} : null },
      async clearInventory () { fake.inventory.slots.fill(null) },
    },

    // ---- 世界读取 ----
    blockAt (pos) {
      if (!pos || !Number.isFinite(pos.x)) return null
      const k = key(pos.x, pos.y, pos.z)
      if (edits.has(k)) { const n=edits.get(k); return { name:n, boundingBox:n==='air'?'empty':'block', position:new Vec3(pos.x,pos.y,pos.z) } }
      const blk = engine.getBlock(pos.x, pos.y, pos.z)  // 查引擎的紧凑区块（含 loaded 判定）
      if (!blk) return { name:'air', boundingBox:'empty', position:new Vec3(pos.x,pos.y,pos.z) }
      const n = cname(blk.id, blk.data)
      return { name:n, boundingBox:n==='air'||n.startsWith('unknown_')?'empty':'block', position:new Vec3(pos.x,pos.y,pos.z) }
    },
    findBlock () { return null },

    // ---- 聊天 / 命令（游戏层）----
    chat (text) { engine.say(text); return true },
    setControlState (k, b) { fake.controlState[k] = b },
    getControlState (k) { return !!fake.controlState[k] },
    async lookAt (p) { if (p && Number.isFinite(p.x)) { const dx=p.x-fake.entity.position.x, dz=p.z-fake.entity.position.z; fake.entity.yaw=Math.atan2(-dx,dz); } },

    // ---- 动作（游戏层发包 + 本地世界回写闭环）----
    async dig (block) {
      if (!block) return
      const p = block.position || block
      engine.startBreak(p.x,p.y,p.z); await engine.wait(250); engine.stopBreak(p.x,p.y,p.z)
      edits.set(key(p.x,p.y,p.z), 'air')
    },
    async placeBlock (ref, face) {
      const p = ref?.position || ref
      if (!p) return
      const held = fake.heldItem?.name || 'stone'
      // 真发包：名字→ID，先手持再 UseItem(0xaa)，让服务端真实放置并广播
      let id = idByName(held) ?? 1
      try {
        if (typeof engine.setHeldItem === 'function') engine.setHeldItem(id, 64, 0, 0)
        if (typeof engine.useItem === 'function') engine.useItem(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z), face==null?1:face, id, 64, 0)
      } catch (e) { /* 发包失败也保留本地回写 */ }
      edits.set(key(p.x,p.y,p.z), held)
    },
    async activateBlock () {}, async activateEntity () {}, async attack () {},
    async equip (item) { fake.heldItem = item ? { name:item.name, count:item.count??1, type:item.type } : null },
    async toss () {},
    async saveBlock () {},
    quit () { engine.close() },

    on () {}, once () {}, emit () {},
    // 掉线感知：引擎被服务端踢/超时后 ended=true，botcore.online 才会如实变 false
    _client: { get ended () { return typeof engine.isAlive === 'function' ? !engine.isAlive() : false }, end () {} },
  }

  // ---- 订阅引擎事件，实时更新世界 ----
  engine.on('move', pos => { fake.entity.position = new Vec3(pos.x,pos.y,pos.z); fake.entity.yaw=pos.yaw||0; fake.entity.pitch=pos.pitch||0 })
  engine.on('player', p => { fake.players[p.name] = { username:p.name, displayName:p.name, id:String(p.eid), entity:{ position:new Vec3(p.x,p.y,p.z) } }; fake.entities[p.eid] = { username:p.name, name:p.name, type:'player', position:new Vec3(p.x,p.y,p.z) } })
  engine.on('leave', p => { delete fake.players[p.name]; delete fake.entities[p.eid] })
  engine.on('chat', text => { fake.emit && fake.emit('message', text) })

  return { fake, edits }
}
