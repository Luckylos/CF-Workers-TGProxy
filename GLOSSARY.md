# CF-Workers-TGProxy

运行在 Cloudflare Workers 上的 Telegram web-proxy 中继：客户端通过 Worker 的桥接页面和 WebSocket 接入，Worker 再把数据转发到 Telegram。

## 入口

**桥接页面**:
Telegram 客户端用来接入此代理服务的网页，连接客户端与服务的传输通道。
_Avoid_: 前端、Web 页面

**Lane**:
Telegram 客户端的一条 MTProto 连接在此服务中对应的独立传输通道。
_Avoid_: 通道、隧道、连接

**入口主机名**:
Telegram 客户端访问此代理服务时使用的主机名。
_Avoid_: 入口域名、前端域名

**优选入口**:
使用经过质量筛选的 Cloudflare 边缘地址接入此代理服务的入口。
_Avoid_: 优选 IP、优选域名（单独使用时）

## 出站

**KWS**:
Telegram 为 Web 客户端提供的、按数据中心区分的 WebSocket 接入端点。
_Avoid_: Telegram 网关

**出站代理**:
位于此代理服务与 Telegram 之间、提供对外连接出口的代理服务器。
_Avoid_: 前置代理、上游代理、中转

**Telegram DC**:
Telegram 按编号区分的数据中心，是客户端账号连接、跨中心操作和文件传输所面向的服务目的地。
_Avoid_: 服务器（未指明数据中心时）

**DC 直连**:
面向 Telegram DC 原生传输端点的连接方式，区别于经 KWS 接入；路径中可以经过出站代理。
_Avoid_: TCP 模式、原生模式
