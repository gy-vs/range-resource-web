# range-resource-web

按字节范围读取资源的断点校验浏览器。浏览器只取用户选中的字节区间，服务端为每个片段附带
**资源版本、内容摘要、实际返回边界与片段校验值**；前端只拼接同版本、摘要验证通过且无缺口的片段。

## 运行

```bash
npm start        # http://localhost:4183
npm test         # node:test — store / 状态机 / HTTP 共 26 个用例
```

页面操作闭环：

1. 输入 `start/end` 打开大资源的中间区间（首次成功片段锚定一个版本 anchorVersion）
2. **Read before / Read after** 继续读相邻区间，请求自动带 `expectedVersion=<anchor>`
3. 在 **Server-side mutation** 区点 `PUT updated content` 或 `DELETE resource`
4. 更新后再读相邻区间 → 得到 **conflict 标记**（v旧→v新），不会被拼接
5. **Re-select at latest** 回读旧区间 → 新区间作为独立 "other version" 轨道显示，旧片段保留可比较
6. **Adopt new version** 切换锚版本；**Retry failed** 重试失败请求；**Cancel pending** 取消在途请求

页面分三层解释结果：

- **Tracks**：窗口内每个出现过的版本一条轨道；anchor 轨道是唯一可拼接轨道，
  轨道内的 `gap` 运行明确标出"这些字节该版本没有，必须重新取"
- **Markers**：`conflict`（版本已移动）、`tombstone`（资源已删除，绝不显示为空内容）、
  `integrity`（片段摘要不符或重叠内容矛盾）、`error`（网络失败，可重试）
- **Stitched preview**：只有当整个窗口被 anchor 版本、摘要验证通过的片段连续覆盖时才显示拼接文本，
  否则显示缺口/标记说明

## 范围协议

### 严格范围接口（新）

`GET /api/resources/:id/ranges?start=<int>&end=<int>[&expectedVersion=<v>]`
（也支持 `If-Match: "<v>"`，`end` 为排他边界）

`200`：

```json
{
  "type": "range-fragment",
  "id": "sample",
  "version": 1,
  "start": 400, "end": 460, "size": 16800,
  "contentDigest": "sha256-of-full-content",
  "digest": "sha256-of-just-this-fragment",
  "bytes": "<base64>"
}
```

响应头同时给出 `ETag: "<version>"`、`X-Resource-Version`、`Content-Range: bytes 400-459/16800`、
`X-Fragment-Digest`，调用者据此知道实际返回了哪一段。

- `400 INVALID_RANGE`：边界不是非负整数、end < start（绝不静默夹紧/截断）
- `416 INVALID_RANGE`：end 越过资源大小，带 `Content-Range: bytes */<size>`
- `412 VERSION_CONFLICT`：`expectedVersion` 与当前版本不符；body 只含
  `{expected, actual, size, contentDigest}`，**不泄漏任何新版本字节**
- `404 RESOURCE_NOT_FOUND`：资源不存在或已删除（删除与空内容严格区分）

`PUT /api/resources/:id` 创建新版本（版本单调递增，重建资源从 v1 重新计数）；
`DELETE /api/resources/:id` 删除全部版本痕迹。

### 旧接口（保留）

`GET /api/resources/:id[?start&end]` 仍是原来的宽松夹紧语义（默认 0..1024），
返回 `{id, version, start, end, bytes}`，附加 `size/contentDigest`（增量字段，不破坏原有流程）。

## 前端状态机（`public/range-model.mjs`，DOM 无关）

- 片段按版本分桶保存，不做跨版本合并；重叠的同版本片段按并集覆盖拼接，
  重叠字节必须一致，矛盾时产生 `integrity` 标记
- 每次选择/续读/重试分配递增序号；迟到响应到达时若序号已过期，结果记为 `ignored-stale`
  且**不写入任何片段**（旧请求不可能覆盖新选择）
- 取消通过 `AbortController` 中止在途 fetch；被取消的字节不进入状态
- 网络失败只落 `error(retryable)` 标记，不污染已验证片段；冲突/删除同样只落标记
- 请求历史（序号、版本钉扎、结果）在页面上可观察

## 测试

- `test/resource-store.test.mjs`：版本递增、删除、严格边界、冲突前提、摘要
- `test/range-model.test.mjs`：拼接、重叠合并/矛盾、缺口、版本移动、删除墓碑、
  摘要篡改、迟到响应失效、取消、失败重试、多版本对比轨道
- `test/http-api.test.mjs`：真实 HTTP 状态码、响应头（版本/Content-Range/ETag）、
  412 不泄漏字节、404 与空内容区分、旧接口兼容、静态资源托管
