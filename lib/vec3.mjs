/** 自带 Vec3 —— 与 mineflayer 的 vec3 接口兼容（clone/floored/offset/distanceTo/minus/plus/toString）。 */
export class Vec3 {
  constructor (x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z }
  clone () { return new Vec3(this.x, this.y, this.z) }
  floored () { return new Vec3(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z)) }
  offset (x, y, z) { return new Vec3(this.x + x, this.y + y, this.z + z) }
  plus (o) { return new Vec3(this.x + o.x, this.y + o.y, this.z + o.z) }
  minus (o) { return new Vec3(this.x - o.x, this.y - o.y, this.z - o.z) }
  times (s) { return new Vec3(this.x * s, this.y * s, this.z * s) }
  distanceTo (o) { return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z) }
  distanceSquared (o) { const a=this.x-o.x,b=this.y-o.y,c=this.z-o.z; return a*a+b*b+c*c }
  equals (o) { return this.x===o.x&&this.y===o.y&&this.z===o.z }
  toString () { return `${this.x}, ${this.y}, ${this.z}` }
  toJSON () { return { x:this.x, y:this.y, z:this.z } }
}
export default Vec3
