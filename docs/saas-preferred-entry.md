# 优选入口与 Cloudflare for SaaS

客户端到 Cloudflare 的线路质量取决于它落到哪个边缘节点。用优选 IP / 优选域名接入，可以让客户端连到延迟更低的节点。这份文档记录两种做法、验收方式，以及各自的代价。

术语见 [GLOSSARY.md](../GLOSSARY.md)（**优选入口**、**入口主机名**）。

## 先理解约束

Cloudflare 边缘收到请求后，按**访问的主机名**决定交给谁处理；请求打到哪个 Cloudflare IP 不影响这个判断。所以：

- 优选 IP 只决定「连到哪个节点」，它不会让 Cloudflare 认出你的主机名。
- 这个主机名必须先在 Cloudflare 上登记过（被代理的 DNS 记录、Worker 自定义域名、或 SaaS 自定义主机名三者之一），否则直接报错。

实测：把三个主机名都强制解析到同一个优选 IP 访问 —— 已登记的返回正常内容，未登记的返回 `530` / 错误码 `1016`。

由此产生一个矛盾：入口域名的 DNS 若托管在 Cloudflare，**开代理**能接入但解析结果是 Cloudflare 自动分配的 IP（做不了优选）；**关代理指向优选 IP** 则需要另一种方式让 Cloudflare 仍然认识这个主机名。

## 三种做法对比

| 方式 | 需要的配置 | 优选 IP 来源 | 何时失效 |
| --- | --- | --- | --- |
| **Worker 自定义域名** | 控制台绑定域名 | 无（Cloudflare 自动分配） | 不适用 |
| **SaaS 自定义主机名** | 两个域名 + 自定义主机名 + 验证 TXT + 一条 Worker 路由 | 第三方优选域名（CNAME 目标） | 第三方优选域名停止维护 |
| **灰云 A 记录 + Worker 路由** | 一条 A 记录 + 一条 Worker 路由 | 自选（可用自己的测速结果） | Cloudflare 改变边缘路由行为时 |

方式二、三均已实测可用。方式三是 Cloudflare 文档未描述的写法，属于未文档化行为。

---

## 方式一：SaaS 自定义主机名（官方支持）

需要两个域名：

- **SaaS zone**：一个已托管在 Cloudflare 的域名，记作 `zone-a.com`。
- **入口域名**：客户端实际填写的域名，记作 `zone-b.net`。它的 DNS 可以在任意服务商（也可以在 Cloudflare）。

### 1. 在 SaaS zone 设置 fallback origin

在 `zone-a.com` 下建一条 originless 记录并设为 fallback origin：

| 类型 | 名称 | 内容 | 代理 |
| --- | --- | --- | --- |
| `AAAA` | `fallback` | `100::` | 已代理（橙云） |

然后在控制台的 `zone-a.com` → SSL/TLS → Custom Hostnames 里把 `fallback.zone-a.com` 设为 fallback origin。它只是占位，流量最终会交给 Worker。

### 2. 给 Worker 加路由

在 `zone-a.com` 上加一条路由，**只针对入口主机名**：

```text
entry.zone-b.net/*   →  你的 Worker
```

> 不要用 `*/*`。那会把 `zone-a.com` 上其他自定义主机名的流量也拉进这个 Worker，绕过它们原本的 origin。

### 3. 添加自定义主机名

在 `zone-a.com` 的 Custom Hostnames 里添加 `entry.zone-b.net`，证书参数：

| 项 | 值 |
| --- | --- |
| 验证方式 | `txt`（因为下面 CNAME 指向别的域名，CNAME 验证不会成功） |
| 类型 | `dv` |
| min TLS | `1.2` |
| bundle | `ubiquitous` |
| wildcard | 否 |

### 4. 放验证 TXT 记录

进入 `pending_validation` 后，Cloudflare 会给出两条 TXT。把它们加到**入口域名所在的 zone**（这里是 `zone-b.net` 的 DNS）：

| 名称 | 内容 |
| --- | --- |
| `_cf-custom-hostname.entry.zone-b.net` | 所有权验证值 |
| `_acme-challenge.entry.zone-b.net` | 证书验证值 |

> 这两条必须手动添加。因为入口主机名的 CNAME 指向的是第三方优选域名，Cloudflare 无法通过 CNAME 自动完成验证。

### 5. 等验证通过

轮询自定义主机名状态，直到 `status` 与 `ssl.status` 都是 `active`。验证期间可能长时间显示：

```text
custom hostname does not CNAME to this zone.
```

这是预期的，TXT 放好后会自己变绿（实测约 90 秒到 2 分钟）。

### 6. 指向优选 IP

在入口域名的 DNS 处：

