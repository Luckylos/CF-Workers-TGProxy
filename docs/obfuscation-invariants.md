# obfuscation 中继的不变量

Worker 在每条 lane 上做两件事：解开客户端的 obfuscated2 传输层，再用新生成的 64 字节头和新密钥重新加一层，发往 Telegram DC。实现在 `mkStream`（`start` / `feed` / `write` / `pump`），以及 `cipher`、`mkCtr`、`step`、`headOf`、`mkHead`、`wireHead`、`mkPkt`、`getKey`。

下面这些不变量来自一次离线往返验证：49 个用例，覆盖 ef / ee / dd 三种模式、DC ±1..5、头和数据包被任意切分、超过 `upPack` 的聚合，以及非法输入。重构这部分代码时，必须继续满足这些不变量。

## 不变量

1. **计数器连续。**
   - `cIn` 先解密 64 字节客户端头，计数器前进 4 个块，之后同一个实例继续解密数据。
   - `kOut` 必须是 `wireHead` 返回的实例，它已经越过 DC 侧头的 64 字节。
   - `cOut`（`cipher(raw, secret, true)`）和 `kIn`（`cipher(head, nil, true)`）从 0 开始。
   - 任何地方重建 cipher 实例，都会让流错乱。
2. **DC 侧头的格式。**
   - 前 56 字节是明文，只有 `[56..64)` 是密文。
   - 派生密钥不带 secret。
   - 头里保留客户端头中的模式，以及带符号的 DC（负数表示媒体）。
3. **每个 `mkCtr` 实例只能串行调用。**
   - `crypt` 先 await，再更新 iv 和 tail，并发调用会错乱。
   - 上行靠 `chain` 串行，下行靠单个 `pump` 循环串行。
4. **加密覆盖的范围。**
   - `cIn` 按顺序解密收到的全部字节，包括 `mkPkt` 暂存的半包。
   - `kOut` 只加密真正转发出去的字节，也按顺序。
   - 聚合多个包时，依赖同一次 `push` 返回的包在同一块 buffer 里连续。
5. **`push` 的返回值。**
   - DC 已关闭时返回 `false`，调用方此时不归还上行窗口。
   - 头没收齐，或者写入成功，返回 `undefined`。
   - `mkSession` 用 `accepted === false` 区分这两种情况，不能把它们合并。
6. **失败后的行为。**
   - 一次失败后，链上后续的 `push` 全部被拒绝。
   - `mkStream` 自己不会因为 `push` 失败而关闭，关闭由 `mkSession` 在 reject 分支里调用 `st.proxy.close()` 完成。
   - `onClose` 恰好触发一次。
7. **模式只由客户端头决定。** secret 的 `dd` / `ee` / `ef` 前缀只会被剥掉，不参与选择模式。

## `start()` 的调用顺序

```text
cIn.crypt(raw) → headOf → mkHead → cipher(…, reverse) / wireHead / cipher(head, nil, true)
  → dial → 赋值 peer / cIn / cOut / kOut / kIn / pkt
  → await peer.write(DC 侧头) → init = true → pump()
```

最容易出错的地方：

- DC 侧头必须先于任何数据写出。
- `init` 必须在写完头之后才置位。
- `pump` 必须在 `kIn` 赋值之后才启动。
- `feed` 要等 `start()` 完成后，再写入剩余字节。
- `close()` 会把这些字段置空，所以每个 await 之后都要检查 `closed`。

## 已知的边界行为

以下三点不影响正常连接，暂时不改。

- 计数器到 2¹²⁸ 时抛错，不回绕。客户端 iv 是随机的，几乎不可能撞上；真撞上时会关闭连接，不会静默错乱。
- ee、dd 模式接受长度不是 4 的倍数的包。还没核实标准实现是否要求 4 字节对齐。
- secret 带 `ee` 前缀时，在标准 MTProxy 里表示 fake-TLS。本实现只剥掉前缀，客户端兼容性没有验证。
