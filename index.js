/**
 * bedrock-bridge —— 让 DSH 用整套工具玩 MCPE 0.14 基岩服。
 * 自带游戏核心（BotCore）+ 假 mineflayer bot，完全独立，不依赖任何其它插件
 * （数据来自裸 UDP 基岩引擎 engine2 + chunk 解析）。游戏层控制，不碰控制台。
 */
import { defineTool } from './lib/tool-def.mjs'
import { connectBedrock } from './lib/engine2.mjs'
import { connectBedrockNew } from './lib/engineBedrockNew.mjs'
import { probeBedrock } from './lib/probeBedrock.mjs'
import * as chunkLib from './lib/chunk.mjs'
import * as nbtLib from './lib/nbt.mjs'
import { makeFakeBot } from './lib/fakebot.mjs'
import { BotCore } from './lib/botcore.mjs'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const __dir = dirname(fileURLToPath(import.meta.url))
const SERVERS_FILE = join(__dir, 'servers.json')
function loadServers(){try{return JSON.parse(readFileSync(SERVERS_FILE,'utf8'))}catch{return {}}}
function saveServers(o){writeFileSync(SERVERS_FILE,JSON.stringify(o,null,2))}
function resolveServer(nameOrHost, port){const servers=loadServers();const e=servers[nameOrHost];if(e)return{host:e.host,port:e.port,user:e.user,password:e.password,note:e.note};return{host:nameOrHost,port}}

export const name = 'bedrock-bridge'
export const inject = ['tools']

// ---- DSH 原生设置页 Config（volatile 字段才会出现在「设置→插件→bedrock-bridge」）----
// schemastery 是 optional peer，多路径兜底加载；拿不到就不导出 Config（避免 cordis 校验报错）。
let _z = null
for (const spec of [
  '@deepseek-ai/schemastery',
  '/opt/node-v22.23.2-linux-arm64/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/schemastery/lib/index.mjs',
]) {
  try { const m = await import(spec); _z = m.default || m; if (_z && _z.object) break } catch {}
}
export const Config = _z && _z.object ? _z.object({
  defaultServer: _z.string().default('').volatile(),
  defaultUser: _z.string().default('DeepSeek').volatile(),
  heartbeatMs: _z.number().default(15000).volatile(),
  autoRegister: _z.boolean().default(true).volatile(),
  fallbackVersion: _z.string().default('').volatile(),
}) : undefined

const outText = (render) => ({
  schema: { type:'object', properties:{}, additionalProperties:true },
  render: (a, v) => [{ type:'text', text: render ? render(a, v) : (v?.text ?? JSON.stringify(v, null, 2)) }],
})

