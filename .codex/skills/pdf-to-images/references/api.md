# PDF to Image Service API

Base URL: `http://10.114.13.57:3100`

All responses are JSON unless noted. Errors use:

```json
{ "error": { "code": "BLOCKED_HOST", "message": "human readable message" } }
```

## POST /api/convert

Convert a PDF reached by URL. This is the primary endpoint.

```bash
curl -s -X POST http://10.114.13.57:3100/api/convert \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com/a.pdf","scale":2,"format":"png"}'
```

Body:

| Field | Required | Default | Description |
| --- | --- | --- | --- |
| `url` | yes | — | Public http/https URL of the PDF |
| `scale` | no | `2` | Render scale, 0.5–5; 2 ≈ 144 DPI |
| `format` | no | `png` | `png` or `jpg` |
| `pages` | no | all | Page selection such as `1-3,5` |

Response `200`:

```json
{
  "jobId": "261f0a96-ae20-4e10-8f4d-5aa7a4fed126",
  "sourceUrl": "https://example.com/a.pdf",
  "totalPagesInPdf": 10,
  "pageCount": 3,
  "expiresAt": "2026-11-10T13:11:07.066Z",
  "pages": [
    { "page": 1, "width": 1190, "height": 1684, "mime": "image/png", "url": "/api/jobs/<jobId>/pages/1" }
  ],
  "zipUrl": "/api/jobs/<jobId>/download"
}
```

`zipUrl` is `null` when only one page was rendered.

## GET /api/convert

Same parameters as query string:

```
GET /api/convert?url=<pdf-url>&scale=2&format=png&pages=1-3,5
```

## GET /api/jobs/:jobId

Return the job metadata in the same shape as the convert response.

## GET /api/jobs/:jobId/pages/:page

Return a single rendered page with `Content-Type: image/png` or `image/jpeg`. Use the `url` field from the convert response, prefixed with the base URL.

## GET /api/jobs/:jobId/download

Return a ZIP archive of all rendered pages. Only useful for multi-page jobs.

## DELETE /api/jobs/:jobId

Delete a job early. Returns `204`, or `404` if it does not exist.

## GET /healthz

```json
{ "ok": true, "jobs": 2, "active": 0, "queued": 0 }
```

## Common errors

| HTTP | Code | Meaning |
| --- | --- | --- |
| 400 | `MISSING_URL` | `url` missing or empty |
| 400 | `INVALID_URL` | Not a valid http/https URL |
| 400 | `BLOCKED_HOST` | URL resolves to a private/loopback address and the server forbids it |
| 400 | `INVALID_PAGES` | Bad page selection or out of range |
| 400 | `INVALID_SCALE` / `INVALID_FORMAT` | Bad render options |
| 413 | `PDF_TOO_LARGE` / `TOO_MANY_PAGES` | Size or page limit exceeded |
| 415 | `NOT_A_PDF` | Response is not a PDF |
| 422 | `PARSE_FAILED` / `EMPTY_PDF` | PDF could not be parsed |
| 502 | `FETCH_FAILED` / `TOO_MANY_REDIRECTS` | Server could not download the PDF |
| 404 | `JOB_NOT_FOUND` / `PAGE_NOT_FOUND` | Job expired (default 15 min) or page not rendered |

## Notes

- Jobs are held in memory and expire after 15 minutes (deployment default). Download images promptly.
- `10.114.13.57` is a private address. A PDF URL hosted on the same LAN must be reachable from the server; if the server blocks private hosts, it returns `BLOCKED_HOST`.
- The endpoint accepts only a URL, not a file upload. To convert a local file, publish it over HTTP first (see `scripts/pdf2img.mjs`).
