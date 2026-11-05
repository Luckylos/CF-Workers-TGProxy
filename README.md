# CF-Workers-TGProxy（二开版）

Cloudflare Workers 上的 Telegram Web Proxy（td web-proxy）后端，单文件实现：把 Telegram Desktop / Android 在隔离 webview 里发起的 WebSocket lanes，转接到 Telegram。

本仓库是 [ToiCF/CF-Workers-TGProxy](https://github.com/ToiCF/CF-Workers-TGProxy) 的 fork（[Luckylos/CF-Workers-TGProxy](https://github.com/Luckylos/CF-Workers-TGProxy)），在上游「KWS 转换」主线之上增加了**出站代理**，并修复了一批**长连接与下行性能**问题。上游的传输层转换设计、CSP 页面、lane 模型均保留，本文档按二开后的实际行为重写。

## 这个 fork 改了什么

| 改动 | 说明 | 落点 / 依据 |
| --- | --- | --- |
| **出站代理** | 新增可选 Secret `PROXY`。配置后所有 lane 经 SOCKS5 / HTTP CONNECT 代理用 TCP 直连 Telegram DC，不再连 KWS；不配置则行为与上游一致 | `dialProxy` / `dialRetry` / `mkTcp` / `parseProxy`、[ADR-0001](./docs/adr/0001-egress-proxy-direct-dc.md) |
| **下行合包统一** | 合包（`mkPack`）上移到 `dial` 之上，KWS 与代理两条路径共用；同一时刻只有一个未完成的读取，保留 TCP 背压。此前代理路径每个 TCP chunk 都单独成一帧 | `mkPack`、`dial`；本地 workerd 实测下行消息数约降为 1/8 |
| **session token 自动刷新** | 桥接页面每 3 分钟用当前 token 换新 token（失败 15 秒后重试）。修复「5 分钟后新 lane 鉴权失败 → 整个页面断开」 | `mkPage` 的 `renew`、`POST /api/v1/session` |
| **`mkHead` 排除规则补齐** | 生成发往 DC 的 64 字节头时，一并排除 `eeeeeeee` / `dddddddd` / TLS 头（`16030102`），与主流 MTProxy 实现一致 | `badHead` |
| **lease 上限统一** | `DELETE /api/v1/session` 与 `/api/v1/ws` 共用过期清理与 4096 上限，满时返回 `503` | `getLease` |
| **关闭 WebSocket 压缩** | 部署配置加 compatibility flag `no_web_socket_compression`。上游在 101 响应里放空的 `Sec-WebSocket-Extensions` 头，实测关不掉压缩（`compatibility_date` ≥ 2023-08-15 时 runtime 默认协商 permessage-deflate）；中继数据是密文压不动，本地 workerd 实测下行 CPU 约 51 → 10.5 ms/MB | `wrangler.toml` 的 `compatibility_flags` |
| **出站代理改用 BYOB 读** | 握手完成后，TCP adapter 每次给 runtime 一块 32KB 的新缓冲读取，减少 `read()` 次数和合包开销；socket 不是字节流时沿用默认 reader。本地 workerd 实测连续下行 CPU 约 10.2 → 4.5 ms/MB | `toByob`、`mkTcp` |
| **离线测试** | 新增 `test/`，Node 内置 `node:test`，**零依赖** | `node --test test/*.test.mjs` |
| **文档** | 术语表、ADR、obfuscation 不变量、SaaS 优选教程 | [GLOSSARY.md](./GLOSSARY.md)、[docs/](./docs) |

未改动的部分：`SECRET` / `BOOT` 的用途与格式、页面 CSP 与隔离、lane 子协议、上行合包、token/lease 的 HMAC 方案。

## 核心能力

- td web-proxy 页面：nonce + 严格 CSP，仅允许 `frame-ancestors http://127.0.0.1:*`
- Android 应用内 web-proxy 桥（`globalThis.TelegramWebProxy` 双向 postMessage）
- 多 lane WebSocket 复用：子协议 `tproxy-lane-v1.<token>.<sid>`
- MTProto 传输层 obfuscation 重签（mode `0xef` / `0xee` / `0xdd`，DC `1..5`，media 标志）
- 两种出站：直连 Telegram KWS，或经出站代理 TCP 直连 Telegram DC
- HMAC 签名的 bootstrap / session token，以及按会话的 lease 记账
- 上行 / 下行小包汇聚（`upPack = 20KB`、`dnPack = 32KB`、`dnMs = 1ms`）
- 关闭 WebSocket 压缩（compatibility flag `no_web_socket_compression`）

内层 MTProto 载荷始终由客户端端到端加密，Worker 不接触、也不做 mtp 层加解密。

## 代码主路径

```mermaid
flowchart LR
  TG["Telegram Desktop / Android"] -->|webview 加载 web-proxy 页面| P["Worker 页面 (nonce CSP)"]
  P -->|postMessage 端口| L["lanes: 每条流一条 WebSocket"]
  L -->|"tproxy-lane-v1.token.sid"| WS["/api/v1/ws"]
  WS --> S["mkSession → mkStream"]
  S -->|"解 obfuscation (AES-CTR)"| RK["mkHead 重新封层"]
  RK --> PK["mkPack 下行合包"]
  PK --> D{"dial"}
  D -->|"未配置 PROXY"| KWS["wss://kwsN[-1].web.telegram.org/apiws"]
  D -->|"配置 PROXY"| DC["SOCKS5 / HTTP CONNECT 代理 → Telegram DC1-5:443 (obfuscated2)"]
```

```text
webview 页面
  → 建立 /api/v1/session（POST，带 bootstrap）
  → 拿到 session token + X-Carrier-Mode: websocket-lanes（此后每 3 分钟自动续期）
  → 按流开 lane：/api/v1/ws + 子协议 tproxy-lane-v1.<token>.<sid>
  → Worker: 解 obfuscation → 重新封头 → dial（KWS 或出站代理）→ 中继
```

## 部署教程

### 0. 前置条件

- Node.js ≥ 20（`node --version`）
- 一个 Cloudflare 账号，且有一个**已托管在 Cloudflare 的域名**（下面记作 `example.com`）
- Telegram 客户端需支持 **WEB proxy**（较新版本的 Desktop / Android）

### 1. 安装并登录 wrangler

```bash
npm i -g wrangler
wrangler login
```

### 2. 生成密钥

```bash
openssl rand -hex 16   # SECRET：客户端链接里要用，务必保存好
openssl rand -hex 24   # BOOT：只给 Worker 自己用，不需要告诉别人
```

### 3. 写 `wrangler.toml`

```toml
name = "tgproxy"
main = "telegram_webproxy.js"
compatibility_date = "2025-06-01"
compatibility_flags = ["no_web_socket_compression"]

routes = [{ pattern = "tg.example.com/*", zone_name = "example.com" }]
```

`compatibility_flags` 这一行不要省略，原因见「设计摘要 → 关闭 WebSocket 压缩」。在控制台部署时，到 Worker 的 Settings → Compatibility flags 里手动添加 `no_web_socket_compression`。

`pattern` 里的主机名就是客户端将来填写的**入口主机名**。若域名不在 Cloudflare，或想走优选 IP，见 [SaaS 优选入口教程](./docs/saas-preferred-entry.md)。

### 4. 部署

```bash
wrangler deploy
printf 'YOUR_SECRET\n' | wrangler secret put SECRET
printf 'YOUR_BOOT\n'   | wrangler secret put BOOT
```

> 也可以把 `SECRET` / `BOOT` 写进普通环境变量，但 Secret 更合适：它在控制台不可见，也不会被下次 `deploy` 覆盖。

### 5. （可选）配置出站代理

```bash
printf 'http://user:pass@proxy.example:8080\n' | wrangler secret put PROXY
```

不配置就直连 Telegram KWS；配置后所有 lane 改走代理直连 Telegram DC。详见下文「出站代理」。

### 6. 验证

```bash
curl https://tg.example.com/health
# 期望：{"ok":true}
```

返回 `500` 说明 `SECRET` / `BOOT` 缺失，或 `PROXY` 格式非法。`/health` 不探测代理与 Telegram 是否可达。

### 7. 客户端链接

链接必须是 **WEB proxy** 类型：

```text
tg://webproxy?server=tg.example.com&secret=YOUR_SECRET
```

等价写法：`https://t.me/webproxy?server=tg.example.com&secret=YOUR_SECRET`。

> **不要用 `tg://proxy`**。那是普通 MTProxy 链接，客户端会直接对 443 端口发原始 MTProto 数据，而 Cloudflare 边缘只接 HTTPS —— 表现是一直卡在「连接中」。

## 配置

### 环境变量 / Secret

| 绑定 | 必填 | 意义 | 格式 |
| --- | --- | --- | --- |
| `SECRET` | 是 | AES-CTR 传输密钥派生 + `?bridge=` 能力签名；也是客户端链接里的 secret | `32` 位 hex，或 `dd` / `ee` / `ef` 前缀 + 32 位 hex（共 `34`）；字符集 `0-9a-f`，大小写不敏感 |
| `BOOT` | 是 | 签发 bootstrap / session token，并内联进下发页面 | 非空即可，建议 ≥ 16 字符随机串 |
| `PROXY` | 否 | 出站代理 | `socks5://[user:pass@]host[:port]`（默认 `1080`）或 `http://[user:pass@]host[:port]`（默认 `80`）；用户名/密码需 URL 编码；`#` 之后的内容会被忽略，可用来写备注 |

任一必填项缺失或 `PROXY` 非法时，`mkCfg` 抛错，`/health` 返回 `500`。

### 代码内常量

| 变量 | 意义 | 值 |
| --- | --- | --- |
| `dnPack` | 下行聚合上限 | `32 * 1024` |
| `upPack` | 上行合包目标 | `20 * 1024` |
| `dnMs` | 下行 quiet-window | `1`（ms） |
| `PROXY_MS` | 代理握手超时 | `7500`（ms） |
| `DC_PORT` | Telegram DC 端口 | `443` |
| lane 上限 | 单会话并发 lane 数 | `128` |
| `laneMax` / `laneItems` | 单 lane 字节 / 条数上限 | `8MB` / `1024` |
| `qMax` / `iMax` | 整会话字节 / 条数上限 | `32MB` / `16384` |
| bootstrap TTL | 接入 token | `2` 分钟 |
| session TTL | 会话 token | `5` 分钟 |
| 刷新间隔 | 页面自动续期 | `3` 分钟（失败重试 `15` 秒） |
| KWS 端点 | 未配置 `PROXY` 时的出站 | `kws{1..5}[-1].web.telegram.org/apiws` |

### HTTP 接口

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| `/` | `GET` | 校验 `?bridge=` 签名后下发 web-proxy 页面；签名不符则返回通用占位页 |
| `/health` | `GET` | 仅检查配置是否合法 |
| `/api/v1/session` | `POST` | 用 bootstrap（或仍有效的 session token）换取新 session token |
| `/api/v1/session` | `DELETE` | 注销当前 session 的 lease |
| `/api/v1/ws` | `GET` | lane WebSocket，子协议 `tproxy-lane-v1.<token>.<sid>` |

## 出站代理

配置 `PROXY` 后，**所有 lane** 不再连接 KWS，而是经该代理用 TCP 直连 Telegram DC：

```text
Worker → (cloudflare:sockets connect) → SOCKS5 / HTTP CONNECT 代理 → Telegram DC{1..5}:443（MTProto obfuscated2）
```

- 支持 SOCKS5（无认证 / 用户名密码）和 HTTP CONNECT（可选 Basic 认证）。不支持 SOCKS4、UDP、HTTPS 代理。
- DC 地址表内置在代码 `DCS` 中（仅 IPv4，与主流 MTProxy 实现一致）；媒体连接与普通连接使用同一 DC 地址。Telegram 调整地址时需改代码重新部署。
- 代理连接、认证或 CONNECT 失败、或 7.5 秒内未完成握手时，直接关闭该 lane，由客户端重连；**不回退到 KWS**。
- 代理不能位于 Cloudflare IP 段内（Workers TCP Socket 的限制）。
- 未配置 `PROXY` 时行为与上游一致。

> **风险**：Worker 到代理之间是明文 TCP，SOCKS5 / HTTP Basic 的**用户名和密码会以明文经过公网**。Telegram 数据本身仍是加密的。请给代理单独设置强密码，不要复用其他账号凭据。Workers 出口 IP 不固定，代理端 IP 白名单只能放行 Cloudflare 出口段，效果有限。

设计取舍见 [ADR-0001](./docs/adr/0001-egress-proxy-direct-dc.md)。

## 优选入口

客户端到 Cloudflare 的线路质量取决于落到哪个边缘节点，用优选 IP / 域名接入可以改善。两种做法：

| 方式 | 需要的配置 | 优选 IP 来源 | 说明 |
| --- | --- | --- | --- |
| **Worker 自定义域名** | 一条路由 + 控制台绑定域名 | 无（Cloudflare 自动分配 IP） | 最简单，但做不了优选 |
| **SaaS 自定义主机名** | 两个域名 + 自定义主机名 + 验证 TXT | 第三方优选域名 | 官方支持的做法，见下方教程 |
| **灰云 A 记录 + Worker 路由** | 一条 A 记录 + 一条路由 | 自选 | 实测可用，但 Cloudflare 文档未描述此写法，可能变化 |

完整步骤、验收方法和注意事项见 [docs/saas-preferred-entry.md](./docs/saas-preferred-entry.md)。

补充：`?bridge=` 签名按**访问时的主机名**计算，所以换任何入口主机名都不需要改代码。

## 设计摘要

### 1. 按流拆 lane

每条 Telegram 流 = 一条独立 WebSocket，子协议里带 `sid`。所有 lane 落在同一个 isolate，session / lease 状态是 isolate 内的 `Map`。TG 客户端本身多流且会自动分流，因此 lanes 让每条流各自背压、各自排队，而不是把整条会话压进一个单线程对象。

### 2. 小包汇聚

```text
上传: collect -> bundle -> peer.write()
下载: collect -> bundle -> dnPack 门控 -> ws.send()
```

`upPack = 20KB` 是上行合包目标；`dnPack = 32KB` 是下行聚合上限，`>= 32KB` 直接发，`< 32KB` 等 `dnMs = 1ms` 的 quiet-window 再 flush。合包在 `dial` 之上实现一次，两条出站路径共用。

### 3. 鉴权与租约

- 页面只下发短期 bootstrap（`mkBoot`，2 分钟）
- `POST /api/v1/session` 校验 bootstrap 后签发 session token（`mkSess`，5 分钟），也接受仍有效的 session token 续期
- 每个 session token 对应一份 `lease`，记录 `active` / `used` sid、过期与删除状态；`DELETE` 置 `deleted`
- token 是 HMAC-SHA256 截断签名，签名与比较走常量时间

### 4. 页面隔离

- CSP：`default-src 'none'`、`sandbox allow-same-origin allow-scripts`、`frame-ancestors http://127.0.0.1:*`
- `/api/v1/ws` 若带 `Origin` 头，必须与自身同源，否则拒绝

### 5. 关闭 WebSocket 压缩

中继传的是 obfuscation 后的密文，permessage-deflate 压不动，只白白消耗 CPU。本地 workerd 实测：协商压缩时下行约 51 ms CPU/MB，关闭后约 10.5 ms/MB。Free 套餐每次调用（即每条 lane）只有 10 ms CPU，这个差距直接决定一条 lane 传多少数据会被平台结束。

关闭方式是 compatibility flag `no_web_socket_compression`，它同时作用于入站 lane 和 KWS 路径的出站 `new WebSocket()`。在 101 响应里放空的 `Sec-WebSocket-Extensions` 头没有用：`compatibility_date` ≥ 2023-08-15 时 runtime 默认协商压缩，并忽略这个空头。见 [Compatibility flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/)。

验证方法：客户端在升级请求里带 `Sec-WebSocket-Extensions: permessage-deflate`，101 响应里不应出现该头。

## 测试

```bash
node --test test/*.test.mjs
```

- `test/proxy.test.mjs`：`parseProxy`、`mkCfg`、`dcAddr`、SOCKS5 / HTTP CONNECT 握手、认证失败、超时、取消、握手后双向转发
- `test/fixes.test.mjs`：下行合包（`mkPack`）、`mkHead` 排除规则、lease 上限、token 续期；桥接页面的续期逻辑在 `vm` 里真实运行页面脚本验证
- `test/load.mjs`：测试用加载器，把 `cloudflare:sockets` 替换为 `node:net` 实现并导出内部符号

仅依赖 Node 内置模块。真实 Telegram 连接、真实代理线路、Cloudflare 平台行为需要部署后验收。

传输层转换的不变量（重构时必读）见 [docs/obfuscation-invariants.md](./docs/obfuscation-invariants.md)。

## 已知问题与限制

- **lane 建立偶发失败**：第三方代理线路丢包时，约 1/8 的 lane 会在 7.5 秒超时后失败（客户端自行重连）。曾尝试在代理上重试一次，实测无效——同一次请求的两次尝试走同一出口，会一起失败——已回退。
- **`authBoot` 接受原始 `BOOT`**：`v === boot` 的判断让 `BOOT` 成为长期有效凭据，且不是常量时间比较。
- **KWS 路径下行无背压**：`mkWire` 的接收队列在客户端不续窗口时会持续增长（代理路径走 TCP，有天然背压）。
- **页面缓冲满即整体断开**：全会话队列达上限时 `fail()` 会断开整个页面，而不是只对单个 lane 施加背压。
- **状态是 isolate 内的**：`leases` / `macKeys` 是模块级 `Map`，无 Durable Object；注销与配额只按 isolate 生效。
- **`/health` 不探测上游**：只验证配置。

## 目录结构

```text
telegram_webproxy.js              单文件 Worker（唯一部署产物）
test/                             离线测试（node:test，零依赖）
GLOSSARY.md                       领域术语表
docs/adr/                         架构决策记录
docs/obfuscation-invariants.md    传输层转换不变量
docs/saas-preferred-entry.md      SaaS 优选入口教程
```

## 许可

沿用上游 [LICENSE](./LICENSE)。
