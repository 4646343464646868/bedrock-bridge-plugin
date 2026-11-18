/**
 * chunk.mjs —— PocketMine / Genisys 0.14 (MCPE 协议 70) FullChunkData 解析器
 *
 * 依据源码逐字实现（/root/mcserver/pmmp）：
 *  - src/pocketmine/network/protocol/FullChunkDataPacket.php
 *  - src/pocketmine/level/format/leveldb/Chunk.php        (ORDER_COLUMNS)
 *  - src/pocketmine/level/format/mcregion/Chunk.php       (ORDER_COLUMNS)
 *  - src/pocketmine/level/format/anvil/ChunkSection.php   (ORDER_LAYERED)
 *  - src/pocketmine/level/format/generic/BaseChunk.php    (getBlockIdArray/DataArray)
 *  - src/pocketmine/utils/Binary.php / BinaryStream.php   (字节序)
 *
 * ────────────────────────── 查到的协议格式 ──────────────────────────
 *
 * FullChunkDataPacket.encode() 的字节布局（NETWORK_ID = 0xbf）：
 *   [u8  pid=0xbf][i32BE chunkX][i32BE chunkZ][u8 order][i32BE len][u8 data[len]]
 * 其中 putInt() = Binary::writeInt() = pack("N")，即 **大端** 32 位有符号整数。
 * order: 0 = ORDER_COLUMNS（leveldb / mcregion 默认），1 = ORDER_LAYERED（anvil）。
 *
 * data 字段（chunk payload）固定部分，共 81920 字节：
 *   [32768 blocks id][16384 meta/data][16384 skyLight][16384 blockLight][256 heightMap][1024 biomeColors]
 *   其后还有可变长的 extraData + tiles（本模块只关心前两段，忽略其余）。
 * 世界高度 H = 128 = 8 个 16 高的 section。id 是 1 字节，meta 是 4 bit（nibble）。
 *
 * ORDER_COLUMNS (0) —— 按 (x,z) 列组织，y 连续：
 *   id  : idx = (x<<11)|(z<<7)|y          = x*2048 + z*128 + y        [0..32767]
 *   meta: idx = (x<<10)|(z<<6)|(y>>1)     = x*1024 + z*64  + (y>>1)   [0..16383]
 *         y 偶 → 低 4 位 (m & 0x0F)；y 奇 → 高 4 位 (m >> 4)
 *
 * ORDER_LAYERED (1) —— 按 section（每 16 层一段）组织，段内 y,z,x：
 *   section = y >> 4 (0..7)， sy = y & 15
 *   id  : idx = section*4096 + (sy<<8)|(z<<4)|x  = section*4096 + sy*256 + z*16 + x
 *   meta: idx = section*2048 + (sy<<7)|(z<<3)|(x>>1) = section*2048 + sy*128 + z*8 + (x>>1)
 *         x 偶 → 低 4 位 (m & 0x0F)；x 奇 → 高 4 位 (m >> 4)
 */

export const ORDER_COLUMNS = 0;
export const ORDER_LAYERED = 1;
export const CHUNK_SIZE = 16;
export const WORLD_HEIGHT = 128;

const ID_BYTES = CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT; // 32768
const META_BYTES = ID_BYTES / 2; // 16384

/**
 * 解析 data 字段（chunk payload），建立世界绝对坐标的方块表。
 * @param {number} chunkX chunk 的 X 坐标（不是方块坐标）
 * @param {number} chunkZ chunk 的 Z 坐标
 * @param {Buffer|Uint8Array} dataBuffer FullChunkData 包里的 data 字段
 * @param {number} [order=ORDER_COLUMNS] 布局：0=columns, 1=layered
 * @returns {{blocks: Map<string,{id:number,data:number}>, getBlock:Function, order:number, chunkX:number, chunkZ:number}}
 */
