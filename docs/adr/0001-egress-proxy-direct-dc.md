---
status: accepted
---

# 出站代理只提供 TCP 隧道，经代理直连 Telegram DC

配置出站代理后，Worker 通过 SOCKS5 或 HTTP CONNECT 打开到 Telegram DC 的 TCP 隧道，发送 MTProto obfuscated2 数据，不再连接 KWS。曾改为经代理访问 KWS 以免维护 DC 地址表（见 [0002](0002-egress-proxy-kws.md)），但那要在 Worker 里实现 TLS 和 WebSocket 客户端，复杂度远大于一张 5 项、多年稳定的地址表；在服务器上运行服务端的方案因出口只是第三方代理账号而不可行。

## Consequences

- 代码内置 DC1–5 地址表；Telegram 调整地址时需更新并重新部署。
- 出站代理与 KWS 二选一：配置代理即全部走代理，失败不回退 KWS。
- 固定连接单个 DC（如 DC5）不能替代其他 DC 的授权与媒体连接，不采用。
