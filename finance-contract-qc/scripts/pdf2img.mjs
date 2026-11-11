#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SERVICE_DIR_CANDIDATES = [
  resolve(SCRIPT_DIR, '../../pdftoimage'),
  resolve(SCRIPT_DIR, '../../../pdftoimage'),
  resolve(process.cwd(), 'pdftoimage'),
];
const SERVICE_DIR = process.env.PDF2IMG_HOME
  || SERVICE_DIR_CANDIDATES.find((dir) => existsSync(join(dir, 'server.js')))
  || SERVICE_DIR_CANDIDATES[0];
const BASE_URL = (process.env.PDF2IMG_BASE_URL || 'http://10.114.13.57:3100').replace(/\/+$/, '');
const SERVICE_PORT = new URL(BASE_URL).port || '3100';

function usage() {
  console.error(`Usage: pdf2img.mjs <pdf-path-or-url> [options]

Options:
  -o, --out <dir>        output directory (default: <pdf-dir>/<pdf-name>-images)
  --scale <n>            render scale 0.5-5 (default: 2)
  --format <png|jpg>     image format (default: png)
  --pages <list>         page selection, e.g. 1-3,5 (default: all)
  --zip                  also save all pages as a zip
  --timeout <ms>         conversion timeout (default: 180000)

Env:
  PDF2IMG_BASE_URL       service base URL (default: http://10.114.13.57:3100)
  PDF2IMG_PUBLIC_HOST    host/IP the service should use to reach a local PDF
  PDF2IMG_HOME           local project dir, used only to auto-start a local service
                         (default: auto-detect <repo>/pdftoimage)`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = { scale: 2, format: 'png', zip: false, timeout: 180_000 };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) usage();
      i += 1;
      return value;
    };
    if (arg === '-o' || arg === '--out') options.out = next();
    else if (arg === '--scale') options.scale = Number(next());
    else if (arg === '--format') options.format = next();
    else if (arg === '--pages') options.pages = next();
    else if (arg === '--timeout') options.timeout = Number(next());
    else if (arg === '--zip') options.zip = true;
    else if (arg === '-h' || arg === '--help') usage();
    else if (arg.startsWith('-')) usage();
    else positional.push(arg);
  }
  if (positional.length !== 1) usage();
  options.input = positional[0];
  return options;
}

const fail = (message) => {
  console.error(`error: ${message}`);
  process.exit(1);
};

function lanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((item) => item && item.family === 'IPv4' && !item.internal)
    .map((item) => item.address);
}

function isLocalHost(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || lanAddresses().includes(host);
}

async function isHealthy() {
  try {
    const response = await fetch(`${BASE_URL}/healthz`, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function startService() {
  const entry = join(SERVICE_DIR, 'server.js');
  if (!existsSync(entry)) {
    fail(`服务 ${BASE_URL} 不可用，且找不到本地服务目录 ${SERVICE_DIR}`);
  }
  const logPath = join(SERVICE_DIR, 'server.log');
  const log = await open(logPath, 'a');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: SERVICE_DIR,
    detached: true,
    stdio: ['ignore', log.fd, log.fd],
    env: { ...process.env, PORT: SERVICE_PORT, ALLOW_PRIVATE_HOSTS: '1' },
  });
  child.unref();

  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((done) => setTimeout(done, 250));
    if (await isHealthy()) return;
  }
  fail(`服务启动超时，请查看 ${logPath}`);
}

async function ensureService() {
  if (await isHealthy()) return;
  const host = new URL(BASE_URL).hostname.replace(/^\[|\]$/g, '');
  if (!isLocalHost(host)) {
    fail(`服务 ${BASE_URL} 不可达，请确认地址或网络`);
  }
  console.error(`服务未运行，正在本机启动 ${BASE_URL} ...`);
  await startService();
}

function sanitize(name) {
  return name.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '') || 'document';
}