export function apply (ctx, config = {}) {
  // 设置页配置读取（volatile 字段是引用，用 .get()；没配置时用默认）
  const cfg = (key, dflt) => {
    try { const v = config?.[key]; if (v == null) return dflt; return typeof v.get === 'function' ? v.get() : v } catch { return dflt }
  }
  const sessions = new Map() // agentId -> { mc, engine, log, msgs }

  const getS = (exec) => {
    const id = exec?.agent?.id ?? 'default'
    if (!sessions.has(id)) {
      const mc = new BotCore({ name:'DeepSeek' })
      sessions.set(id, { mc, engine:null, log:[], msgs:[] })
    }
    return sessions.get(id)
  }
  const need = (s) => {
    if (!s.engine) throw new Error('尚未连接基岩服，请先 bed_connect。')
    return s.mc
  }
  const reg = (name, description, parameters, fn) =>
    ctx.tools.register(defineTool({ name, description, parameters, output: outText(), async execute (args, exec) { return await fn(args, exec, getS(exec)) } }))

  reg('bed_connect', '连接 MCPE 0.14 基岩服（UDP），并把整套 bed_* 工具接到这个游戏角色上。给密码会自动在聊天框完成注册/登录。连上后可用 bed_status/bed_scan/bed_map/bed_say/bed_command/bed_build/bed_dig 等全套工具。host 可传服务器别名（如『我的服』『本地』『简版』），会自动用记住的地址/端口/账号/密码；也可直接传地址。Master 说『连我的服』这类自然语言时，用别名连接。',
    { host:{type:'string',required:true,description:'服务器地址或别名（我的服/本地/简版）'}, port:{type:'number',description:'端口，默认19132'}, user:{type:'string',description:'游戏名，默认DeepSeek'}, password:{type:'string',description:'注册/登录密码'}, register:{type:'boolean',description:'自动注册，默认true'}, gamemode:{type:'string',description:'creative/survival，默认survival'} },
    async (a, exec, s) => {
      if (s.engine) s.engine.close()
      const r = resolveServer(a.host, Number(a.port))
      const host = r.host, port = Number(a.port)||r.port||19132
      const user = a.user||r.user||cfg('defaultUser','DeepSeek'), password = a.password||r.password||null
      s.log = []; s.msgs = []
      const engine = await connectBedrock({
        host, port, user, password, register: a.register !== undefined ? a.register : cfg('autoRegister',true),
        log:m=>{s.log.push(String(m))}, onMessage:m=>{s.msgs.push(m)},
        holdMs: Math.max(60000, cfg('heartbeatMs',15000) * 120),
      }, chunkLib, nbtLib)
      const { fake } = makeFakeBot(engine, { user, gamemode:a.gamemode })
      s.mc.bot = fake
      s.mc._connectionProfile = { host, port, version:'0.14.0', authMode:'offline', account:user }
      s.mc.autoReconnect = false
      s.engine = engine
      await engine.wait(6500)
      return { ok:true, online:s.mc.online, host, port, user, self:engine.getSelf(), players:engine.getPlayers().length, log:s.log.slice(-12), messages:s.msgs.slice(-8) }
    })

  // ===== 高版本基岩服（1.16+）连接，带 1614 亲定的进服规则 =====
  reg('bed_ping_new', '探测基岩服：用裸 RakNet ping 拿版本/协议号/MOTD/人数，并按协议号自动匹配库版本。不依赖 native binding，不进服。',
    { host:{type:'string',required:true}, port:{type:'number'} },
    async (a) => await probeBedrock(a.host, Number(a.port)||19132, 5000))

  reg('bed_connect_new', '连接高版本基岩服（1.16+ / 协议>=400），走 bedrock-protocol。账号由用户自己填；进服前检测正版/离线，正版服未登录官方账号则退出并提示。',
    { host:{type:'string',required:true}, port:{type:'number'}, user:{type:'string',description:'游戏名，用户自己填'}, version:{type:'string',description:'如 1.20.40，不填自动探测'}, official:{type:'boolean',description:'是否已登录官方/Xbox 账号；正版服需要'} },
    async (a, exec, s) => {
      // 账号一律用户自己填，不猜
      const user = a.user
      if (!user) return { ok:false, needAccount:true, prompt:'请提供你的游戏账号名（账号由你自己填）。' }
      const host = a.host, port = Number(a.port)||19132

      // 进服规则：正版服 + 没登录官方账号 → 直接退出并原话提示
      // 判定：用户声明 official=true 视为已登录官方账号；否则若服务器被探为正版 → 退出
      s.log = []; s.msgs = []
      // 判定：用户声明 official=true 走官方账号；否则先按离线连。
      // 连接若因"需要 Xbox/官方认证"失败，视为正版服 → 按规则退出提示。
      const wantOfficial = !!a.official
      if (s.engine) { try { s.engine.close() } catch {} }
      let engine
      try {
        engine = await connectBedrockNew({
          host, port, user, version:a.version||null, offline:!wantOfficial,
          log:m=>{ (s.log||(s.log=[])).push(String(m)) }, onMessage:m=>{ (s.msgs||(s.msgs=[])).push(m) },
        })
      } catch(e) {
        const msg = String(e?.message||e)
        if (/ONLINE_MODE_REQUIRED|xbox|auth|premium|正版|microsoft|login required|认证/i.test(msg)) {
          const prompt = '您暂未登录您的账号，该服务器为正版服务器，需要官方账号，请补充。'
          return { ok:false, serverAuth:'online', needOfficialAccount:true, prompt, detail:msg }
        }
        return { ok:false, error:msg }
      }
      const auth = wantOfficial ? 'official' : 'offline'
      const { fake } = makeFakeBot(engine, { user, gamemode:'survival' })
      s.mc.bot = fake
      s.mc._connectionProfile = { host, port, version:'bedrock-new', authMode:(a.official?'official':'offline'), account:user }
      s.mc.autoReconnect = false
      s.engine = engine
      return { ok:true, online:s.mc.online, host, port, user, serverAuth:auth, self:engine.getSelf(),
        log:(s.log||[]).slice(-12), messages:(s.msgs||[]).slice(-8) }
    })

  reg('bed_status','查看当前基岩角色状态：是否在线、坐标、朝向、服务器、血量、背包等。', {},
    async (a,e,s)=>({ ...need(s).status(), log:s.log.slice(-5) }))

  reg('bed_context','查看角色上下文（含生存数据）。参数 survival:true 强制返回生存段。',
    { survival:{type:'boolean',description:'强制返回生存数据'} },
    async (a,e,s)=>need(s).context({survival:!!a.survival}))

  reg('bed_players','列出服务器里的在线玩家。', {},
    async (a,e,s)=>need(s).players())

  reg('bed_inventory','查看背包与手持物品。', {},
    async (a,e,s)=>need(s).inventory())

  reg('bed_entities','列出附近的实体（玩家/生物）及距离。',
    { radius:{type:'number',description:'半径，默认24'} },
    async (a,e,s)=>need(s).entities(Number(a.radius)||24))

  reg('bed_scan','扫描周围方块：给 name 找这种方块的位置；不给返回统计。',
    { radius:{type:'number',description:'水平半径默认8'}, height:{type:'number',description:'垂直范围±默认4'}, name:{type:'string',description:'方块名'}, limit:{type:'number'} },
    async (a,e,s)=>need(s).scan({radius:Number(a.radius)||8,height:Number(a.height)||4,name:a.name||null,limit:Number(a.limit)||10}))

  reg('bed_map','看周围地形，chars 字符图（无视觉也能读）或 image 真彩图。',
    { radius:{type:'number',description:'半径默认32'}, format:{type:'string',description:'chars/image'}, glyphStep:{type:'number'}, scale:{type:'number'} },
    async (a,e,s)=>{
      const mc=need(s)
      if(a.format==='image'){
        const buf=await mc.mapImage({radius:Number(a.radius)||32,scale:Number(a.scale)||4})
        // buf 可能是 {png} 或 Buffer，交给 asTool 无损化
        return { image: buf?.png ? buf.png.toString('base64') : (Buffer.isBuffer(buf)?buf.toString('base64'):null), note:'base64 PNG' }
      }
      return { map: mc.heightGrid({radius:Number(a.radius)||32}) }
    })

  reg('bed_height','高度图：每列地表 Y。format chars/full。',
    { radius:{type:'number'}, step:{type:'number'}, format:{type:'string'} },
    async (a,e,s)=>({ grid: need(s).heightGrid({radius:Number(a.radius)||32,step:Number(a.step)||2}) }))

  reg('bed_say','在服务器聊天框发消息（游戏内所有玩家可见）。',
    { message:{type:'string',required:true,description:'要发送的消息'} },
    async (a,e,s)=>{ need(s).chatSay(a.message); return { ok:true, sent:a.message } })

  reg('bed_command','以玩家身份执行服务器游戏内命令（如 /time set day、/give、/tp、/gamemode 等）。这是游戏层管理服务器的方式，需账号有对应权限。',
    { command:{type:'string',required:true,description:'以 / 开头的完整命令'} },
    async (a,e,s)=>{ const r=await need(s).command(a.command); return { ok:true, command:a.command, result:r??null } })

  reg('bed_move','移动：mode walk 走过去 / fly 创造飞行 / jump 原地跳。',
    { mode:{type:'string',description:'walk/fly/jump'}, x:{type:'number'}, y:{type:'number'}, z:{type:'number'}, budgetMs:{type:'number'} },
    async (a,e,s)=>{
      const mc=need(s)
      if(a.mode==='jump') return await mc.jump()
      if(a.mode==='fly') return await mc.flyTo(a.x,a.y,a.z,{budget:Number(a.budgetMs)||20000})
      return await mc.walkTo({x:a.x,y:a.y,z:a.z},{budget:Number(a.budgetMs)||30000})
    })

  reg('bed_look','看向坐标或玩家。',
    { x:{type:'number'}, y:{type:'number'}, z:{type:'number'}, who:{type:'string'} },
    async (a,e,s)=>{ const mc=need(s); return await mc.interact({mode:'look',x:a.x,y:a.y,z:a.z,who:a.who}) })

  reg('bed_act','与实体/方块互动：place 放方块 / break 挖方块 / use 使用 / attack 攻击 / equip 持物 / toss 丢弃。',
    { mode:{type:'string',required:true,description:'look/toward/place/break/use/attack/equip/toss'}, x:{type:'number'},y:{type:'number'},z:{type:'number'},who:{type:'string'},name:{type:'string'},count:{type:'number'} },
    async (a,e,s)=>await need(s).interact(a))

  reg('bed_build','批量搭方块：把 (x1,y1,z1)-(x2,y2,z2) 实心长方体用 name 搭出来。',
    { x1:{type:'number',required:true},y1:{type:'number',required:true},z1:{type:'number',required:true},x2:{type:'number',required:true},y2:{type:'number',required:true},z2:{type:'number',required:true},name:{type:'string'},max:{type:'number'} },
    async (a,e,s)=>await need(s).build(a))

  reg('bed_dig','挖方块：给 name 挖最近的，或给坐标挖指定位置。',
    { name:{type:'string'},x:{type:'number'},y:{type:'number'},z:{type:'number'},maxDistance:{type:'number'},count:{type:'number'} },
    async (a,e,s)=>{
      const args={name:a.name||null,maxDistance:Number(a.maxDistance)||6,count:Number(a.count)||1}
      if(a.x!==undefined&&a.y!==undefined&&a.z!==undefined)args.pos={x:a.x,y:a.y,z:a.z}
      return await need(s).dig(args)
    })

  reg('bed_give','创造模式获取物品（协议级塞槽位，非 /give 指令）。',
    { name:{type:'string',required:true},count:{type:'number'},slot:{type:'number'},clearAll:{type:'boolean'} },
    async (a,e,s)=>await need(s).giveItem({name:a.name,count:Number(a.count)||1,slot:a.slot,clearAll:!!a.clearAll}))

  reg('bed_log','查看基岩客户端收到的服务器消息与日志。',
    {},
    async (a,e,s)=>({ log:[...s.log,...s.msgs.map(m=>'[MSG] '+m)].slice(-60) }))

  reg('bed_disconnect','退出当前基岩服。', {},
    async (a,e,s)=>{ if(s.engine){s.engine.close();s.engine=null;s.mc.bot=null} return { ok:true } })

  reg('bed_blockentity','查看服务器里的方块实体内容：木牌文字、箱子物品。需在附近（服务端会随区块发来）。不传坐标则返回所有已发现的方块实体。',
    { x:{type:'number'}, y:{type:'number'}, z:{type:'number'} },
    async (a,e,s)=>{ const en=s.engine; if(!en)throw new Error('尚未连接基岩服'); if(a.x!==undefined&&a.y!==undefined&&a.z!==undefined)return{ok:true,entity:en.getBlockEntity(a.x,a.y,a.z)}; return{ok:true,entities:en.getBlockEntities()} })

  reg('bed_server','管理自定义基岩服务器（别名→地址/端口/账号/密码）。以后说『连我的服』就用别名直连，不用报参数。',
    { action:{type:'string',required:true,description:'list列出 / add添加 / remove删除'}, alias:{type:'string',description:'服务器别名'}, host:{type:'string'}, port:{type:'number'}, user:{type:'string'}, password:{type:'string'} },
    async (a)=>{
      const servers=loadServers()
      if(a.action==='list')return{ok:true,servers}
      if(a.action==='add'){if(!a.alias||!a.host)throw new Error('add 需要 alias 和 host');servers[a.alias]={host:a.host,port:Number(a.port)||19132,user:a.user||'DeepSeek',password:a.password||null};saveServers(servers);return{ok:true,added:a.alias,servers}}
      if(a.action==='remove'){if(!a.alias)throw new Error('remove 需要 alias');delete servers[a.alias];saveServers(servers);return{ok:true,removed:a.alias}}
      throw new Error('未知 action: '+a.action)
    })

  ctx.effect(() => () => { for (const s of sessions.values()) if (s.engine) s.engine.close() }, 'bedrock-bridge: cleanup')
}
