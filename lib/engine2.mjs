import dgram from 'node:dgram'
import zlib from 'node:zlib'
let nbtLib=null;try{nbtLib=_nbtLib}catch{}
export function connectBedrock(o={},_chunkLib=null,_nbtLib=null){
const HOST=o.host||'127.0.0.1',PORT=o.port||19132,IP=o.host||'127.0.0.1'
const USER=o.user||'DeepSeek', PASS=o.password||'ds20261116'
const LOG=o.log||(()=>{}), ONMSG=o.onMessage||(()=>{})
const ONPLAYER=o.onPlayer||(()=>{}), ONCHUNK=o.onChunk||(()=>{})
const holdMs=o.holdMs||600000
let chunkLib=null;try{chunkLib=_chunkLib}catch{}
const world={self:{eid:0,x:0,y:0,z:0,yaw:0,pitch:0,name:USER},players:new Map(),chunks:new Map(),spawn:{x:0,y:0,z:0},connected:false,spawned:false}
const splits=new Map()
const blockEntities=new Map() // "x,y,z" -> {sign:[],items:[]} // splitID -> {count,parts:[]}
let inventory={slots:[],hotbar:[]} // 服务端 ContainerSetContent 回包解析出的背包
const listeners=new Map();const emit=(ev,d)=>{const l=listeners.get(ev);if(l)l.forEach(f=>{try{f(d)}catch{}})}
const MAGIC=Buffer.from('00ffff00fefefefefdfdfdfd12345678','hex')
function u64(n){const b=Buffer.alloc(8);b.writeBigUInt64BE(BigInt(n));return b}
function u16(n){const b=Buffer.alloc(2);b.writeUInt16BE(n);return b}
function i32(n){const b=Buffer.alloc(4);b.writeInt32BE(n);return b}
function u24le(n){const b=Buffer.alloc(3);b.writeUIntLE(n,0,3);return b}
function addr(ip,port){const p=ip.split('.').map(x=>(~parseInt(x))&0xff);return Buffer.concat([Buffer.from([4]),Buffer.from(p),u16(port)])}
function str(s){const b=Buffer.from(s,'utf8');return Buffer.concat([u16(b.length),b])}
function f32(n){const b=Buffer.alloc(4);b.writeFloatBE(n);return b}
function i16be(n){const b=Buffer.alloc(2);b.writeInt16BE(n);return b}
function u16le(n){const b=Buffer.alloc(2);b.writeUInt16LE(n);return b}
// MCPE 0.14 Item slot: id(i16) + count(byte) + damage(i16) + nbtLen(u16LE) + nbt(空)
function itemSlot(id,count=1,damage=0){if(!id)return u16le(0);return Buffer.concat([i16be(id),Buffer.from([count&0xff]),i16be(damage),u16le(0)])}
// 解析 MCPE 0.14 item slot，返回 {id,count,damage} 或 null
function readItemSlot(b,o){if(o+2>b.length)return{item:null,next:o+2};const id=b.readInt16BE(o);o+=2;if(id<=0)return{item:null,next:o};const count=b[o++]||0;const damage=b.readInt16BE(o);o+=2;const nbtLen=b.readUInt16LE(o);o+=2+nbtLen;return{item:{id,count,damage},next:o}}
function readF32(b,o){return b.readFloatBE(o)}function readI32(b,o){return b.readInt32BE(o)}function readU64(b,o){return b.readBigUInt64BE(o)}
let seq=0,mi=0,askedRadius=false
function encap(p,rel=2){const f=Buffer.from([rel<<5]),l=Buffer.alloc(2);l.writeUInt16BE(p.length*8);const e=rel>=2&&rel!==5?u24le(mi++):Buffer.alloc(0);return Buffer.concat([f,l,e,p])}
function send(s,p,rel=2){s.send(Buffer.concat([Buffer.from([0x80]),u24le(seq++),encap(p,rel)]),PORT,HOST)}
function getPackets(msg){const out=[];let o=4
 while(o<msg.length){
  const f=msg[o++];const hasSplit=(f&0x10)>0;const rel=(f>>5)&7
  const len=Math.ceil((((msg[o]<<8)|msg[o+1]))/8);o+=2
  if(rel>0){if(rel>=2&&rel!==5)o+=3;if(rel<=4&&rel!==2)o+=4}
  let split=null
  if(hasSplit){const count=msg.readInt32BE(o);o+=4;const sid=msg.readUInt16BE(o);o+=2;const idx=msg.readInt32BE(o);o+=4;split={count,sid,idx}}
  const buf=msg.slice(o,o+len);o+=len
  if(split){
   let e=splits.get(split.sid);if(!e){e={count:split.count,parts:[]};splits.set(split.sid,e)}
   e.parts[split.idx]=buf
   if(e.parts.filter(Boolean).length===e.count){const full=Buffer.concat(e.parts);splits.delete(split.sid);out.push(full)}
  }else out.push(buf)
 }
 return out}
// 服务端格式: zlib( int32(len) + [0x00][pid][payload] ... )
function batch(pkts){const inner=Buffer.concat(pkts.map(p=>Buffer.concat([i32(p.length),p])));const z=zlib.deflateSync(inner);return Buffer.concat([Buffer.from([0x92]),i32(z.length),z])}
function pkt(pid,payload){return Buffer.concat([Buffer.from([0x00,pid]),payload])}
function chat(msg){return pkt(0x93,Buffer.concat([Buffer.from([0x01]),str(USER),str(msg)]))}
function login(){const skin=Buffer.alloc(8192,0);return pkt(0x8f,Buffer.concat([str(USER),i32(70),i32(70),u64(Math.floor(Math.random()*1e15)),Buffer.alloc(16,1),str(IP),str(''),str('Standard_Custom'),u16(8192),skin]))}
const s=dgram.createSocket('udp4');let step=0,sent13=false,logged=false,timer=[]
 let lastRecv=Date.now(),alive=true,keepAliveTimer=null,deadTimer=null
 let _res,_rej,settled=false;const done=(ok,e)=>{if(settled)return;settled=true;ok?_res&&_res(api):_rej&&_rej(e)}
 // ---- 掉线标记：服务端踢人后 UDP 无连接感知不到，这里显式标记 ----
 function markDead(why){if(!alive)return;alive=false;LOG('[DEAD] '+why)
  if(keepAliveTimer){clearInterval(keepAliveTimer);keepAliveTimer=null}
  if(deadTimer){clearInterval(deadTimer);deadTimer=null}
  emit('dead',why)}
 // ---- 心跳保活：每 15s 原地 MovePlayer 刷新服务端会话超时 ----
 function startKeepAlive(){if(keepAliveTimer)return
  // 服务端 Session.php:142 是 10s 无收包即 timeout → 心跳必须 < 10s，这里用 5s
  keepAliveTimer=setInterval(()=>{if(!alive)return;try{api.moveTo(world.self.x,world.self.y,world.self.z,world.self.yaw,world.self.pitch)}catch(e){LOG('[keepalive] '+e.message)}},5000)
  // 收包超时仅作兜底：服务端对原地 MovePlayer 不回包，短窗会误杀，放宽到 3 分钟
  deadTimer=setInterval(()=>{if(!alive)return;const gap=Date.now()-lastRecv;if(gap>180000)markDead('no data for '+gap+'ms')},15000)
  LOG('[keepalive] started')}
s.bind(0,'0.0.0.0',()=>{const cg=Math.floor(Math.random()*1e15),ping=Date.now();LOG('=== USER='+USER+' PASS='+PASS+' ===')
 s.send(Buffer.concat([Buffer.from([0x01]),u64(ping),MAGIC,u64(cg)]),PORT,HOST)
 function doLogin(){if(logged)return;logged=true;send(s,batch([login()]),2);LOG('[LOGIN] sent')
  timer.push(setTimeout(()=>{LOG('[CHAT userID]',USER);send(s,batch([chat(USER)]),2)},3000))
  timer.push(setTimeout(()=>{LOG('[CHAT pass]');send(s,batch([chat(PASS)]),2)},4500))
  timer.push(setTimeout(()=>{LOG('[CHAT confirm]');send(s,batch([chat(PASS)]),2)},6000))
 }
 s.on('message',(msg)=>{const id=msg[0];lastRecv=Date.now()
  if(id===0x1c&&step===0){step=1;s.send(Buffer.concat([Buffer.from([0x05]),MAGIC,Buffer.from([10]),Buffer.alloc(1383,0)]),PORT,HOST)}
  else if(id===0x06&&step===1){step=2;const sg=msg.readBigUInt64BE(17),mtu=msg.readUInt16BE(msg.length-2);s.send(Buffer.concat([Buffer.from([0x07]),MAGIC,addr(IP,PORT),u16(mtu),u64(cg)]),PORT,HOST);setTimeout(()=>send(s,Buffer.concat([Buffer.from([0x09]),u64(cg),u64(ping),Buffer.from([0])]),2),300)}
  else if(id>=0x80&&id<=0x8f){const packets=getPackets(msg)
   if(!sent13){sent13=true;const zeros=Buffer.concat(Array.from({length:9},()=>{const b=Buffer.alloc(7);b[0]=4;b[1]=255;b[2]=255;b[3]=255;b[4]=255;b.writeUInt16BE(0,5);return b}));send(s,Buffer.concat([Buffer.from([0x13]),addr(IP,PORT),zeros,u64(ping),u64(ping+1000)]),0);LOG('[RAKNET connected]');done(true);setTimeout(doLogin,300);startKeepAlive()}
   for(const p of packets){if(!p||!p.length)continue;decodeServerBatch(p)}
  }
 })
})
function decodeServerBatch(p){if(!p||p.length<2)return;
 // Genisys魔改: 非0.13协议的包 buffer 前加 chr(0x8e) 前缀(varint PID首字节)
 let real=p;let pref=0;
 if(p[0]===0x8e){pref=1;real=p.slice(1)}
 // batch: 0x8e92(varint batch) 或 0x92 —— 注意加了0x8e前缀后 0x92 变成 [0x8e][0x92]
 let off=-1;
 if(real[0]===0x8e&&real[1]===0x92)off=2;
 else if(real[0]===0x92)off=1;
 else if(real[0]===0&&real[1]===0x92)off=2;
 if(off<0){const direct=real[0]===0?real[1]:real[0];if([0x90,0x91,0x93,0x95,0x96,0x97,0x9d,0x9f,0xa7,0xbf,0xbd,0xb9].includes(direct))handle(direct,real[0]===0?real.slice(2):real.slice(1));return}
 try{const sz=real.readInt32BE(off);const raw=zlib.inflateSync(real.slice(off+4,off+4+sz));let o=0;
  while(o+4<=raw.length){const l=raw.readInt32BE(o);o+=4;if(!l||o+l>raw.length)break;const pk=raw.slice(o,o+l);o+=l;
   let pid,b;if(pk[0]===0x8e&&pk[1]&&(pk[1]&0x80)){pid=(pk[0]&0x7f)|((pk[1]&0x7f)<<7);b=pk.slice(2)}else if(pk[0]===0x8e){pid=pk[1];b=pk.slice(2)}else{pid=pk[0]===0?pk[1]:pk[0];b=pk[0]===0?pk.slice(2):pk.slice(1)}
   handle(pid,b)}}
 catch(e){LOG('[batch] '+e.message)}}
function handle(pid,b){if(pid===0x90)LOG('[PLAY_STATUS]',b.readInt32BE(0));else if(pid===0x91){const why=b.toString('utf8');LOG('[DISCONNECT]',why);markDead('server disconnect: '+why)}else if(pid===0x93){let o=1;if((b[0]===1||b[0]===3)){const sl=b.readUInt16BE(o);o+=2+sl}const ml=b.readUInt16BE(o);o+=2;{const _t=b.slice(o,o+ml).toString('utf8');LOG('[MSG]',_t);ONMSG(_t);emit('chat',_t)}}else if(pid===0x95){try{let o=0;o+=4;world.dimension=b[o++];o+=4;world.gamemode=readI32(b,o);o+=4;world.self.eid=Number(readU64(b,o));o+=8;world.spawn.x=readI32(b,o);o+=4;world.spawn.y=readI32(b,o);o+=4;world.spawn.z=readI32(b,o);o+=4;world.self.x=readF32(b,o);o+=4;world.self.y=readF32(b,o);o+=4;world.self.z=readF32(b,o);world.spawned=true;LOG('[bed] START_GAME eid='+world.self.eid+' pos='+world.self.x+','+world.self.y+','+world.self.z);emit('spawn',world.self)}catch(e){LOG('[SG] '+e.message)}}else if(pid===0x96){try{let o=16;const nl=b.readUInt16BE(o);o+=2;const name=b.slice(o,o+nl).toString('utf8');o+=nl;const eid=Number(readU64(b,o));o+=8;const x=readF32(b,o);o+=4;const y=readF32(b,o);o+=4;const z=readF32(b,o);const p={eid,name,x,y,z};world.players.set(eid,p);ONPLAYER(p);emit('player',p);LOG('[bed] +player '+name)}catch(e){}}else if(pid===0x97){try{const eid=Number(readU64(b,0));const p=world.players.get(eid);world.players.delete(eid);if(p)emit('leave',p)}catch{}}else if(pid===0x9d){try{let o=0;const eid=Number(readU64(b,o));o+=8;const x=readF32(b,o);o+=4;const y=readF32(b,o);o+=4;const z=readF32(b,o);if(eid===world.self.eid){world.self.x=x;world.self.y=y;world.self.z=z;emit('move',world.self)}}catch{}}else if(pid===0x9f){try{let o=0;const n=readI32(b,o);o+=4;for(let i=0;i<n&&o+11<=b.length;i++){const x=readI32(b,o),z=readI32(b,o+4),y=b[o+8],id=b[o+9],data=b[o+10]&0x0f;o+=11;const ch=world.chunks.get(Math.floor(x/16)+','+Math.floor(z/16));if(ch&&ch.ids){const lx=x-ch.baseX,lz=z-ch.baseZ;if(lx>=0&&lx<16&&lz>=0&&lz<16&&y>=0&&y<128){const idx=ch.order===1?((y>>4)*4096+((y&15)<<8)|(lz<<4)|lx):((lx<<11)|(lz<<7)|y);ch.ids[idx]=id;ch.metas[idx]=data;if(ch.blocks&&ch.blocks.__map)ch.blocks.__map().set(x+','+y+','+z,{id,data})}}emit('blockUpdate',{x,y,z,id,data})}}catch(e){LOG('[UB] '+e.message)}}
else if(pid===0xbd&&nbtLib){try{const x=readI32(b,0),y=readI32(b,4),z=readI32(b,8);const nbt=b.slice(12);const sign=nbtLib.readSignText?nbtLib.readSignText(nbt,'le'):null;const items=nbtLib.readChestItems?nbtLib.readChestItems(nbt,'le'):null;const rec={x,y,z,sign,items};blockEntities.set(x+','+y+','+z,rec);LOG('[bed] blockEntity @'+x+','+y+','+z+' sign='+JSON.stringify(sign));emit('blockEntity',rec)}catch(e){LOG('[NBT] '+e.message)}}
else if(pid===0xbf&&chunkLib){try{const cx=readI32(b,0),cz=readI32(b,4);const ch=chunkLib.parseChunk(cx,cz,b.slice(9));const ck=cx+','+cz;world.chunks.set(ck,ch);if(!askedRadius&&world.chunks.size>=2){askedRadius=true;send(s,batch([pkt(0xc8,i32(5))]),2);LOG('[bed] REQUEST_CHUNK_RADIUS sent')}
// 不再用区块中心覆盖玩家坐标（那会把服务端给的真出生点冲成假的 128,128）
if(world.chunks.size>16)world.chunks.delete(world.chunks.keys().next().value);ONCHUNK(ch)}catch(e){LOG('[chunk] '+e.message)}}else LOG('[pkt] 0x'+pid.toString(16))}
s.on('error',e=>{LOG('ERR',e.code);done(false,e)})
const api={chat(msg){send(s,batch([chat(msg)]),2)},say(msg){send(s,batch([chat(msg)]),2)},
 moveTo(x,y,z,yaw=0,pitch=0){const bb=Buffer.concat([u64(world.self.eid),f32(x),f32(y),f32(z),f32(yaw),f32(yaw),f32(pitch),Buffer.from([0]),Buffer.from([1])]);send(s,batch([pkt(0x9d,bb)]),2);world.self.x=x;world.self.y=y;world.self.z=z},
 startBreak(x,y,z,f=0){send(s,batch([pkt(0xab,Buffer.concat([u64(world.self.eid),i32(0),i32(x|0),i32(y|0),i32(z|0),i32(f)]))]),2)},
 stopBreak(x,y,z,f=0){send(s,batch([pkt(0xab,Buffer.concat([u64(world.self.eid),i32(2),i32(x|0),i32(y|0),i32(z|0),i32(f)]))]),2)},
 // 手持物品：MobEquipmentPacket(0xa7) = eid(u64) + item(slot) + slot(byte) + selectedSlot(byte)
 setHeldItem(id,count=1,damage=0,slot=0){send(s,batch([pkt(0xa7,Buffer.concat([u64(world.self.eid),itemSlot(id,count,damage),Buffer.from([slot&0xff,slot&0xff])]))]),2)},
 // 放方块：UseItemPacket(0xaa) = x,y,z(i32) + face(byte) + fx,fy,fz(f32) + posX,posY,posZ(f32) + slot(i32) + item(slot)
 useItem(x,y,z,face=1,id=1,count=1,slot=0){const payload=Buffer.concat([i32(x|0),i32(y|0),i32(z|0),Buffer.from([face&0xff]),f32(0.5),f32(1),f32(0.5),f32(x+0.5),f32(y+1),f32(z+0.5),i32(slot),itemSlot(id,count,0)]);send(s,batch([pkt(0xaa,payload)]),2)},
 getSelf(){return {...world.self}},getPlayers(){return [...world.players.values()].map(p=>({...p}))},getWorld(){return world},
 on(ev,fn){if(!listeners.has(ev))listeners.set(ev,[]);listeners.get(ev).push(fn)},
 isAlive(){return alive},
 close(){markDead('local close');timer.forEach(clearTimeout);try{s.close()}catch{}},wait(ms){return new Promise(r=>timer.push(setTimeout(r,ms)))},
 getBlockEntity(x,y,z){return blockEntities.get(x+','+y+','+z)||null},getBlockEntities(){return [...blockEntities.values()]},getBlock(x,y,z){const ch=world.chunks.get(Math.floor(x/16)+','+Math.floor(z/16));return ch?ch.getBlock(x,y,z):null}}
 setTimeout(()=>{if(!settled){LOG('[bed] connect timeout');done(false,new Error('bedrock connect timeout'))}},8000)
 setTimeout(()=>{LOG('=== hold expired ===');markDead('hold expired');timer.forEach(clearTimeout);try{s.close()}catch{}},holdMs)
 return new Promise((res,rej)=>{_res=res;_rej=rej})

}
