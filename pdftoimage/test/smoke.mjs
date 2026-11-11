import http from 'node:http';
import { spawn } from 'node:child_process';
import { samplePdf } from './make-sample-pdf.mjs';

const APP_PORT = 3999;
const FILE_PORT = 3998;

const fileServer = http.createServer((req, res) => {
  if (req.url === '/sample.pdf') {
    res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': samplePdf.length });
    res.end(samplePdf);
    return;
  }
  res.writeHead(404).end();
});
await new Promise((resolve) => fileServer.listen(FILE_PORT, '127.0.0.1', resolve));

const server = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT: String(APP_PORT), ALLOW_PRIVATE_HOSTS: '1', JOB_TTL_MS: '60000' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
server.stdout.on('data', (chunk) => { logs += chunk; });
server.stderr.on('data', (chunk) => { logs += chunk; });

async function waitForHealth() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${APP_PORT}/healthz`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server did not start:\n${logs}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  await waitForHealth();

  const convert = await fetch(`http://127.0.0.1:${APP_PORT}/api/convert`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: `http://127.0.0.1:${FILE_PORT}/sample.pdf`, scale: 2, format: 'png' }),
  });
  const job = await convert.json();
  assert(convert.status === 200, `convert failed: ${JSON.stringify(job)}`);
  assert(job.pageCount === 2, `expected 2 pages, got ${job.pageCount}`);
  assert(job.totalPagesInPdf === 2, `expected totalPagesInPdf 2, got ${job.totalPagesInPdf}`);

  const imageResponse = await fetch(`http://127.0.0.1:${APP_PORT}${job.pages[0].url}`);
  const image = Buffer.from(await imageResponse.arrayBuffer());
  assert(imageResponse.headers.get('content-type') === 'image/png', 'expected image/png');
  assert(image.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'not a PNG');
  assert(job.pages[0].width > 0 && job.pages[0].height > 0, 'missing image dimensions');

  const zipResponse = await fetch(`http://127.0.0.1:${APP_PORT}${job.zipUrl}`);
  const zip = Buffer.from(await zipResponse.arrayBuffer());
  assert(zip.subarray(0, 2).toString() === 'PK', 'not a zip');

  const badUrl = await fetch(`http://127.0.0.1:${APP_PORT}/api/convert`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'not-a-url' }),
  });
  assert(badUrl.status === 400, `expected 400 for bad url, got ${badUrl.status}`);

  console.log(`smoke ok: ${job.pageCount} pages, ${job.pages[0].width}x${job.pages[0].height}, ${zip.length} bytes zip`);
} finally {
  server.kill('SIGTERM');
  fileServer.close();
}
