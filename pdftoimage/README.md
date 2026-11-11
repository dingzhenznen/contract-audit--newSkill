# PDF → Image 服务

基于 Express + `pdf-to-img`（pdf.js + `@napi-rs/canvas`）的 PDF 转图片服务，纯 JS 实现，无需安装 poppler / ImageMagick / Ghostscript。

## 启动

```bash
npm install
npm start          # http://localhost:3000
npm run dev        # 带 --watch 的开发模式
npm test           # smoke 测试（会临时监听 3998/3999）
```

打开 `http://localhost:3000` 有可视化测试页面。

## API

### 转换

```bash
curl -s -X POST http://localhost:3000/api/convert \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com/a.pdf","scale":2,"format":"png"}'
```

也支持 GET：`/api/convert?url=https://example.com/a.pdf&scale=2&format=png&pages=1-3,5`

参数：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `url` | 必填 | 可公开访问的 http/https PDF 链接 |
| `scale` | `2` | 0.5–5，2 约等于 144 DPI |
| `format` | `png` | `png` 或 `jpg` |
| `pages` | 全部 | 如 `1-3,5` |

响应：

```json
{
  "jobId": "7f1c…",
  "sourceUrl": "https://example.com/a.pdf",
  "totalPagesInPdf": 10,
  "pageCount": 3,
  "expiresAt": "2026-11-10T13:00:00.000Z",
  "pages": [
    { "page": 1, "width": 1190, "height": 1684, "mime": "image/png", "url": "/api/jobs/7f1c…/pages/1" }
  ],
  "zipUrl": "/api/jobs/7f1c…/download"
}
```

### 其他接口

- `GET /api/jobs/:jobId` — 任务信息
- `GET /api/jobs/:jobId/pages/:page` — 单页图片
- `GET /api/jobs/:jobId/download` — 全部页面打包 ZIP
- `DELETE /api/jobs/:jobId` — 提前删除任务
- `GET /healthz` — 健康检查

结果保存在内存中，默认 15 分钟后过期。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `MAX_PDF_BYTES` | `52428800` | PDF 大小上限（50 MB） |
| `MAX_PAGES` | `100` | 单个 PDF 页数上限 |
| `FETCH_TIMEOUT_MS` | `60000` | 下载超时 |
| `JOB_TTL_MS` | `900000` | 结果保留时长（15 分钟） |
| `MAX_JOBS` | `50` | 内存中最多保留的任务数 |
| `MAX_CONCURRENT_JOBS` | `2` | 同时渲染的任务数 |
| `ALLOW_PRIVATE_HOSTS` | 未设置 | 设为 `1` 允许访问内网/本机地址（仅本地调试用） |

## 安全说明

- 默认拒绝 `localhost`、内网 IP 及其域名解析结果，防止 SSRF；重定向的每一跳都会重新校验。
- 限制 PDF 大小、页数、下载超时和并发渲染数。
- 只接受内容以 `%PDF-` 开头的响应。
- 生产环境建议再加鉴权、限流，并把结果存储换成对象存储。