export function parseChunk(chunkX, chunkZ, dataBuffer, order = ORDER_COLUMNS) {
  if (dataBuffer == null) throw new TypeError('dataBuffer 不能为空');
  const buf = dataBuffer instanceof Uint8Array ? dataBuffer : new Uint8Array(dataBuffer);
  if (buf.length < ID_BYTES) {
    throw new RangeError(`data 字段只有 ${buf.length} 字节，至少需要 ${ID_BYTES} 字节的 id 区`);
  }
  const baseX = chunkX * CHUNK_SIZE, baseZ = chunkZ * CHUNK_SIZE;
  const idBuf = buf, metaOff = ID_BYTES;
  // 紧凑存储：两片定长 TypedArray，替代 32768 个对象+字符串（省 ~50x 内存）
  const ids = new Uint8Array(CHUNK_SIZE * WORLD_HEIGHT * CHUNK_SIZE);
  const metas = new Uint8Array(ids.length);
  const idx = (x, y, z) => (y * CHUNK_SIZE + z) * CHUNK_SIZE + x; // y 主序，便于按 y 扫
  if (order === ORDER_LAYERED) {
    for (let sy = 0; sy < WORLD_HEIGHT; sy++) {
      const section = sy >> 4, ly = sy & 15;
      const idBase = section * 4096 + (ly << 8), metaBase = section * 2048 + (ly << 7);
      for (let z = 0; z < CHUNK_SIZE; z++) {
        const idRow = idBase + (z << 4), metaRow = metaBase + (z << 3);
        for (let x = 0; x < CHUNK_SIZE; x++) {
          const m = metaOff + metaRow + (x >> 1) < buf.length ? buf[metaOff + metaRow + (x >> 1)] : 0;
          ids[idx(x, sy, z)] = idBuf[idRow + x] | 0;
          metas[idx(x, sy, z)] = (x & 1) === 0 ? (m & 0x0f) : (m >> 4);
        }
      }
    }
  } else {
    for (let x = 0; x < CHUNK_SIZE; x++) {
      const idX = x << 11, metaX = x << 10;
      for (let z = 0; z < CHUNK_SIZE; z++) {
        const idCol = idX + (z << 7), metaCol = metaX + (z << 6);
        for (let y = 0; y < WORLD_HEIGHT; y++) {
          const mi = metaOff + metaCol + (y >> 1);
          const m = mi < buf.length ? buf[mi] : 0;
          ids[idx(x, y, z)] = idBuf[idCol + y] | 0;
          metas[idx(x, y, z)] = (y & 1) === 0 ? (m & 0x0f) : (m >> 4);
        }
      }
    }
  }
  function getBlock(x, y, z) {
    const lx = x - baseX, lz = z - baseZ;
    if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE || y < 0 || y >= WORLD_HEIGHT)
      return { id: 0, data: 0 };
    const i = idx(lx, y, lz);
    return { id: ids[i], data: metas[i] };
  }
  // blocks 兼容视图：懒加载 Map（仅在 selfTest/确实需要枚举时构造）
  let _blocks = null;
  const blocks = {
    get size() { if (!_blocks) { _blocks = new Map(); for (let y=0;y<WORLD_HEIGHT;y++) for(let z=0;z<CHUNK_SIZE;z++) for(let x=0;x<CHUNK_SIZE;x++) _blocks.set(`${baseX+x},${y},${baseZ+z}`,{id:ids[idx(x,y,z)],data:metas[idx(x,y,z)]}); } return _blocks.size },
    [Symbol.iterator]() { return this.__map()[Symbol.iterator]() },
    __map() { if (!_blocks) { _blocks=new Map(); for(let y=0;y<WORLD_HEIGHT;y++)for(let z=0;z<CHUNK_SIZE;z++)for(let x=0;x<CHUNK_SIZE;x++)_blocks.set(`${baseX+x},${y},${baseZ+z}`,{id:ids[idx(x,y,z)],data:metas[idx(x,y,z)]}); } return _blocks },
  };
  return { ids, metas, blocks, getBlock, order, chunkX, chunkZ, baseX, baseZ };
}

export function parseFullChunkPacket(packetBuffer) {
  const buf = packetBuffer instanceof Uint8Array ? packetBuffer : new Uint8Array(packetBuffer);
  if (buf.length < 13) throw new RangeError('FullChunkData 包体至少 13 字节');
  let off = 0;
  const pid = buf[off++]; // 0xbf
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const chunkX = dv.getInt32(off, false); off += 4; // 大端
  const chunkZ = dv.getInt32(off, false); off += 4;
  const order = buf[off++];
  const len = dv.getInt32(off, false); off += 4;
  const data = buf.subarray(off, off + len);
  const parsed = parseChunk(chunkX, chunkZ, data, order);
  return { pid, len, ...parsed };
}

/** 颜色后缀（羊毛/染色黏土/地毯） */
const DYE_NAMES = ['白', '橙', '品红', '浅蓝', '黄', '黄绿', '粉', '灰', '浅灰', '青', '紫', '蓝', '棕', '绿', '红', '黑'];
const WOOD_NAMES = ['橡木', '云杉', '桦木', '丛林'];
const WOOD2_NAMES = ['金合欢', '深色橡木'];
const LEAVES_NAMES = ['橡树', '云杉', '桦树', '丛林'];
const LEAVES2_NAMES = ['金合欢', '深色橡树'];