function resolvePublicHost() {
  if (process.env.PDF2IMG_PUBLIC_HOST) return process.env.PDF2IMG_PUBLIC_HOST;
  const serviceHost = new URL(BASE_URL).hostname.replace(/^\[|\]$/g, '');
  if (!isLocalHost(serviceHost) || serviceHost === 'localhost' || serviceHost === '127.0.0.1') {
    return lanAddresses()[0] || '127.0.0.1';
  }
  return serviceHost;
}

async function publishLocalFile(filePath) {
  const body = await readFile(filePath);
  const token = `${randomUUID()}.pdf`;

  const server = createServer((request, response) => {
    if (request.url !== `/${token}`) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/pdf', 'content-length': body.length });
    response.end(body);
  });

  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', done);
  });

  const port = server.address().port;
  const host = resolvePublicHost();
  return {
    url: `http://${host}:${port}/${token}`,
    close: () => new Promise((done) => server.close(done)),
  };
}

async function requestConversion(pdfUrl, options) {
  const body = { url: pdfUrl, scale: options.scale, format: options.format };
  if (options.pages) body.pages = options.pages;

  let response;
  try {
    response = await fetch(`${BASE_URL}/api/convert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeout),
    });
  } catch (error) {
    fail(`调用转换接口失败：${error.message}`);
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = data.error?.code;
    const message = data.error?.message || `HTTP ${response.status}`;
    if (code === 'BLOCKED_HOST') {
      fail(`${message}。该服务拒绝私网地址，请改用可公网访问的 PDF URL`);
    }
    if (code === 'FETCH_FAILED' && options.localFile) {
      fail(`${message}。服务无法访问本机临时地址 ${pdfUrl}，请通过 PDF2IMG_PUBLIC_HOST 指定服务可达的 IP，或改用公开 URL`);
    }
    fail(`转换失败：${message}`);
  }
  return data;
}

async function download(url, destination) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) fail(`下载失败：HTTP ${response.status} (${url})`);
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!Number.isFinite(options.scale) || options.scale < 0.5 || options.scale > 5) fail('--scale 需在 0.5 到 5 之间');
  if (options.format !== 'png' && options.format !== 'jpg') fail('--format 仅支持 png 或 jpg');

  await ensureService();

  const isUrl = /^https?:\/\//i.test(options.input);
  const sourcePath = isUrl
    ? null
    : (options.input.startsWith('file://') ? fileURLToPath(options.input) : resolve(options.input));

  if (sourcePath) {
    if (!existsSync(sourcePath)) fail(`PDF 文件不存在：${sourcePath}`);
    if (extname(sourcePath).toLowerCase() !== '.pdf') fail(`不是 .pdf 文件：${sourcePath}`);
  }

  const baseName = sanitize(isUrl ? basename(new URL(options.input).pathname, '.pdf') : basename(sourcePath, '.pdf'));
  const outDir = resolve(
    options.out || (sourcePath ? join(resolve(sourcePath, '..'), `${baseName}-images`) : join(process.cwd(), `${baseName}-images`)),
  );
  await mkdir(outDir, { recursive: true });

  let publisher = null;
  let job;
  try {
    if (sourcePath) publisher = await publishLocalFile(sourcePath);
    job = await requestConversion(publisher ? publisher.url : options.input, { ...options, localFile: Boolean(sourcePath) });
  } finally {
    if (publisher) await publisher.close().catch(() => {});
  }

  const ext = options.format === 'png' ? 'png' : 'jpg';
  const files = [];
  for (const page of job.pages) {
    const name = `${baseName}-page-${String(page.page).padStart(3, '0')}.${ext}`;
    const destination = join(outDir, name);
    await download(`${BASE_URL}${page.url}`, destination);
    files.push(destination);
  }

  let zipFile = null;
  if (options.zip && job.zipUrl) {
    zipFile = join(outDir, `${baseName}-pages.zip`);
    await download(`${BASE_URL}${job.zipUrl}`, zipFile);
  }

  console.log(JSON.stringify({
    jobId: job.jobId,
    source: sourcePath || options.input,
    totalPagesInPdf: job.totalPagesInPdf,
    pageCount: job.pageCount,
    outDir,
    files,
    zipFile,
  }, null, 2));
}

main().catch((error) => fail(error.message));
