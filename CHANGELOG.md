# 更新日志

## 1.4.0
- **【真凶修复】版本自动探测**：之前 `skipPing:true` 又没传 version，库静默用 1.26.60/协议2225 去连（如 649 的 BDS 1.20.61），服务端完全静默不回 network_settings——这就是一直卡住的真正原因（本地闭环实测：版本一致三种全通、不一致即静默）。新增 `lib/probeBedrock.mjs`：裸 RakNet ping 拿 PONG→协议号→反查库全版本表（55 个版本 1.16~1.26）自动选 version；探测失败改用 PONG 自带版本串，再失败才报错，**不再硬编码 1.26.60**。
- **RakNet 协议号运行时 patch**：新增 `lib/raknetPatch.mjs`，>=1.19.30 的服运行时把 jsp-raknet 的 RakNet 协议 10→11（幂等 monkey-patch OpenConnectionRequest1.encode），不手改 node_modules、可进 git；引擎强制 `useRaknetWorkers:false`（否则 worker 加载未 patch 的模块）。
- `bed_connect_new {host,port,user}` 现在不填版本也能连（全自动探测+patch）。
- `bed_ping_new` 改用 probeBedrock，返回版本/协议号/MOTD/人数/自动匹配版本。
- 修正认知：之前把卡住归因于"正版认证/库不兼容"是错的，network_settings 在 login 之前，与 Xbox 认证无关。

## 1.3.1
- 正版服检测（1614 亲定规则）：高版本引擎连上后 12s 没进游戏 → 判定为正版服需要 Xbox 官方账号，抛 `ONLINE_MODE_REQUIRED`。
- `bed_connect_new` 捕获后按规则退出并返回原话：「您暂未登录您的账号，该服务器为正版服务器，需要官方账号，请补充。」
- RakNet 协议号：jsp-raknet 硬编码 10 改为 11（>=1.19.30 的基岩服要求 11；库 rak.js 也按版本算 11）。
- 真服实测：play.simpfun.cn:14255（LLBDS / BDS 1.20.61，协议649，正版验证）→ 15s 后正确判为正版服并退出提示。离线名硬连会在 network_settings 后卡住（服务端等 Xbox 认证）。

## 1.3.0
- 新增高版本基岩服支持（Bedrock 1.16+ / 协议>=400）：`lib/engineBedrockNew.mjs`，走现成 bedrock-protocol 3.61.0（从 /root/bedrock-bridge/node_modules 动态 import，不塞进插件）。
- 安卓 proot 编不了 C++ binding：`skipPing:true` + `transport:'raknet'` + `raknetBackend:'jsp-raknet'` 绕过 native；prismarine-xbox-services 用离线 stub。
- 新增工具 `bed_connect_new` / `bed_ping_new`。进服遵守 1614 亲定规则：账号用户自己填；正版服未登录官方账号 → 退出并提示「您暂未登录您的账号，该服务器为正版服务器，需要官方账号，请补充。」
- 独立验证：连不存在服务器时正确超时、不崩、无 native 噪音。真服 join/chat 待有服务器实测。

## 1.2.0
- 修复心跳间隔：从 15s 改为 **5s**。根因：服务端 `src/raklib/server/Session.php:142` 是 10s 无收包即 `disconnect("timeout")`，15s 心跳比超时还长等于没保活，导致每 10s 被踢、收不到服务器消息。
- 修复 `bed_map` 工具调用不存在的 `mc.heightmap()` → `mc.heightGrid()`。
- 验证（独立进程 60s）：全程 alive=true、无 Disconnect、聊天广播条条收到、chunks=16。

## 1.1.0
- 新增心跳保活：每 15s 原地 MovePlayer(0x9d) 刷新服务端会话超时，避免闲置被踢
- 新增掉线感知：解析 Disconnect(0x91) + 收包超时看门狗（45s 无数据判定掉线）
- 修复"假在线"：fakebot._client.ended 现跟随引擎存活状态，被踢后 bed_status 如实报 online:false（此前 UDP 无连接，被踢了仍报在线）

## 1.0.0
- 首个可用版本，由 AI 独立完成
- 0.14/协议70 基岩服：RakNet 握手、分片重组、登录、聊天注册/登录、发命令
- 完整工具集 bed_*（21 个）：状态/聊天/命令/地形/挖建/方块实体
- 服务器别名 + 自然语言直连
- 自带 Vec3/BotCore/Chunk/NBT，完全独立于 whale_craft
- 修复：DATA_PACKET 0x80-0x8f 全处理（曾导致收不到聊天）、START_GAME 偏移、reliability=0 解析、resolve 未定义导致的宿主崩溃
