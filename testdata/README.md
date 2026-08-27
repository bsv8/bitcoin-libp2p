# 测试向量字段说明

`webrtc-direct-endpoint-v1.json` 是 Go 和 TypeScript endpoint 测试共同读取的
唯一向量。JSON 顶层的 `field_comments_zh` 记录字段中文含义；其中：

- `certhash` 是完整的 multibase-multihash 字符串，规范输出统一为无填充
  `base64url`（`u` 前缀）。
- `certhash_digest_hex` 是 multihash 头部之后的 SHA2-256 digest，不是证书原文。
- `public_key_hex` 是压缩 secp256k1 公钥，不是私钥。
- 向量不包含私钥；所有 key/PeerId 只用于 TEST-ONLY 的身份关系校验。
- `invalid.expected_error_code` 和 `expected_stage` 是稳定控制流字段，不依赖
  Go/Node 的英文错误文本。
