#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff']);
const DEFAULT_ENDPOINT = 'http://new-api.crb.cn/v1/chat/completions';
const DEFAULT_MODEL = process.env.QWEN_OCR_MODEL || '财务领域-AI质检-qwen3.5-ocr';
const DEFAULT_PROMPT = process.env.QWEN_OCR_PROMPT || '请识别图片中的全部文字，保持原有段落、标题和表格结构，只输出识别出的文本，不要添加解释。';
const DEFAULT_TIMEOUT = 120_000;
const DEFAULT_API_STYLE = process.env.QWEN_OCR_API_STYLE || 'auto';
const DEFAULT_MAX_IMAGE_BYTES = Number(process.env.QWEN_OCR_MAX_IMAGE_BYTES || 700_000);

function usage() {
  console.error(`Usage: ocr-images.mjs <image-file-or-dir> [more-images...] [options]

Options:
  -o, --out <dir>        output directory (default: directory of the first image)
  --combined <file>      combined text file (default: <dir>/<name>-ocr.txt)
  --no-combine           do not write a combined text file
  --model <name>         OCR model (default: 财务领域-AI质检-qwen3.5-ocr)
  --endpoint <url>       full native DashScope or OpenAI-compatible OCR endpoint
  --api-style <style>    auto, native (DashScope), or openai (/v1/chat/completions)
  --prompt <text>        OCR instruction sent with every image
  --timeout <ms>         timeout per image (default: 120000)
  --max-image-bytes <n>  compress OpenAI-style requests above this size (default: 700000)
  -h, --help             show this help

Env:
  DASHSCOPE_API_KEY      required DashScope API key
  DASHSCOPE_WORKSPACE_ID workspace id used to build the Beijing endpoint
  QWEN_OCR_ENDPOINT      full endpoint (default: http://new-api.crb.cn/v1/chat/completions)
  QWEN_OCR_MODEL         default model
  QWEN_OCR_PROMPT        default OCR instruction
  QWEN_OCR_API_STYLE     auto, native, or openai (default: auto)
  QWEN_OCR_API_KEY       OCR key fallback when DASHSCOPE_API_KEY is unset
  QWEN_OCR_MAX_IMAGE_BYTES  large-image threshold for OpenAI-style requests

The script sends each image as a Base64 Data URL, so local images do not need
to be uploaded or publicly hosted first.`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = {
    model: DEFAULT_MODEL,
    prompt: DEFAULT_PROMPT,
    timeout: DEFAULT_TIMEOUT,
    combine: true,
    apiStyle: DEFAULT_API_STYLE,
    maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
  };
  const inputs = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) usage();
      i += 1;
      return value;
    };

    if (arg === '-o' || arg === '--out') options.out = next();
    else if (arg === '--combined') options.combined = next();
    else if (arg === '--no-combine') options.combine = false;
    else if (arg === '--model') options.model = next();
    else if (arg === '--endpoint') options.endpoint = next();
    else if (arg === '--api-style') options.apiStyle = next();
    else if (arg === '--prompt') options.prompt = next();
    else if (arg === '--timeout') options.timeout = Number(next());
    else if (arg === '--max-image-bytes') options.maxImageBytes = Number(next());
    else if (arg === '-h' || arg === '--help') usage();
    else if (arg.startsWith('-')) usage();
    else inputs.push(arg);
  }

  if (inputs.length === 0) usage();
  options.inputs = inputs;
  return options;
}

function resolveEndpoint(explicitEndpoint) {
  if (explicitEndpoint) return explicitEndpoint;
  if (process.env.QWEN_OCR_ENDPOINT) return process.env.QWEN_OCR_ENDPOINT;
  const workspaceId = process.env.DASHSCOPE_WORKSPACE_ID;
  if (workspaceId) {
    return `https://${workspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`;
  }
  return DEFAULT_ENDPOINT;
}

function resolveApiStyle(endpoint, requestedStyle) {
  if (requestedStyle && requestedStyle !== 'auto') {
    if (requestedStyle !== 'native' && requestedStyle !== 'openai') {
      throw new Error('--api-style 仅支持 auto、native 或 openai');
    }
    return requestedStyle;
  }
  if (/\/chat\/completions(?:\?.*)?$/i.test(endpoint)) return 'openai';
  return 'native';
}

function mimeType(filePath) {
  const extension = extname(filePath).toLowerCase();
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.bmp') return 'image/bmp';
  if (extension === '.tif' || extension === '.tiff') return 'image/tiff';
  return 'image/png';
}

