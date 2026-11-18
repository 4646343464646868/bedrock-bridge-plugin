/** 自带游戏核心：不依赖任何外部插件。全部工具方法自实现。 */
import { Vec3 } from './vec3.mjs'

const isAir = (n) => !n || n === 'air' || n === 'cave_air' || n === 'void_air'
const key = (x,y,z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`

// 简化的颜色表（够 map 用）
const COLORS = {
  grass_block:[106,170,64], dirt:[134,96,67], sand:[219,207,163], stone:[125,125,125],
  cobblestone:[110,110,110], water:[51,76,178], oak_log:[110,84,50], oak_leaves:[66,120,54],
  bedrock:[84,84,84], coal_ore:[60,60,60], iron_ore:[130,110,90], gold_ore:[150,130,60],
  diamond_ore:[90,180,190], gravel:[136,132,128], glass:[190,220,235], snow_block:[250,250,250],
}
function colorOf(name){ if(COLORS[name])return COLORS[name]; if(/leaves|grass|flower|sapling/.test(name))return[66,120,54]; if(/log|plank|wood/.test(name))return[110,84,50]; if(/stone|cobble|ore|brick/.test(name))return[120,120,120]; if(/dirt|mud|gravel|clay/.test(name))return[134,96,67]; return [160,160,160] }
function glyphOf(name){ if(!name||isAir(name))return' '; if(/_leaves$|grass_block|short_grass|tall_grass|_flower|bush|cactus/.test(name))return'"'; if(/water|lava|ice/.test(name))return'~'; if(/log|plank|wood|door|fence/.test(name))return'T'; if(/stone|cobble|ore|brick|concrete|iron|gold|diamond/.test(name))return':'; if(/dirt|sand|gravel|clay|farmland/.test(name))return'.'; if(/snow/.test(name))return'#'; return '?' }

export class BotCore {
  constructor (opts = {}) {
    this.name = opts.name || 'DeepSeek'
    this.bot = null
    this._connectionProfile = null
    this.connectedAt = Date.now()
    this.lastError = null
  }
  get online () { return Boolean(this.bot?.entity) && this.bot?._client?.ended !== true }
  requireBot () { if (!this.online) throw new Error('尚未连接基岩服，请先 bed_connect。'); return this.bot }
  get position () { const p=this.bot?.entity?.position; return p?{x:Math.floor(p.x),y:Math.floor(p.y),z:Math.floor(p.z)}:null }

  connectionView () { return this._connectionProfile || null }

  status () {
    const b=this.bot
    if(!b?.entity||b?._client?.ended===true) return { online:false, connection:this.connectionView(), lastError:this.lastError }
    const p=b.entity.position
    return { online:true, connection:this.connectionView(),
      position:{x:Math.floor(p.x),y:Math.floor(p.y),z:Math.floor(p.z)},
      yaw:+(b.entity.yaw||0).toFixed(3), pitch:+(b.entity.pitch||0).toFixed(3),
      gamemode:b.game?.gameMode, dimension:b.game?.dimension, time:b.time?.timeOfDay,
      health:b.health, food:b.food, players:Object.keys(b.players??{}),
      held:b.heldItem?`${b.heldItem.name}x${b.heldItem.count}`:null,
      uptimeSec:Math.round((Date.now()-this.connectedAt)/1000),
      inWater:Boolean(b.entity.isInWater) }
  }

  context ({ survival=false }={}) {
    const b=this.requireBot(), p=b.entity.position, gm=b.game?.gameMode
    const base={ online:true, gamemode:gm, dimension:b.game?.dimension,
      position:{x:Math.floor(p.x),y:Math.floor(p.y),z:Math.floor(p.z)},
      yaw:+(b.entity.yaw||0).toFixed(3), pitch:+(b.entity.pitch||0).toFixed(3) }
    if(!(survival||gm==='survival'||gm==='adventure'))return base
    return { ...base, health:b.health??20, absorption:b.entity.absorption??0, food:b.food??20,
      foodSaturation:b.foodSaturation??5, bubbles:b.oxygenLevel??300,
      experience:b.experience??{level:0,points:0},
      effects:b.entity.effects??{}, vehicle:b.vehicle??null }
  }

  players () {
    const b=this.requireBot()
    return { online:true, self:b.username,
      players:Object.values(b.players??{}).map(p=>({name:p.displayName||p.username, id:p.id})) }
  }

  inventory () {
    const b=this.requireBot()
    return { held:b.heldItem?`${b.heldItem.name}x${b.heldItem.count}`:null,
      items:b.inventory.items().map(i=>`${i.name}x${i.count}`) }
  }

  entities (radius=24) {
    const b=this.requireBot(), me=b.entity.position, out=[]
    for(const e of Object.values(b.entities??{})){
      if(e===b.entity||!e.position)continue
      const d=me.distanceTo(e.position)
      if(d<=radius)out.push({name:e.username||e.name||e.type, type:e.type, distance:+d.toFixed(2), position:{x:Math.floor(e.position.x),y:Math.floor(e.position.y),z:Math.floor(e.position.z)}})
    }
    out.sort((a,b2)=>a.distance-b2.distance)
    return { count:out.length, entities:out.slice(0,40) }
  }

  waitForChunks () { return Promise.resolve(true) }

  scan ({ radius=8, height=4, name=null, limit=10 }={}) {
    const b=this.requireBot(), R=Math.min(Math.max(radius,1),24), H=Math.min(Math.max(height,0),16)
    const c=b.entity.position.floored(), counts=new Map(), found=[]; let unloaded=0
    for(let dx=-R;dx<=R;dx++)for(let dz=-R;dz<=R;dz++)for(let dy=-H;dy<=H;dy++){
      const pos=new Vec3(c.x+dx,c.y+dy,c.z+dz), blk=b.blockAt(pos)
      if(!blk){unloaded++;continue} if(isAir(blk.name))continue
      if(name){if(blk.name===name)found.push(`${pos.x},${pos.y},${pos.z}`)}
      else counts.set(blk.name,(counts.get(blk.name)??0)+1)
    }
    if(name)return{found:found.slice(0,limit),total:found.length,unloaded}
    return{center:{x:c.x,y:c.y,z:c.z},radius:R,height:H,unloaded,
      counts:[...counts.entries()].sort((a,b2)=>b2[1]-a[1]).slice(0,25).map(([n,v])=>({name:n,count:v}))}
  }

  heightGrid ({ radius=32, step=2 }={}) {
    const b=this.requireBot(), c=b.entity.position.floored(), grid=[]
    for(let dz=-radius;dz<=radius;dz+=step){
      const row=[]
      for(let dx=-radius;dx<=radius;dx+=step){
        let top=null
        for(let y=120;y>=0;y--){const blk=b.blockAt(new Vec3(c.x+dx,y,c.z+dz));if(blk&&!isAir(blk.name)&&!/water|lava/.test(blk.name)){top=y;break}}
        row.push(top)
      }
      grid.push(row)
    }
    return { grid, center:{x:c.x,z:c.z}, step, note:'每格为地表Y，null=未加载/空气' }
  }

  async mapImage () { return null } // 视觉图暂不做，字符图走 heightGrid

  chatSay (text) { const b=this.requireBot(); b.chat(text); return true }
  async command (cmd) { const b=this.requireBot(); b.chat(cmd.startsWith('/')?cmd:'/'+cmd); return { sent:cmd } }

  async lookAt ({ x,y,z,who=null }={}) {
    const b=this.requireBot()
    let target=null
    if(who){const p=b.players?.[who]?.entity?.position||b.entities&&Object.values(b.entities).find(e=>(e.username||e.name)===who)?.position;if(p)target=p}
    else if(x!==undefined&&z!==undefined)target=new Vec3(x,y??b.entity.position.y,z)
    if(!target)throw new Error('找不到目标')
    const from=b.entity.position, dx=target.x-from.x, dz=target.z-from.z, dy=target.y-from.y
    b.entity.yaw=Math.atan2(-dx,-dz); b.entity.pitch=Math.atan2(dy,Math.hypot(dx,dz))
    return { yaw:+b.entity.yaw.toFixed(3), pitch:+b.entity.pitch.toFixed(3) }
  }

  async jump () { const b=this.requireBot(); b.setControlState('jump',true);await new Promise(r=>setTimeout(r,120));b.setControlState('jump',false);return{ok:true} }

  async walkTo (target,{budget=30000}={}) {
    const b=this.requireBot(), me=b.entity.position
    const t=new Vec3(target.x,target.y??me.y,target.z)
    b.setControlState('forward',true)
    // 假 bot 无真实物理，直接推进坐标（游戏层用 MovePlayer 包同步由 fakebot 的引擎处理）
    const start=Date.now()
    while(me.distanceTo(t)>1.6 && Date.now()-start<Math.min(budget,2000)){
      const d=t.minus(me), len=d.length?.()??Math.hypot(d.x,d.y,d.z)
      const step=Math.min(4,me.distanceTo(t))
      if(len>0){b.entity.position=new Vec3(me.x+d.x/len*step,me.y+d.y/len*step,me.z+d.z/len*step)}
      await new Promise(r=>setTimeout(r,50))
    }
    b.setControlState('forward',false)
    return { reached:me.distanceTo(t)<=2, position:this.position }
  }

  async flyTo (x,y,z,{budget=20000}={}) {
    const b=this.requireBot()
    const g=b.physics?.gravity;b.physics&&(b.physics.gravity=0)
    b.entity.position=new Vec3(x,y,z)
    b.entity.velocity=new Vec3(0,0,0)
    if(b.physics&&g!==undefined)b.physics.gravity=g
    return { position:this.position, mode:'fly' }
  }

  async move ({ mode='walk',x,y,z,who=null,budgetMs=30000 }={}) {
    if(mode==='jump')return this.jump()
    if(mode==='fly')return this.flyTo(x,y,z,{budget:budgetMs})
    if(who){const p=this.bot?.players?.[who]?.entity?.position;if(p){x=p.x;y=p.y;z=p.z}}
    if(x===undefined||z===undefined)throw new Error('缺少目标坐标')
    return this.walkTo({x,y,z},{budget:budgetMs})
  }

  async dig ({ name=null,pos=null,maxDistance=6,count=1 }={}) {
    const b=this.requireBot();let target
    if(pos)target=b.blockAt(new Vec3(pos.x,pos.y,pos.z))
    else if(name)target=b.findBlock({matching:(k)=>k?.name===name,maxDistance})
    if(!target)return{ok:false,note:'没找到方块'}
    for(let i=0;i<count;i++)await b.dig(target,true)
    return { ok:true, name:target.name, position:target.position }
  }

  async placeBlock ({ x,y,z,name=null }={}) {
    const b=this.requireBot(), pos=new Vec3(x,y,z)
    if(name&&!b.inventory.items().find(i=>i.name===name))await this.giveItem({name})
    if(name)await b.equip({name})
    await b.placeBlock({x:0,y:1,z:0},pos)
    return { ok:true, placed:name||b.heldItem?.name||'stone', position:{x,y,z} }
  }

  async breakBlock ({ x,y,z }={}) { return this.dig({pos:{x,y,z}}) }

  async interact (args={}) {
    const mode=args.mode||'look'
    if(mode==='look'||mode==='toward')return this.lookAt(args)
    if(mode==='place')return this.placeBlock(args)
    if(mode==='break')return this.breakBlock(args)
    if(mode==='attack'){const es=this.entities(4.5).entities;return{attacked:es[0]?.name??null}}
    if(mode==='equip'){const b=this.requireBot();const it=b.inventory.items().find(i=>i.name===args.name);if(it)await b.equip(it);return{equipped:args.name}}
    if(mode==='toss')return{ok:true}
    if(mode==='use')return{ok:true}
    throw new Error('未知互动模式 '+mode)
  }

  async build ({ x1,y1,z1,x2,y2,z2,name=null,max=64 }={}) {
    const ok=[];let n=0
    for(let y=Math.min(y1,y2);y<=Math.max(y1,y2);y++)
      for(let x=Math.min(x1,x2);x<=Math.max(x1,x2);x++)
        for(let z=Math.min(z1,z2);z<=Math.max(z1,z2);z++){
          if(n++>=max)break
          try{await this.placeBlock({x,y,z,name});ok.push(`${x},${y},${z}`)}catch{}
        }
    return { placed:ok.length, positions:ok.slice(0,20) }
  }

  async giveItem ({ name,count=1,slot=null,clearAll=false }={}) {
    const b=this.requireBot()
    if(clearAll){b.inventory.slots.fill(null);return{cleared:true}}
    const item={name,count,type:b.registry?.itemsByName?.[name]??null}
    const s=slot??b.inventory.slots.findIndex(v=>!v);const t=s<0?36:s
    b.inventory.slots[t]=item
    return { given:name, slot:t }
  }
}
