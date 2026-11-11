import crypto from 'node:crypto';
import express from 'express';
import { ZipArchive } from 'archiver';
import { fetchPdf, renderPdf, HttpError } from './src/pdf.js';

const PORT = Number(process.env.PORT || 3000);
const JOB_TTL_MS = Number(process.env.JOB_TTL_MS || 15 * 60 * 1000);
const MAX_JOBS = Number(process.env.MAX_JOBS || 50);
const MAX_CONCURRENT_JOBS = Number(process.env.MAX_CONCURRENT_JOBS || 2);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use(express.static(new URL('./public', import.meta.url).pathname));

/** @type {Map<string, {id: string, createdAt: number, sourceUrl: string, totalPages: number, pages: Array<any>}>} */
const jobs = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS) jobs.delete(id);
  }
}, 60_000).unref();

function storeJob(sourceUrl, result) {
  while (jobs.size >= MAX_JOBS) {
    jobs.delete(jobs.keys().next().value);
  }
  const id = crypto.randomUUID();
  const job = {
    id,
    createdAt: Date.now(),
    sourceUrl,
    totalPages: result.totalPages,
    pages: result.pages,
  };
  jobs.set(id, job);
  return job;
}

let active = 0;
const waiting = [];
async function withSlot(task) {
  if (active >= MAX_CONCURRENT_JOBS) {
    await new Promise((resolve) => waiting.push(resolve));
  }
  active += 1;
  try {
    return await task();
  } finally {
    active -= 1;
    const next = waiting.shift();
    if (next) next();
  }
}

function serializeJob(job) {
  return {
    jobId: job.id,
    sourceUrl: job.sourceUrl,
    totalPagesInPdf: job.totalPages,
    pageCount: job.pages.length,
    expiresAt: new Date(job.createdAt + JOB_TTL_MS).toISOString(),
    pages: job.pages.map((page) => ({
      page: page.page,
      width: page.width,
      height: page.height,
      mime: page.mime,
      url: `/api/jobs/${job.id}/pages/${page.page}`,
    })),
    zipUrl: job.pages.length > 1 ? `/api/jobs/${job.id}/download` : null,
  };
}

app.post('/api/convert', async (req, res, next) => {
  try {
    const { url, scale, format, pages } = req.body ?? {};
    if (typeof url !== 'string' || url.trim() === '') {
      throw new HttpError(400, 'MISSING_URL', '请在请求体里提供 url 字段');
    }

    const { buffer } = await fetchPdf(url.trim());
    const result = await withSlot(() =>
      renderPdf(buffer, {
        scale: scale === undefined ? 2 : Number(scale),
        format: format || 'png',
        pages,
      }),
    );
    const job = storeJob(url.trim(), result);
    res.json(serializeJob(job));
  } catch (error) {
    next(error);
  }
});

app.get('/api/convert', async (req, res, next) => {
  try {
    const { url, scale, format, pages } = req.query;
    if (typeof url !== 'string' || url.trim() === '') {
      throw new HttpError(400, 'MISSING_URL', '请通过 ?url= 提供 PDF 链接');
    }

    const { buffer } = await fetchPdf(url.trim());
    const result = await withSlot(() =>
      renderPdf(buffer, {
        scale: scale === undefined ? 2 : Number(scale),
        format: format || 'png',
        pages,
      }),
    );
    const job = storeJob(url.trim(), result);
    res.json(serializeJob(job));
  } catch (error) {
    next(error);
  }
});

app.get('/api/jobs/:jobId', (req, res, next) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return next(new HttpError(404, 'JOB_NOT_FOUND', '任务不存在或已过期'));
  res.json(serializeJob(job));
});

app.get('/api/jobs/:jobId/pages/:page', (req, res, next) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return next(new HttpError(404, 'JOB_NOT_FOUND', '任务不存在或已过期'));

  const pageNumber = Number(req.params.page);
  const page = job.pages.find((item) => item.page === pageNumber);
  if (!page) return next(new HttpError(404, 'PAGE_NOT_FOUND', '该页未生成'));

  const format = req.query.format;
  if (format && format !== (page.mime === 'image/png' ? 'png' : 'jpg')) {
    return next(new HttpError(400, 'FORMAT_MISMATCH', '该任务已按其他格式生成，请重新转换'));
  }

  res.set('Content-Type', page.mime);
  res.set('Cache-Control', 'private, max-age=900');
  res.send(page.buffer);
});

app.get('/api/jobs/:jobId/download', (req, res, next) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return next(new HttpError(404, 'JOB_NOT_FOUND', '任务不存在或已过期'));

  const ext = job.pages[0].mime === 'image/png' ? 'png' : 'jpg';
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="pages-${job.id.slice(0, 8)}.zip"`);

  const archive = new ZipArchive({ zlib: { level: 6 } });
  archive.on('error', (error) => next(error));
  archive.pipe(res);
  for (const page of job.pages) {
    archive.append(page.buffer, { name: `page-${String(page.page).padStart(3, '0')}.${ext}` });
  }
  archive.finalize();
});

app.delete('/api/jobs/:jobId', (req, res) => {
  const deleted = jobs.delete(req.params.jobId);
  res.status(deleted ? 204 : 404).end();
});

app.get('/healthz', (req, res) => {
  res.json({ ok: true, jobs: jobs.size, active, queued: waiting.length });
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return next(new HttpError(404, 'NOT_FOUND', '接口不存在'));
  }
  next();
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error instanceof HttpError ? error.status : 500;
  if (status >= 500) console.error('[error]', error);
  res.status(status).json({
    error: {
      code: error.code || 'INTERNAL_ERROR',
      message: status >= 500 && !(error instanceof HttpError) ? '服务器内部错误' : error.message,
    },
  });
});

app.listen(PORT, () => {
  console.log(`pdf-to-image 已启动: http://localhost:${PORT}`);
});