const BLOCK_NAMES = {
  0: '空气', 1: '石头', 2: '草方块', 3: '泥土', 4: '圆石', 5: '木板', 6: '树苗', 7: '基岩',
  8: '水', 9: '静止水', 10: '岩浆', 11: '静止岩浆', 12: '沙子', 13: '沙砾', 14: '金矿石',
  15: '铁矿石', 16: '煤矿石', 17: '原木', 18: '树叶', 19: '海绵', 20: '玻璃', 21: '青金石矿石',
  22: '青金石块', 23: '发射器', 24: '砂岩', 25: '音符盒', 26: '床', 27: '动力铁轨', 28: '探测铁轨',
  30: '蜘蛛网', 31: '高草', 32: '枯灌木', 35: '羊毛', 37: '蒲公英', 38: '红花', 39: '棕色蘑菇',
  40: '红色蘑菇', 41: '金块', 42: '铁块', 43: '双层半砖', 44: '半砖', 45: '砖块', 46: 'TNT',
  47: '书架', 48: '苔石', 49: '黑曜石', 50: '火把', 51: '火', 52: '刷怪笼', 53: '木楼梯', 54: '箱子',
  55: '红石线', 56: '钻石矿石', 57: '钻石块', 58: '工作台', 59: '小麦', 60: '耕地', 61: '熔炉',
  62: '燃烧的熔炉', 63: '木牌', 64: '木门', 65: '梯子', 66: '铁轨', 67: '圆石楼梯', 68: '墙上的牌',
  69: '拉杆', 70: '石质压力板', 71: '铁门', 72: '木质压力板', 73: '红石矿石', 74: '发光红石矿石',
  75: '熄灭的红石火把', 76: '红石火把', 77: '石质按钮', 78: '雪', 79: '冰', 80: '雪块', 81: '仙人掌',
  82: '黏土块', 83: '甘蔗', 85: '栅栏', 86: '南瓜', 87: '地狱岩', 88: '灵魂沙', 89: '萤石',
  90: '地狱门', 91: '南瓜灯', 92: '蛋糕', 93: '中继器', 94: '点亮的中继器', 95: '隐形基岩',
  96: '活板门', 97: '怪物蛋', 98: '石砖', 99: '棕色蘑菇块', 100: '红色蘑菇块', 101: '铁栏杆',
  102: '玻璃板', 103: '西瓜', 104: '南瓜茎', 105: '西瓜茎', 106: '藤蔓', 107: '栅栏门',
  108: '砖块楼梯', 109: '石砖楼梯', 110: '菌丝', 111: '睡莲', 112: '地狱砖', 113: '地狱砖栅栏',
  114: '地狱砖楼梯', 115: '地狱疣块', 116: '附魔台', 117: '炼药锅', 118: '炼药锅(旧)', 120: '末地门框架',
  121: '末地石', 123: '熄灭的红石灯', 124: '点亮的红石灯', 125: '投掷器', 126: '激活铁轨',
  127: '可可果', 128: '砂岩楼梯', 129: '绿宝石矿石', 131: '绊线钩', 132: '绊线', 133: '绿宝石块',
  134: '云杉木楼梯', 135: '桦木楼梯', 136: '丛林木楼梯', 139: '圆石墙', 140: '花盆', 141: '胡萝卜',
  142: '马铃薯', 143: '木质按钮', 144: '头颅', 145: '铁砧', 146: '陷阱箱', 147: '轻质压力板',
  148: '重质压力板', 151: '阳光传感器', 152: '红石块', 153: '地狱石英矿石', 154: '漏斗', 155: '石英块',
  156: '石英楼梯', 157: '双层木板半砖', 158: '木板半砖', 159: '染色黏土', 161: '树叶2', 162: '原木2',
  163: '金合欢木楼梯', 164: '深色橡木楼梯', 165: '史莱姆块', 167: '铁活板门', 170: '干草捆',
  171: '地毯', 172: '硬化黏土', 173: '煤炭块', 174: '冰砖', 175: '双植物', 178: '反向阳光传感器',
  179: '红砂岩', 180: '红砂岩楼梯', 181: '双层红砂岩半砖', 182: '红砂岩半砖', 183: '云杉栅栏门',
  184: '桦木栅栏门', 185: '丛林栅栏门', 186: '深色橡木栅栏门', 187: '金合欢栅栏门', 193: '云杉木门',
  194: '桦木门', 195: '丛林门', 196: '金合欢门', 197: '深色橡木门', 198: '草径', 199: '物品展示框',
  243: '灰化土', 244: '甜菜', 245: '切石机', 246: '发光黑曜石', 247: '地狱反应堆', 439: '相机',
};

