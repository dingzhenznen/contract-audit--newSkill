---
name: pdf-to-images
description: Convert a PDF file or PDF URL into PNG/JPG page images, then OCR every page with qwen3.5-ocr and save the recognized text. Use when the user sends, attaches, or references a PDF and asks to convert it to images, render pages, download page images, extract text, recognize text, or OCR the document.
---

# PDF to Images + OCR

Two services are involved:

- PDF rendering: `http://10.114.13.57:3100`, documented in [references/api.md](references/api.md).
- Page OCR: `qwen3.5-ocr`, through native DashScope or an OpenAI-compatible proxy, documented in [references/ocr-api.md](references/ocr-api.md).

The scripts keep the two steps separate: `pdf2img.mjs` downloads page images, then `ocr-images.mjs` recognizes every image.

## Workflow

1. Resolve the input.
   - Attachment or local file: use the absolute path of the `.pdf`.
   - URL: use it as-is.
   - No clear source: ask the user for the file path or URL.

2. Convert the PDF to images from the repo root:

   ```bash
   node .codex/skills/pdf-to-images/scripts/pdf2img.mjs "<pdf-path-or-url>" -o "<output-dir>"
   ```

   Options: `--scale 2` (0.5–5, default 2), `--format png|jpg`, `--pages 1-3,5`, `--zip`, `--timeout 180000`.

   - Output defaults to `<pdf-dir>/<pdf-name>-images` for local files, or `./<pdf-name>-images` for URLs.
   - Local files are published through a temporary HTTP server on this machine, then the service fetches that URL. Set `PDF2IMG_PUBLIC_HOST` if the detected LAN IP is not reachable by the service.
   - Override the service with `PDF2IMG_BASE_URL`.

3. OCR every downloaded image:

   ```bash
   node .codex/skills/pdf-to-images/scripts/ocr-images.mjs "<output-dir>" --out "<output-dir>"
   ```

   Default configuration (already built into the script):

   - Endpoint: `http://new-api.crb.cn/v1/chat/completions`
   - Model: `财务领域-AI质检-qwen3.5-ocr`

   Only the API key is required:

   ```bash
   export DASHSCOPE_API_KEY="<key>"
   ```

   Override the defaults only when needed:

   ```bash
   export QWEN_OCR_ENDPOINT="<other-endpoint>"
   export QWEN_OCR_MODEL="<other-model>"
   ```

   Native DashScope remains available by setting `DASHSCOPE_WORKSPACE_ID` or `QWEN_OCR_ENDPOINT`; in that case also set `QWEN_OCR_MODEL=qwen3.5-ocr`. The script auto-detects `/v1/chat/completions` and uses the OpenAI `image_url` + `text` content format with required `type` fields. Use `--api-style native|openai` to force a format. The API key can also be supplied as `QWEN_OCR_API_KEY`.

   The OCR script:
   - Accepts one image, several images, or a directory; directory images are processed in natural page order.
   - Sends each image as a Base64 Data URL, so no public image hosting is needed.
   - For OpenAI-style endpoints, images over `--max-image-bytes` (default 700000) are automatically compressed to JPEG with `sips` or ImageMagick before sending. This avoids nginx `413 Request Entity Too Large` responses.
   - Writes `<image-name>.txt` beside each image.
   - Writes a combined `<pdf-name>-ocr.txt` by default; use `--combined <file>` or `--no-combine` to change this.
   - Continues with remaining images if one page fails, prints the errors, and exits non-zero when any page failed.

   Options: `--model <name>`, `--api-style auto|native|openai`, `--prompt "<instruction>"`, `--timeout 120000`, `--max-image-bytes 700000`, `--no-combine`, `--combined <file>`.

4. Verify the result.
   - Parse both JSON summaries (`files`/`outDir` from conversion; `files`/`combinedFile`/`errors` from OCR).
   - Confirm every listed image and text file exists and is non-empty; inspect the first page with `view_image` when visual confirmation matters.

5. Report absolute paths for the images and OCR text, the page count, format, scale, model, and any failed pages.

## Notes

- The service accepts a PDF URL only; it does not accept file uploads. The script handles local files by serving them temporarily.
- Jobs expire after ~15 minutes, but downloaded files stay on disk.
- `BLOCKED_HOST`: the service refuses private/loopback URLs. Use a publicly reachable PDF URL or ask the service owner to allow LAN hosts.
- `FETCH_FAILED` on a local file: the service could not reach this machine. Pass the PDF as a public URL, or set `PDF2IMG_PUBLIC_HOST` to an address the service can reach.
- OCR needs `DASHSCOPE_API_KEY`; without it, run conversion only and report that OCR was not requested/configured.
- `qwen3.5-ocr` accepts an image URL or Base64 Data URL. The script uses Base64, so local page images work directly.
- Native DashScope content uses `{"image": ...}` and `{"text": ...}`. OpenAI-compatible `/v1/chat/completions` content requires `{"type":"image_url","image_url":{"url":...}}` and `{"type":"text","text":...}`; omitting `type` causes `Missing required parameter: 'messages.[0].content[0].type'`.
- If an OpenAI-compatible proxy returns `413`, the request body exceeded its nginx limit. The script auto-compresses; you can also convert with `pdf2img.mjs --format jpg` or lower `--scale`.
- See [references/ocr-api.md](references/ocr-api.md) for both request formats, response shapes, and errors.
- Prefer `--scale 2` or `3` for scanned pages; `--scale 1` for quick previews.
- Request `--zip` only when the user wants an archive.
