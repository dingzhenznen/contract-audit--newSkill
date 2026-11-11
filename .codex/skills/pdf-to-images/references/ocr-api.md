# qwen3.5-ocr API

Two request formats are supported:

- Native DashScope multimodal generation.
- OpenAI-compatible `/v1/chat/completions` proxies.

Default OCR endpoint:

```text
http://new-api.crb.cn/v1/chat/completions
```

Default model: `财务领域-AI质检-qwen3.5-ocr`.

Authentication uses a bearer token. The scripts read it from `DASHSCOPE_API_KEY` or `QWEN_OCR_API_KEY`.

## Configuration

Only the API key is required:

```bash
export DASHSCOPE_API_KEY="<your-api-key>"
```

The endpoint and model above are built-in defaults. Override them with `QWEN_OCR_ENDPOINT` / `QWEN_OCR_MODEL` or `--endpoint` / `--model` only when needed.

Optional:

```bash
export QWEN_OCR_MODEL="财务领域-AI质检-qwen3.5-ocr"
export QWEN_OCR_PROMPT="请识别图片中的全部文字，保持原有段落、标题和表格结构，只输出识别出的文本，不要添加解释。"
```

To use native DashScope instead:

```bash
export DASHSCOPE_API_KEY="<your-api-key>"
export DASHSCOPE_WORKSPACE_ID="<your-workspace-id>"
export QWEN_OCR_MODEL="qwen3.5-ocr"
```

`QWEN_OCR_API_KEY` is also accepted as an alias for `DASHSCOPE_API_KEY`.

## Native DashScope request

`POST /api/v1/services/aigc/multimodal-generation/generation`

Headers:

- `Authorization: Bearer $DASHSCOPE_API_KEY`
- `Content-Type: application/json`

Body:

```json
{
  "model": "qwen3.5-ocr",
  "input": {
    "messages": [
      {
        "role": "user",
        "content": [
          { "image": "https://example.com/page-001.png" },
          { "text": "请识别图片中的全部文字，保持原有段落、标题和表格结构，只输出识别出的文本，不要添加解释。" }
        ]
      }
    ]
  }
}
```

The `image` field accepts either a publicly reachable image URL or a Base64 Data URL. `scripts/ocr-images.mjs` uses the Data URL form, for example:

```text
data:image/png;base64,<base64-png-bytes>
```

This means local page images can be sent without uploading them first. Images should be JPEG, PNG, WEBP, BMP, or TIFF; keep the image reasonably sized because the API has a request-size limit.

## cURL example

```bash
curl -sS -X POST \
  "https://${DASHSCOPE_WORKSPACE_ID}.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation" \
  -H "Authorization: Bearer ${DASHSCOPE_API_KEY}" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "qwen3.5-ocr",
    "input": {
      "messages": [{
        "role": "user",
        "content": [
          {"image": "https://example.com/page-001.png"},
          {"text": "请识别图片中的全部文字，保持原有段落、标题和表格结构，只输出识别出的文本，不要添加解释。"}
        ]
      }]
    }
  }'
```

## OpenAI-compatible request

`POST /v1/chat/completions`

The OpenAI-compatible shape requires a `type` on every content item. This is the corrected form of a request that otherwise fails with `Missing required parameter: 'messages.[0].content[0].type'`.

```bash
curl -sS -X POST "$QWEN_OCR_ENDPOINT" \
  -H "Authorization: Bearer $QWEN_OCR_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "财务领域-AI质检-qwen3.5-ocr",
    "messages": [{
      "role": "user",
      "content": [
        {
          "type": "image_url",
          "image_url": {
            "url": "https://example.com/page-001.png"
          }
        },
        {
          "type": "text",
          "text": "请仅输出图像中的文本内容。"
        }
      ]
    }]
  }'
```

The image URL may also be a Base64 Data URL:

```text
data:image/jpeg;base64,<base64-jpeg-bytes>
```

OpenAI-compatible proxies commonly sit behind nginx with a request-body limit near 1 MB. A 1190x1684 PNG page can exceed that after Base64 encoding and return `413 Request Entity Too Large`. `scripts/ocr-images.mjs` therefore automatically compresses OpenAI-style images above `--max-image-bytes` (default 700000) to JPEG with `sips` or ImageMagick. Using `pdf2img.mjs --format jpg` is another lightweight option.

### OpenAI-compatible response

```json
{
  "id": "chatcmpl-xxxxxxxx",
  "model": "qwen3.5-ocr",
  "choices": [
    {
      "index": 0,
      "finish_reason": "stop",
      "message": {
        "role": "assistant",
        "content": "识别出的第一行\n识别出的第二行",
        "ocr_result": {
          "processed_text": "识别出的第一行\n识别出的第二行"
        }
      }
    }
  ],
  "usage": {
    "prompt_tokens": 1009,
    "completion_tokens": 191,
    "total_tokens": 1200
  }
}
```

`scripts/ocr-images.mjs` reads `choices[0].message.ocr_result.processed_text` first, then `choices[0].message.content`.

## Response

The native DashScope response normally returns the recognized text under `output.choices[0].message.content`:

```json
{
  "output": {
    "choices": [
      {
        "finish_reason": "stop",
        "message": {
          "role": "assistant",
          "content": [
            { "text": "识别出的第一行\n识别出的第二行" }
          ]
        }
      }
    ]
  },
  "usage": {
    "input_tokens": 1024,
    "output_tokens": 128
  },
  "request_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
}
```

`scripts/ocr-images.mjs` also tolerates an OpenAI-compatible `choices[0].message.content` string/array and `output.text` when extracting the result.

The script writes:

- One UTF-8 text file per image: `<image-name>.txt`.
- A combined file: `<prefix>-ocr.txt` by default, with `===== <image-name> =====` page separators.

## Errors

| HTTP | Meaning | What to do |
| --- | --- | --- |
| 400 | Invalid request, image, or model parameter | Check `model`, `image` MIME/Data URL, and prompt |
| 401 / 403 | Missing or invalid API key | Set a valid `DASHSCOPE_API_KEY` |
| 404 | Workspace/endpoint not found | Check `DASHSCOPE_WORKSPACE_ID`, region, or `QWEN_OCR_ENDPOINT` |
| 413 | Image or request too large (often nginx's ~1 MB body limit) | Automatic compression should handle it; otherwise lower the PDF render scale or use `--format jpg` |
| 429 | Rate or quota limit | Retry later or reduce concurrency |
| 5xx | Upstream service error | Retry; preserve the images so OCR can be rerun |

The OCR script processes pages sequentially, saves successful pages even if another page fails, and exits with a non-zero status if any image failed.