function compareNatural(left, right) {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

function isImage(filePath) {
  return IMAGE_EXTENSIONS.has(extname(filePath).toLowerCase());
}

async function collectImages(inputs) {
  const files = [];

  for (const input of inputs) {
    const absolute = resolve(input);
    if (!existsSync(absolute)) throw new Error(`路径不存在：${absolute}`);
    const info = await stat(absolute);

    if (info.isDirectory()) {
      const entries = await readdir(absolute, { withFileTypes: true });
      const images = entries
        .filter((entry) => entry.isFile() && isImage(entry.name))
        .map((entry) => join(absolute, entry.name))
        .sort(compareNatural);
      files.push(...images);
    } else if (info.isFile() && isImage(absolute)) {
      files.push(absolute);
    } else {
      throw new Error(`不是支持的图片文件：${absolute}`);
    }
  }

  const unique = [...new Set(files)];
  if (unique.length === 0) throw new Error('没有找到可识别的图片文件');
  return unique;
}

function extractText(data) {
  const candidates = [
    data?.choices?.[0]?.message?.ocr_result?.processed_text,
    data?.output?.choices?.[0]?.message?.ocr_result?.processed_text,
    data?.ocr_result?.processed_text,
    data?.output?.choices?.[0]?.message?.content,
    data?.choices?.[0]?.message?.content,
    data?.output?.text,
    data?.text,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    if (Array.isArray(candidate)) {
      const text = candidate
        .map((part) => (typeof part === 'string' ? part : part?.text || ''))
        .join('')
        .trim();
      if (text) return text;
    }
    if (candidate && typeof candidate === 'object' && typeof candidate.text === 'string' && candidate.text.trim()) {
      return candidate.text.trim();
    }
  }
  return '';
}

function summarizeError(data, raw, status) {
  return data?.message || data?.error?.message || data?.code || raw.slice(0, 500) || `HTTP ${status}`;
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} 退出码 ${code}：${stderr.slice(0, 300)}`));
    });
  });
}

async function compressImage(imagePath, maxBytes) {
  const attempts = [
    { quality: 75, maxDimension: 2000 },
    { quality: 60, maxDimension: 1600 },
    { quality: 45, maxDimension: 1400 },
  ];
  let lastError = null;

  for (const attempt of attempts) {
    const destination = join(tmpdir(), `pdf2img-ocr-${randomUUID()}.jpg`);
    const sipsArgs = [
      '-s', 'format', 'jpeg',
      '-s', 'formatOptions', String(attempt.quality),
      '-Z', String(attempt.maxDimension),
      imagePath,
      '--out', destination,
    ];
    const magickArgs = [
      imagePath,
      '-resize', `${attempt.maxDimension}x${attempt.maxDimension}>`,
      '-quality', String(attempt.quality),
      destination,
    ];

    try {
      try {
        await run('sips', sipsArgs);
      } catch (sipsError) {
        lastError = sipsError;
        await run('magick', magickArgs);
      }
      const compressed = await readFile(destination);
      if (compressed.length <= maxBytes) {
        return { path: destination, bytes: compressed.length };
      }
      await unlink(destination).catch(() => {});
    } catch (error) {
      lastError = error;
      await unlink(destination).catch(() => {});
    }
  }

  throw new Error(`图片压缩后仍超过 ${maxBytes} 字节，请降低 PDF 渲染 scale 或改用 --format jpg。最后错误：${lastError?.message || '未知错误'}`);
}

async function prepareImage(imagePath, config) {
  const original = await readFile(imagePath);
  const shouldCompress = config.apiStyle === 'openai' && config.maxImageBytes > 0 && original.length > config.maxImageBytes;

  if (!shouldCompress) {
    return {
      dataUrl: `data:${mimeType(imagePath)};base64,${original.toString('base64')}`,
      sourceBytes: original.length,
      sentBytes: original.length,
      compressed: false,
      cleanup: async () => {},
    };
  }

  console.error(`图片 ${basename(imagePath)} 为 ${original.length} 字节，正在压缩以满足接口请求体限制...`);
  const compressed = await compressImage(imagePath, config.maxImageBytes);
  const data = await readFile(compressed.path);
  return {
    dataUrl: `data:image/jpeg;base64,${data.toString('base64')}`,
    sourceBytes: original.length,
    sentBytes: data.length,
    compressed: true,
    cleanup: () => unlink(compressed.path).catch(() => {}),
  };
}

async function recognize(imagePath, config) {
  const prepared = await prepareImage(imagePath, config);
  const body = config.apiStyle === 'openai'
    ? {
        model: config.model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: prepared.dataUrl } },
              { type: 'text', text: config.prompt },
            ],
          },
        ],
      }
    : {
        model: config.model,
        input: {
          messages: [
            {
              role: 'user',
              content: [
                { image: prepared.dataUrl },
                { text: config.prompt },
              ],
            },
          ],
        },
      };

  let response;
  try {
    try {
      response = await fetch(config.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.timeout),
      });
    } catch (error) {
      throw new Error(`请求失败：${error.message}`);
    }
  } finally {
    await prepared.cleanup();
  }

  const raw = await response.text();
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    // Keep the raw body for the error message below.
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}：${summarizeError(data, raw, response.status)}`);
  }

  const text = extractText(data);
  if (!text) throw new Error(`接口未返回文本：${raw.slice(0, 500)}`);

  return {
    text,
    requestId: data?.request_id || data?.id || null,
    usage: data?.usage || null,
    compressed: prepared.compressed,
    sourceBytes: prepared.sourceBytes,
    sentBytes: prepared.sentBytes,
  };
}

