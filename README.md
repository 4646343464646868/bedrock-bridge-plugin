# bedrock-bridge（基岩桥）

> **本项目由 AI（DeepSeek / 「小鱼酱」）独立设计、编写与调试。** 从协议逆向到 RakNet 握手、
> 分片重组、NBT 解析、全部 JavaSscript 实现，均为 AI 在主人 1614 的授权与陪伴下完成。

让 DSH 用一个真正独立的游戏角色连接 **Minecraft 基岩版 0.14（协议 70）** 服务器，
并提供一整套 `bed_*` 工具：进服、聊天、发命令、看地形、挖放方块、读木牌/箱子。

**完全独立**：不依赖 whale_craft 或其它任何 MC 插件，自带 Vec3、游戏核心、协议引擎、区块与 NBT 解析。

## 工具一览

| 工具 | 作用 |
| --- | --- |
| `bed_connect` | 连接基岩服。可传服务器别名或地址，自动 RakNet 握手 + 登录 + 聊天注册 |
| `bed_server` | 管理自定义服务器别名（list/add/remove） |
| `bed_status` / `bed_context` | 在线状态、坐标、朝向、生存数据 |
| `bed_players` / `bed_entities` | 在线玩家、附近实体 |
| `bed_inventory` | 背包与手持 |
| `bed_say` | 聊天框发言 |
| `bed_command` | 以玩家身份执行游戏内命令（如 `/list`、`/tp`） |
| `bed_scan` / `bed_map` / `bed_height` | 扫描方块、地形图、高度图 |
| `bed_move` / `bed_look` / `bed_act` | 移动、看向、互动（放/挖/用/攻击/持物） |
| `bed_build` / `bed_dig` / `bed_give` | 批量建造、挖掘、获取物品 |
| `bed_blockentity` | 读木牌文字、箱子物品（NBT） |
| `bed_log` / `bed_disconnect` | 客户端日志、下线 |
| `bed_ping_new` / `bed_connect_new` | 高版本基岩服（1.16+，全版本 1.16~1.26 自动探测）：探测、连接。版本全自动，只填 host/port/user 即可。进服遵守正版/离线规则（见下） |

## 自然语言直连

配置好别名后，直接对 AI 说「连我的服」「连本地」即可，AI 会用记住的地址/端口/账号/密码连接。

```js
bed_server { action:'add', alias:'我的服', host:'example.com', port:19132, user:'DeepSeek', password:'...' }
bed_connect { host:'我的服' }
```

已内置别名：`我的服` / `简版`（127.0.0.1:19133）、`本地` / `local`（127.0.0.1:19132）。

## 技术要点（0.14 协议）

- 传输：RakNet over UDP，magic `00ffff00fefefefefdfdfdfd12345678`
- 登录包：`0x8f`（含 username/protocol1/protocol2/clientId/UUID/地址/密钥/皮肤）
- 服务端小包带 `0x8e` varint 前缀；batch = zlib(int32 len + [pid][payload]…)
- DATA_PACKET 的 id 是 `0x80`–`0x8f`（不只 0x80！），分片按 splitID 重组
- 区块 `0xbf`：16×16×128，COLUMNS/LAYERED 两种布局，紧凑 Uint8Array 存储
- 方块实体 `0xbd`：LE 字节序 NBT，木牌 Text1-4 / 箱子 Items

## 设置页 / 对话预设

- **原生设置页**：DSH「设置 → 插件 → bedrock-bridge」会自动出现一页，可配置 defaultServer / defaultUser / heartbeatMs / autoRegister / fallbackVersion（插件导出 schemastery Config，字段带 .volatile()，改完自动写回 profile patch）。
- **对话预设**：profile 的 cordis.patch.yml 里注册了 mc（=MC模式）/ mcplus（=MC+）两个预设，whale_craft 的 mcModePresets/mcPlusPresets 名单也加入了这两个 id。会话下拉选它们即进入对应模式。预设/名单在插件仓库之外，重启 DSH 生效。

## 安装

这是一个 cordis bundle，用 `plugin_manager install_bundle` 安装本目录。
安装后工具在所有会话可见（不需 MC 模式）。

## 高版本基岩服（1.16+）

`bed_connect_new` 走 bedrock-protocol 3.61.0（动态 import `/root/bedrock-bridge/node_modules`，不打包进插件）。
安卓 proot 编不了 C++ binding，用 `skipPing + jsp-raknet` 绕过。

进服规则（1614 亲定）：账号由用户自己填；进服前检测正版/离线；正版服未登录官方账号 → 退出并提示
「您暂未登录您的账号，该服务器为正版服务器，需要官方账号，请补充。」

## 已知限制

- `bed_connect`（0.14）与 `bed_connect_new`（1.16+）是两套引擎，工具部分共用 botcore。
- 高版本侧的 scan/map/build 尚未接真实世界数据（待有真服实测后补）。
- prismarine-xbox-services 用离线 stub：官方账号（Xbox 登录）路径未接入，只支持离线名。
- eid 解析偶尔为 0，不影响聊天/地形/挖建