| 类型 | 名称 | 内容 | 代理 |
| --- | --- | --- | --- |
| `CNAME` | `entry` | 第三方优选域名（例如 `saas.example-cdn.net`） | **仅 DNS（灰云）** |

也可以用 `A` 记录直接指向优选 IP。

> **如果入口主机名原先已绑定 Worker 自定义域名，必须先删除那个自定义域名**，否则同名 CNAME 加不上（DNS 冲突）。删掉自定义域名后，这个主机名改由第 2 步的 Worker 路由接管，访问行为不变。

### 7. 验收

```bash
# 1. 解析链路
dig +short entry.zone-b.net
# 期望：CNAME 指向第三方优选域名，最终是 Cloudflare 的 IP

# 2. 服务可用
curl https://entry.zone-b.net/health
# 期望：返回 ok:true

# 3. 证书
echo | openssl s_client -servername entry.zone-b.net -connect entry.zone-b.net:443 2>/dev/null | openssl x509 -noout -subject -issuer
```

最后用 Telegram 客户端实测登录、收发消息、加载媒体。

### 注意事项

- SaaS zone 可能在页面里注入 Cloudflare 的 challenge 脚本。桥接页面自带严格 CSP 会拦住它，功能不受影响，浏览器控制台可能出现一条 CSP 报错。
- 免费套餐提供一定数量的自定义主机名额度。
- 优选效果取决于**第三方优选域名的线路**，不在你的控制范围内。

---

## 方式二：灰云 A 记录 + Worker 路由

不需要 SaaS，也不需要第二个域名。前提是入口域名的 DNS **托管在 Cloudflare**（因为要用 Worker 路由）。

### 1. 加 A 记录

在入口域名所在的 zone 下：

| 类型 | 名称 | 内容 | 代理 | TTL |
| --- | --- | --- | --- | --- |
| `A` | `entry` | 优选 IP | **仅 DNS（灰云）** | 60 |

### 2. 加 Worker 路由

在同一 zone 下加路由：

```text
entry.zone-b.net/*   →  你的 Worker
```

写进 `wrangler.toml` 后重新部署会自动带上去：

```toml
routes = [
  { pattern = "entry.zone-b.net/*", zone_name = "zone-b.net" },
]
```

### 3. 验收

同方式一的第 7 步。实测结果：

| 检查 | 结果 |
| --- | --- |
| 公共 DNS | 返回配置的优选 IP |
| `/health` | `200` + `ok:true` |
| 证书 | 该 zone 自己的证书（例如 `CN = zone-b.net`，Google Trust Services），校验通过 |
| Telegram lane 端到端 | DC1–5 与媒体 DC 全部握手成功 |

### 风险与代价

- **未文档化**：Cloudflare 文档写的是 Worker 路由需要配合**已代理**的 DNS 记录。灰云能用是实测结果，平台行为变化时可能失效。想降低风险，可以同时保留一个 SaaS 入口。
- **IP 需要自己维护**：优选 IP 变化时不会自动更新。如果用自己的测速流程挑选 IP，需要把「更新这条 A 记录」接进流程，或手工更新。
- **证书**：用的是该 zone 的 Universal SSL。该 zone 若关闭了 Universal SSL 或证书未签发，会失败。


---

## 与自建测速流程联动

如果用自建测速挑选 IP，典型的接线方式是：

1. 测速流程产出排名结果（例如一个 IP 列表）。
2. 取排名第一（或按运营商分组取第一个）的 IP。
3. 通过 Cloudflare API 更新方式二那条 A 记录：

```bash
curl -X PATCH "https://api.cloudflare.com/client/v4/zones/ZONE_ID/dns_records/RECORD_ID" \
  -H "Authorization: Bearer CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"content":"NEW_IP"}'
```

4. TTL 建议设小（如 60），便于回退。

用到的 API Token 只给该 zone 的 `DNS Edit` 权限即可，不要复用其他用途的 token。

## 排查

| 现象 | 原因 |
| --- | --- |
| `530` / 错误码 `1016` | 主机名没有在 Cloudflare 登记（缺自定义主机名，或缺 Worker 路由） |
| `522` | 路由匹配到了，但 fallback origin / origin 不可达 |
| 一直显示证书 `pending_validation` | 两条验证 TXT 没放，或放在错误的 zone 上 |
| 解析不到优选 IP | 用的是已代理（橙云）记录，Cloudflare 会覆盖解析结果 |
| 加 CNAME 时提示冲突 | 该主机名仍绑着 Worker 自定义域名，需先删除 |
| 客户端一直「连接中」 | 填成了 `tg://proxy`；应使用 `tg://webproxy`（见 [README](../README.md)） |

