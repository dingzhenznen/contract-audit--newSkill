import dns from 'node:dns/promises';
import net from 'node:net';
import { pdf } from 'pdf-to-img';
import { loadImage } from '@napi-rs/canvas';

const MAX_PDF_BYTES = Number(process.env.MAX_PDF_BYTES || 50 * 1024 * 1024);
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 60_000);
const MAX_REDIRECTS = 5;
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE_HOSTS === '1';

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const PRIVATE_V4 = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function isPrivateIpv4(ip) {
  const value = ipv4ToInt(ip);
  return PRIVATE_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (ipv4ToInt(base) & mask);
  });
}

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return isPrivateIpv4(ip);
  if (!net.isIPv6(ip)) return true;

  const lower = ip.toLowerCase();
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  if (lower === '::' || lower === '::1') return true;

  const firstGroup = lower.split(':').find((group) => group.length > 0);
  if (!firstGroup) return true;
  const prefix = parseInt(firstGroup, 16);
  if (Number.isNaN(prefix)) return true;

  if ((prefix & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((prefix & 0xffc0) === 0xfe80) return true; // fe80::/10
  if ((prefix & 0xff00) === 0xff00) return true; // ff00::/8
  return false;
}

async function assertUrlAllowed(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new HttpError(400, 'INVALID_URL', 'url 不是合法的 URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpError(400, 'INVALID_URL', '仅支持 http/https 链接');
  }
  if (ALLOW_PRIVATE) return url;

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new HttpError(400, 'BLOCKED_HOST', '不允许访问内网地址');
  }

  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new HttpError(400, 'BLOCKED_HOST', '不允许访问内网地址');
    return url;
  }

  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch {
    throw new HttpError(400, 'DNS_FAILED', `无法解析域名：${host}`);
  }
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateIp(address))) {
    throw new HttpError(400, 'BLOCKED_HOST', '不允许访问内网地址');
  }
  return url;
}

async function readBodyWithLimit(response) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_PDF_BYTES) {
    throw new HttpError(413, 'PDF_TOO_LARGE', `PDF 超过大小限制（${MAX_PDF_BYTES} 字节）`);
  }

  const chunks = [];
  let received = 0;
  for await (const chunk of response.body) {
    received += chunk.length;
    if (received > MAX_PDF_BYTES) {
      throw new HttpError(413, 'PDF_TOO_LARGE', `PDF 超过大小限制（${MAX_PDF_BYTES} 字节）`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function fetchPdf(rawUrl) {
  let url = await assertUrlAllowed(rawUrl);
  let currentUrl = url.href;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let response;
    try {
      response = await fetch(currentUrl, {
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { accept: 'application/pdf,*/*;q=0.8' },
      });
    } catch (error) {
      throw new HttpError(502, 'FETCH_FAILED', `下载 PDF 失败：${error.message}`);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new HttpError(502, 'FETCH_FAILED', 'PDF 链接重定向缺少 Location');
      const next = new URL(location, currentUrl);
      url = await assertUrlAllowed(next.href);
      currentUrl = next.href;
      continue;
    }

    if (!response.ok) {
      throw new HttpError(502, 'FETCH_FAILED', `下载 PDF 失败，HTTP ${response.status}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType && !/pdf|octet-stream|binary/i.test(contentType)) {
      throw new HttpError(415, 'NOT_A_PDF', `链接返回的不是 PDF（Content-Type: ${contentType}）`);
    }

    const buffer = await readBodyWithLimit(response);
    if (buffer.subarray(0, 1024).includes('%PDF-') === false) {
      throw new HttpError(415, 'NOT_A_PDF', '文件内容不是有效的 PDF');
    }
    return { buffer, finalUrl: currentUrl };
  }

  throw new HttpError(502, 'TOO_MANY_REDIRECTS', 'PDF 链接重定向次数过多');
}

export function parsePageSelection(pages, total) {
  if (pages === undefined || pages === null || pages === '') {
    return Array.from({ length: total }, (_, index) => index + 1);
  }
  const selected = new Set();
  for (const part of String(pages).split(',')) {
    const item = part.trim();
    if (!item) continue;
    const range = item.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start > end) throw new HttpError(400, 'INVALID_PAGES', `页码范围不合法：${item}`);
      for (let page = start; page <= end; page += 1) selected.add(page);
    } else if (/^\d+$/.test(item)) {
      selected.add(Number(item));
    } else {
      throw new HttpError(400, 'INVALID_PAGES', `无法解析页码范围：${item}`);
    }
  }
  if (selected.size === 0) throw new HttpError(400, 'INVALID_PAGES', '未选择任何页面');
  for (const page of selected) {
    if (page < 1 || page > total) {
      throw new HttpError(400, 'INVALID_PAGES', `页码 ${page} 超出范围（共 ${total} 页）`);
    }
  }
  return [...selected].sort((a, b) => a - b);
}

export async function renderPdf(buffer, { scale = 2, format = 'png', pages } = {}) {
  if (!Number.isFinite(scale) || scale < 0.5 || scale > 5) {
    throw new HttpError(400, 'INVALID_SCALE', 'scale 需在 0.5 到 5 之间');
  }
  if (format !== 'png' && format !== 'jpg') {
    throw new HttpError(400, 'INVALID_FORMAT', 'format 仅支持 png 或 jpg');
  }

  let doc;
  try {
    doc = await pdf(buffer, { scale, format });
  } catch (error) {
    throw new HttpError(422, 'PARSE_FAILED', `PDF 解析失败：${error.message}`);
  }

  try {
    const total = doc.length;
    if (total === 0) throw new HttpError(422, 'EMPTY_PDF', 'PDF 没有任何页面');

    const maxPages = Number(process.env.MAX_PAGES || 100);
    if (total > maxPages) {
      throw new HttpError(413, 'TOO_MANY_PAGES', `PDF 共 ${total} 页，超过上限 ${maxPages} 页`);
    }

    const selected = parsePageSelection(pages, total);
    const mime = format === 'png' ? 'image/png' : 'image/jpeg';
    const results = [];

    for (const pageNumber of selected) {
      const pageBuffer = await doc.getPage(pageNumber);
      let width = null;
      let height = null;
      try {
        const image = await loadImage(pageBuffer);
        width = image.width;
        height = image.height;
      } catch {
        // dimensions are best-effort
      }
      results.push({ page: pageNumber, buffer: pageBuffer, mime, width, height });
    }

    return { totalPages: total, pages: results };
  } finally {
    await doc.destroy().catch(() => {});
  }
}
