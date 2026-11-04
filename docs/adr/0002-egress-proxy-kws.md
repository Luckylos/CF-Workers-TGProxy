---
status: superseded by ADR-0001
---

# 经出站代理访问现有 Telegram KWS 域名

为让 Telegram 连接经由运营者配置的出口，同时避免维护 DC IP 表，暂定保留现有按 DC 编号和媒体标识选择 KWS 域名的路由，通过 HTTP CONNECT 或 SOCKS5 请求代理连接该域名，由代理解析其地址。与 [DC 原生 TCP 端点方案](0001-egress-proxy-direct-dc.md) 相比，此方案保留现有 Telegram 接入端点，但需要在代理隧道中完成面向 KWS 主机名的 TLS 握手与证书校验，以及 WebSocket 握手和帧处理，Cloudflare 平台能力仍待核实与运行验证。用户已初步采纳此方向；它不代表一个任意 Telegram 服务器会自动转发所有 DC 流量，也不代表实现已获最终确认。
