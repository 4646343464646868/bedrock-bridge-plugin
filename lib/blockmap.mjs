/** MCPE 0.14 数字方块 id -> Java 风格英文名。 */
const M = {
  0:'air',1:'stone',2:'grass_block',3:'dirt',4:'cobblestone',5:'oak_planks',6:'oak_sapling',
  7:'bedrock',8:'water',9:'water',10:'lava',11:'lava',12:'sand',13:'gravel',14:'gold_ore',
  15:'iron_ore',16:'coal_ore',17:'oak_log',18:'oak_leaves',19:'sponge',20:'glass',21:'lapis_ore',
  22:'lapis_block',23:'dispenser',24:'sandstone',25:'note_block',26:'bed',27:'powered_rail',
  28:'detector_rail',29:'sticky_piston',30:'cobweb',31:'short_grass',32:'dead_bush',33:'piston',
  34:'piston_head',35:'white_wool',36:'yellow_wool',37:'dandelion',38:'poppy',39:'brown_mushroom',
  40:'red_mushroom',41:'gold_block',42:'iron_block',43:'double_stone_slab',44:'stone_slab',
  45:'bricks',46:'tnt',47:'bookshelf',48:'mossy_cobblestone',49:'obsidian',50:'torch',51:'fire',
  52:'spawner',53:'oak_stairs',54:'chest',55:'redstone_wire',56:'diamond_ore',57:'diamond_block',
  58:'crafting_table',59:'wheat',60:'farmland',61:'furnace',62:'furnace',63:'oak_sign',64:'oak_door',
  65:'ladder',66:'rail',67:'cobblestone_stairs',68:'oak_wall_sign',69:'lever',70:'stone_pressure_plate',
  71:'iron_door',72:'oak_pressure_plate',73:'redstone_ore',74:'redstone_ore',75:'redstone_torch',
  76:'redstone_torch',77:'stone_button',78:'snow',79:'ice',80:'snow_block',81:'cactus',82:'clay',
  83:'sugar_cane',84:'jukebox',85:'fence',86:'pumpkin',87:'netherrack',88:'soul_sand',89:'glowstone',
  90:'portal',91:'carved_pumpkin',92:'jack_o_lantern',93:'cake',94:'repeater',95:'white_stained_glass',
  96:'oak_trapdoor',97:'iron_trapdoor',98:'stone_bricks',99:'brown_mushroom_block',100:'red_mushroom_block',
  101:'iron_bars',102:'chain',103:'brick_stairs',104:'stone_brick_stairs',105:'mycelium',106:'lily_pad',
  107:'nether_bricks',108:'nether_brick_fence',109:'nether_brick_stairs',110:'nether_wart',111:'enchanting_table',
  112:'brewing_stand',113:'cauldron',114:'end_portal',115:'end_portal_frame',116:'end_stone',117:'dragon_egg',
  118:'redstone_lamp',119:'redstone_lamp',120:'oak_door',121:'spruce_door',122:'birch_door',123:'jungle_door',
  124:'acacia_door',125:'dark_oak_door',126:'activator_rail',127:'observer',
  128:'white_terracotta',129:'orange_terracotta',130:'magenta_terracotta',131:'light_blue_terracotta',
  132:'yellow_terracotta',133:'lime_terracotta',134:'pink_terracotta',135:'gray_terracotta',
  136:'light_gray_terracotta',137:'cyan_terracotta',138:'purple_terracotta',139:'blue_terracotta',
  140:'brown_terracotta',141:'green_terracotta',142:'red_terracotta',143:'black_terracotta',
  155:'quartz_block',156:'quartz_stairs',157:'wooden_button',158:'barrel',159:'hopper',160:'quartz_bricks',
  161:'dropper',163:'white_concrete',164:'orange_concrete',165:'magenta_concrete',166:'light_blue_concrete',
  167:'yellow_concrete',168:'lime_concrete',169:'pink_concrete',170:'gray_concrete',171:'light_gray_concrete',
  172:'cyan_concrete',173:'purple_concrete',174:'blue_concrete',175:'brown_concrete',176:'green_concrete',
  177:'red_concrete',178:'black_concrete',179:'beacon',180:'oak_trapdoor',
  200:'prismarine',201:'sea_lantern',202:'hay_block',203:'white_carpet',204:'orange_carpet',
  205:'magenta_carpet',206:'light_blue_carpet',207:'yellow_carpet',208:'lime_carpet',209:'pink_carpet',
  210:'gray_carpet',211:'light_gray_carpet',212:'cyan_carpet',213:'purple_carpet',214:'blue_carpet',
  215:'brown_carpet',216:'green_carpet',217:'red_carpet',218:'black_carpet',219:'terracotta',
  220:'coal_block',221:'beacon',240:'seagrass',241:'tall_seagrass',242:'sea_pickle',
  243:'dried_kelp_block',244:'tube_coral_block',255:'barrier'
}
const WOOL_IDS = new Set([35,36,95,159])
export function javaName(id, data = 0) {
  if (id === 35 || id === 36) {
    const colors=['white','orange','magenta','light_blue','yellow','lime','pink','gray','light_gray','cyan','purple','blue','brown','green','red','black']
    return (colors[data & 15] || 'white') + '_wool'
  }
  if (id === 17 || id === 18) {
    const woods=['oak','spruce','birch','jungle','acacia','dark_oak']
    const w = woods[data & 3] || 'oak'
    return id === 17 ? w + '_log' : w + '_leaves'
  }
  if (id === 5) { const woods=['oak','spruce','birch','jungle','acacia','dark_oak']; return (woods[data&3]||'oak')+'_planks' }
  return M[id] || ('unknown_' + id)
}
export function isAirName(name){ return !name || name === 'air' || name.startsWith('unknown_') === false && name === 'air' }
// 名字 -> 数字ID（放方块用）。返回 null 表示不认识。
export function idByName(name){
  if(!name)return null
  const n = String(name).trim().toLowerCase()
  for(const [id,v] of Object.entries(M)) if(v===n) return Number(id)
  // 常见别名
  const aliases={cobblestone:4,stone:1,oak_planks:5,planks:5,wood_planks:5,dirt:3,grass_block:2,glass:20,sand:12,bricks:45,stone_bricks:98,oak_log:17,oak_leaves:18,coal_block:220,gold_block:41,iron_block:42,diamond_block:57,bedrock:7,torch:50,crafting_table:58,furnace:61,chest:54,water:8,lava:10}
  return aliases[n] ?? null
}
