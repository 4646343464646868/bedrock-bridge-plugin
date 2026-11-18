/**
 * nbt.mjs — PocketMine/Genisys 0.14 (MCPE 0.14, protocol 70) NBT 编解码器
 *
 * 依据 /root/mcserver/pmmp/src/pocketmine/nbt/ 的实际源码实现：
 *  - tag 类型枚举来自 NBT.php 第 59-70 行 (TAG_End=0 ... TAG_IntArray=11)
 *  - 字节序：NBT 类持有 endianness 成员，默认 LITTLE_ENDIAN=0 (构造函数 454 行)
 *  - short/int/long/float/double 按 endianness 在 BE(unpack n/N) 与 LE(unpack v/V) 间切换
 *  - byte 单字节无字节序；string = short 长度 + UTF-8 字节
 *  - list = 1 byte 元素类型 + int 数量 + N 个「无 name / 无 type」的元素 payload
 *  - compound = 一串带 name 的 tag，直到 TAG_End(0)
 *
 * 字节序怎么选：
 *  - BlockEntityDataPacket（木牌文字、箱子物品发给客户端）走 Spawnable.php:21 的
 *    NBT(NBT::LITTLE_ENDIAN) → 网络方块实体数据默认是 LE。
 *  - 磁盘存档 anvil/mcregion 用 BIG_ENDIAN。
 *  - 本模块 endianness 默认 'auto'：尝试两种字节序解析，取成功的那个（都成功优先 LE）。
 *    也可显式传 'le'/'little' 或 'be'/'big'。
 */

/** NBT tag 类型枚举（与 NBT.php 完全一致） */
export const TAG = Object.freeze({
  End: 0,
  Byte: 1,
  Short: 2,
  Int: 3,
  Long: 4,
  Float: 5,
  Double: 6,
  ByteArray: 7,
  String: 8,
  List: 9,
  Compound: 10,
  IntArray: 11,
});

function normalizeEndian(e) {
  if (e === 'le' || e === 'little' || e === 0 || e === 'LITTLE_ENDIAN') return 'le';
  if (e === 'be' || e === 'big' || e === 1 || e === 'BIG_ENDIAN') return 'be';
  return 'auto';
}

class Reader {
  constructor(buf, endian) {
    this.buf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    this.off = 0;
    this.le = endian === 'le';
  }
  need(n) {
    if (this.off + n > this.buf.length) {
      throw new RangeError(`NBT: 越界读取 offset=${this.off} need=${n} len=${this.buf.length}`);
    }
  }
  u8() { this.need(1); return this.buf.readUInt8(this.off++); }
  i8() { this.need(1); return this.buf.readInt8(this.off++); }
  u16() {
    this.need(2);
    const v = this.le ? this.buf.readUInt16LE(this.off) : this.buf.readUInt16BE(this.off);
    this.off += 2; return v;
  }
  i16() {
    this.need(2);
    const v = this.le ? this.buf.readInt16LE(this.off) : this.buf.readInt16BE(this.off);
    this.off += 2; return v;
  }
  i32() {
    this.need(4);
    const v = this.le ? this.buf.readInt32LE(this.off) : this.buf.readInt32BE(this.off);
    this.off += 4; return v;
  }
  i64() {
    this.need(8);
    const v = this.le ? this.buf.readBigInt64LE(this.off) : this.buf.readBigInt64BE(this.off);
    this.off += 8; return v;
  }
  f32() {
    this.need(4);
    const v = this.le ? this.buf.readFloatLE(this.off) : this.buf.readFloatBE(this.off);
    this.off += 4; return v;
  }
  f64() {
    this.need(8);
    const v = this.le ? this.buf.readDoubleLE(this.off) : this.buf.readDoubleBE(this.off);
    this.off += 8; return v;
  }
  string() {
    const len = this.u16();       // PHP getString() = get(getShort())，长度受字节序影响，无符号
    this.need(len);
    const s = this.buf.toString('utf8', this.off, this.off + len);
    this.off += len; return s;
  }
  bytes() {
    const len = this.i32();       // ByteArrayTag::read = get(getInt())
    if (len < 0) throw new RangeError(`NBT: ByteArray 负长度 ${len}`);
    this.need(len);
    const b = Buffer.from(this.buf.subarray(this.off, this.off + len));
    this.off += len; return b;
  }