/**
 * 数字 ID → 常见方块名。data 用于带变种的方块（羊毛颜色、原木种类等）。
 * @param {number} id
 * @param {number} [data=0]
 * @returns {string}
 */
export function blockName(id, data = 0) {
  const base = BLOCK_NAMES[id | 0];
  if (base === undefined) return `未知方块(${id})`;
  const d = data & 0x0f;
  if (id === 35 || id === 159 || id === 171) return `${DYE_NAMES[d] || d}${base}`;
  if (id === 17) return `${WOOD_NAMES[d] || d}${base}`;
  if (id === 162) return `${WOOD2_NAMES[d] || d}${base}`;
  if (id === 18) return `${LEAVES_NAMES[d] || d}${base}`;
  if (id === 161) return `${LEAVES2_NAMES[d] || d}${base}`;
  if (id === 6) return `${WOOD_NAMES[d] || d}树苗`;
  return base;
}

/** 自测：全石头 chunk（16x16x128 全 id=1）+ 若干精确断言 */
export function selfTest() {
  const assert = (cond, msg) => { if (!cond) throw new Error('自测失败：' + msg); };

  for (const order of [ORDER_COLUMNS, ORDER_LAYERED]) {
    const data = Buffer.alloc(ID_BYTES + META_BYTES, 0);
    data.fill(1, 0, ID_BYTES); // id 区全石头，meta 全 0
    const { getBlock, blocks } = parseChunk(0, 0, data, order);
    assert(blocks.size === 16 * 16 * 128, `order ${order} 方块数应为 32768`);
    assert(getBlock(0, 64, 0).id === 1, `order ${order} getBlock(0,64,0).id===1`);
    assert(getBlock(15, 127, 15).id === 1, `order ${order} 角落方块也是石头`);
    assert(getBlock(1, 0, 1).data === 0, `order ${order} meta 为 0`);
  }

  // columns 布局的 meta：在 (x=0,z=0,y=1) 奇数列，meta 存在高 4 位
  {
    const data = Buffer.alloc(ID_BYTES + META_BYTES, 0);
    data[ID_BYTES + 0 + (1 >> 1)] = 0x05 << 4; // z*64=0, y>>1=0，高 4 位 =5
    const { getBlock } = parseChunk(1, 2, data, ORDER_COLUMNS);
    assert(getBlock(16, 1, 32).data === 5, 'columns meta 奇数 y 取高 4 位');
  }

  // layered 布局：指定 section=4(y=64..79), sy=0(y=64), x=0,z=0 → id=42, meta=7
  {
    const data = Buffer.alloc(ID_BYTES + META_BYTES, 0);
    const section = 4, sy = 0;
    data[section * 4096 + (sy << 8) + 0] = 42;
    data[ID_BYTES + section * 2048 + (sy << 7) + 0] = 0x07; // x=0 偶 → 低 4 位
    const { getBlock } = parseChunk(0, 0, data, ORDER_LAYERED);
    const b = getBlock(0, 64, 0);
    assert(b.id === 42 && b.data === 7, 'layered 精确 id/meta 定位');
  }

  // 整包解析（大端头）+ 名称映射
  {
    const payload = Buffer.alloc(ID_BYTES + META_BYTES, 0);
    payload.fill(1, 0, ID_BYTES);
    const pkt = Buffer.alloc(13 + payload.length);
    pkt[0] = 0xbf;
    pkt.writeInt32BE(-1, 1); // chunkX = -1
    pkt.writeInt32BE(3, 5);  // chunkZ = 3
    pkt[9] = ORDER_COLUMNS;
    pkt.writeInt32BE(payload.length, 10);
    payload.copy(pkt, 14);
    const parsed = parseFullChunkPacket(pkt);
    assert(parsed.chunkX === -1 && parsed.chunkZ === 3, '大端有符号 chunkX/Z');
    assert(parsed.getBlock(-16, 64, 48).id === 1, '负坐标 chunk 世界坐标换算');
    assert(blockName(1) === '石头' && blockName(2) === '草方块' && blockName(5) === '木板', '常见方块名');
  }

  return '全部自测通过';
}

// 作为脚本直接运行时执行自测
import { fileURLToPath } from 'node:url';
import { argv } from 'node:process';
if (argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${argv[1]}`))) {
  console.log(selfTest());
}