function deriveBaseName(files) {
  const stems = files.map((file) => basename(file, extname(file)));
  const grouped = stems.map((stem) => stem.replace(/-page-\d+$/i, ''));
  const unique = [...new Set(grouped)];
  return unique.length === 1 && unique[0] ? unique[0] : 'ocr';
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!Number.isFinite(options.timeout) || options.timeout <= 0) throw new Error('--timeout 必须是正数');
  if (!Number.isFinite(options.maxImageBytes) || options.maxImageBytes < 0) throw new Error('--max-image-bytes 必须是非负数');

  const apiKey = process.env.DASHSCOPE_API_KEY || process.env.QWEN_OCR_API_KEY;
  if (!apiKey) throw new Error('缺少 DASHSCOPE_API_KEY 环境变量');

  const endpoint = resolveEndpoint(options.endpoint);
  if (!endpoint) {
    throw new Error('缺少 OCR 接口地址：设置 DASHSCOPE_WORKSPACE_ID、QWEN_OCR_ENDPOINT 或 --endpoint');
  }
  const apiStyle = resolveApiStyle(endpoint, options.apiStyle);

  const images = await collectImages(options.inputs);
  const outDir = resolve(options.out || dirname(images[0]));
  await mkdir(outDir, { recursive: true });

  const results = [];
  const errors = [];

  for (const [index, imagePath] of images.entries()) {
    try {
      const result = await recognize(imagePath, {
        apiKey,
        endpoint,
        apiStyle,
        model: options.model,
        prompt: options.prompt,
        timeout: options.timeout,
        maxImageBytes: options.maxImageBytes,
      });
      const textFile = join(outDir, `${basename(imagePath, extname(imagePath))}.txt`);
      await writeFile(textFile, `${result.text}\n`, 'utf8');
      results.push({
        image: imagePath,
        textFile,
        chars: result.text.length,
        requestId: result.requestId,
        usage: result.usage,
        compressed: result.compressed,
        sourceBytes: result.sourceBytes,
        sentBytes: result.sentBytes,
        text: result.text,
      });
      console.error(`OCR ${index + 1}/${images.length} 完成：${basename(imagePath)}`);
    } catch (error) {
      errors.push({ image: imagePath, error: error.message });
      console.error(`OCR ${index + 1}/${images.length} 失败：${basename(imagePath)}：${error.message}`);
    }
  }

  let combinedFile = null;
  if (options.combine && results.length > 0) {
    combinedFile = resolve(options.combined || join(outDir, `${deriveBaseName(images)}-ocr.txt`));
    const content = results
      .map((item) => `===== ${basename(item.image)} =====\n${item.text}`)
      .join('\n\n');
    await writeFile(combinedFile, `${content}\n`, 'utf8');
  }

  console.log(JSON.stringify({
    endpoint,
    apiStyle,
    model: options.model,
    imageCount: images.length,
    successCount: results.length,
    failureCount: errors.length,
    outDir,
    combinedFile,
    files: results.map(({ text, ...item }) => item),
    errors,
  }, null, 2));

  if (errors.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`error: ${error.message}`);
  process.exit(1);
});