  /** 读一个 payload（不含 type / name），List 元素就走这里 */
  payload(type, depth = 0) {
    if (depth > 64) throw new RangeError('NBT: 嵌套过深');
    switch (type) {
      case TAG.End:      return null;
      case TAG.Byte:     return this.i8();
      case TAG.Short:    return this.i16();
      case TAG.Int:      return this.i32();
      case TAG.Long:     return this.i64();
      case TAG.Float:    return this.f32();
      case TAG.Double:   return this.f64();
      case TAG.ByteArray:return this.bytes();
      case TAG.String:   return this.string();
      case TAG.List: {
        const elemType = this.u8();          // ListTag::read: getByte() 取元素类型
        const count = this.i32();            // 再 getInt() 取数量
        if (count < 0 || count > 1e7) throw new RangeError(`NBT: List 数量异常 ${count}`);
        const out = new Array(count);
        for (let i = 0; i < count; i++) out[i] = this.payload(elemType, depth + 1);
        return out;
      }
      case TAG.Compound: {
        const out = {};
        // CompoundTag::read: do readTag() while !End && !feof
        for (;;) {
          this.need(1);
          const t = this.u8();
          if (t === TAG.End) break;          // 遇到 TAG_End 结束本 compound
          const name = this.string();
          out[name] = this.payload(t, depth + 1);
        }
        return out;
      }
      case TAG.IntArray: {
        const len = this.i32();              // IntArrayTag::read = getInt() 个 int
        if (len < 0 || len > 1e7) throw new RangeError(`NBT: IntArray 数量异常 ${len}`);
        this.need(len * 4);
        const out = new Array(len);
        for (let i = 0; i < len; i++) out[i] = this.i32();
        return out;
      }
      default:
        throw new RangeError(`NBT: 未知 tag 类型 ${type}`);
    }
  }

  /** 读一个完整的 named tag（顶层 tag 用），返回 {name, type, value} */
  tag(depth = 0) {
    const type = this.u8();
    if (type === TAG.End) return { name: '', type, value: null };
    const name = this.string();
    return { name, type, value: this.payload(type, depth + 1) };
  }
}

function tryParse(buf, endian) {
  const r = new Reader(buf, endian);
  const result = r.tag();
  // 数据尾部应是干净结束：允许末尾有若干 0（End），其余视为异常，帮助 auto 判字节序
  let trailingOk = true;
  for (let i = r.off; i < r.buf.length; i++) {
    if (r.buf[i] !== 0) { trailingOk = false; break; }
  }
  if (!trailingOk) throw new RangeError('NBT: 顶层解析后存在未消费的非零字节');
  return result;
}

/**
 * 解析 NBT buffer → JS 对象。
 * @param {Buffer|Uint8Array} buffer
 * @param {'auto'|'le'|'be'|'little'|'big'|0|1} endianness 默认 auto（网络方块实体为 LE，磁盘为 BE）
 * @returns {*} 顶层 tag 的 value：Compound→对象，List→数组，标量→对应 JS 值
 */
export function parseNBT(buffer, endianness = 'auto') {
  const e = normalizeEndian(endianness);
  if (e === 'le' || e === 'be') return tryParse(buffer, e).value;

  // auto：两种都试，成功者优先；都成功时优先 LE（BlockEntityData 的实际字节序）
  let leRes = null, beRes = null, leErr = null, beErr = null;
  try { leRes = tryParse(buffer, 'le'); } catch (err) { leErr = err; }
  if (leRes && leRes.type === TAG.End) leRes = null;
  try { beRes = tryParse(buffer, 'be'); } catch (err) { beErr = err; }
  if (beRes && beRes.type === TAG.End) beRes = null;
  if (leRes) return leRes.value;
  if (beRes) return beRes.value;
  throw (leErr || beErr || new Error('NBT: 无法解析'));
}

/** 解析并连同顶层 tag 的 name / type 一起返回 */
export function parseNBTWithName(buffer, endianness = 'auto') {
  const e = normalizeEndian(endianness);
  if (e === 'le' || e === 'be') return tryParse(buffer, e);
  let leRes = null, beRes = null;
  try { leRes = tryParse(buffer, 'le'); } catch (_) {}
  try { beRes = tryParse(buffer, 'be'); } catch (_) {}
  if (leRes) return leRes;
  if (beRes) return beRes;
  throw new Error('NBT: 无法解析');
}

/**
 * 从木牌 BlockEntityData NBT 提取 4 行文字。
 * 服务端 Sign.php 字段：id, Text1..Text4 (StringTag), x/y/z (IntTag)。
 * 保留 § 颜色符号（TextFormat），不做 clean。
 * @returns {string[]} 长度 4 的数组，缺失行补空串
 */
export function readSignText(buffer, endianness = 'auto') {
  const obj = parseNBT(buffer, endianness);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return ['', '', '', ''];
  return ['Text1', 'Text2', 'Text3', 'Text4'].map((k) =>
    Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null ? String(obj[k]) : ''
  );
}

/**
 * 从箱子 NBT 的 "Items" list 提取物品数组。
 * 服务端 NBT::putItemHelper 字段：id(Short), Count(Byte), Damage(Short), Slot(Byte), tag(Compound 可选)。
 * @returns {Array<{id:number, Count:number, Damage:number, slot:number, tag?:*}>}
 */
export function readChestItems(buffer, endianness = 'auto') {
  const obj = parseNBT(buffer, endianness);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  const items = obj.Items;
  if (!Array.isArray(items)) return [];
  return items.filter((it) => it && typeof it === 'object').map((it) => ({
    id: it.id != null ? it.id : 0,
    Count: it.Count != null ? it.Count : 0,
    Damage: it.Damage != null ? it.Damage : 0,
    slot: it.Slot != null ? it.Slot : (it.slot != null ? it.slot : 0),
    ...(it.tag != null ? { tag: it.tag } : {}),
  }));
}

export default { TAG, parseNBT, parseNBTWithName, readSignText, readChestItems };
