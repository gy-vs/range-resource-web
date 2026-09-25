# range-resource-web

按字节范围读取资源的演示应用：服务端返回带**资源版本、实际范围边界、校验和**的片段，浏览器端只请求所选区间，并把**同一版本、边界相邻、校验通过**的片段拼成可审阅的局部视图。

## 运行

```bash
npm start        # http://localhost:4183，内置 1000 字节 sample 资源
npm test         # node --test（存储层 / 前端状态机 / HTTP 协议共 31 个测试）
```

## 范围协议

### `GET /api/resources/:id/range?start=<字节>&end=<半开字节>&version=<可选>`

- `end` 必填（半开区间 `[start, end)`），避免调用方误把局部当整体；
- `206 Partial Content` + 响应头/体：
  - `Content-Range: bytes 400-499/1000`
  - `X-Resource-Id` / `X-Resource-Version`
  - `X-Range-Start` / `X-Range-End`（**实际返回**的边界，越界请求会被夹紧）
  - `X-Fragment-Checksum`：`sha256("range-resource-web:" id ":" version ":" start ":" end ":" bytes)`，覆盖 id、版本、边界、字节；
- `409 VersionConflictError`：带 `version=<v>` 的条件读取与当前版本不符（读取期间资源被更新），响应体只有 `{expectedVersion, currentVersion}`，**不携带任何字节**；
- `404`：资源不存在或已删除，不能被伪装成空片段；
- `416`：区间与资源完全无交集，响应体带 `size`，头为 `Content-Range: bytes */<size>`；
- `400`：缺 `end`、`start > end`、非整数。

### 旧接口保持可用

- `GET /api/resources/:id`：完整读取（200，`complete: true`，整段校验和）——只用于对照，不参与片段拼接；
- `GET /api/resources/:id?start=&end=`：旧的范围调用方式继续工作；
- `PUT /api/resources/:id`：版本单调 +1；`DELETE`：删除内容与版本，重建后从 v1 开始。

## 前端状态机（`public/reader.mjs`，可被 node 直接测试）

- 片段按 `(id, version)` 分版本视图保存，**不同版本的字节永不拼接**；
- 入库前复算校验和，校验失败只记入失败记录，不渲染任何内容；
- 同版本片段合并：相邻 → 连续块；重叠 → 逐字节比对，一致才合并并记录双来源，不一致则标红为重叠冲突并拒绝合并；
- 块之间的缺口显式列出，可按当前版本补取；
- 每次重新选择区间都会 abort 在途旧请求；abort 拦不住的"晚到响应"即使校验通过也只标记为历史片段，不覆盖当前选择；
- 资源更新后继续读取得到 409：页面提供「跟随最新版本（另立视图重读）」和「保留旧版本视图」两个明确选择；
- 可钉定（pin）历史版本切回旧区间比较，命中已校验片段时不发请求；404 删除是独立的缺失状态，不是空内容。

页面操作顺序：打开资源 → 输入 start/end 读取中间区间 →「读前/后一段」延伸 → 在页面里用 PUT 更新资源 → 再延伸时看到 409 横幅与版本隔离 → 切回旧版本比较。
