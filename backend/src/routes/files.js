import { Router } from 'express';
import path from 'node:path';
import busboy from 'busboy';
import { loadServer } from './servers.js';
import * as files from '../files.js';
import { audit } from '../db.js';
import { httpError } from '../servers.js';

export const router = Router({ mergeParams: true });

router.use('/:id', loadServer);

router.get('/:id/files', async (req, res, next) => {
  try {
    res.json(await files.listDir(req.server, req.query.path || ''));
  } catch (e) {
    next(e);
  }
});

router.get('/:id/files/wellknown', (_req, res) => res.json({ files: files.WELL_KNOWN }));

router.get('/:id/files/read', async (req, res, next) => {
  try {
    const rel = String(req.query.path || '');
    if (!rel) throw httpError(400, 'path is required');
    res.json({ path: rel, content: await files.readText(req.server, rel) });
  } catch (e) {
    next(e);
  }
});

router.put('/:id/files/write', async (req, res, next) => {
  try {
    const rel = String(req.body?.path || '');
    if (!rel) throw httpError(400, 'path is required');
    await files.writeText(req.server, rel, req.body?.content ?? '');
    audit(req.user, req.server.id, 'file.write', rel);
    res.json({ ok: true, path: rel });
  } catch (e) {
    next(e);
  }
});

router.get('/:id/files/download', async (req, res, next) => {
  try {
    const rel = String(req.query.path || '');
    if (!rel) throw httpError(400, 'path is required');
    const base = path.posix.basename(rel);

    if (req.query.zip === 'true') {
      res.setHeader('content-type', 'application/zip');
      res.setHeader('content-disposition', `attachment; filename="${base || 'data'}.zip"`);
      await files.zipStream(req.server, rel, res);
      return;
    }
    const buf = await files.readFile(req.server, rel);
    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('content-disposition', `attachment; filename="${base}"`);
    res.send(buf);
  } catch (e) {
    next(e);
  }
});

router.post('/:id/files/upload', (req, res, next) => {
  const dir = String(req.query.path || '');
  const bb = busboy({ headers: req.headers, limits: { fileSize: 512 * 1024 * 1024, files: 8 } });
  const saved = [];
  const pending = [];
  let failed = null;

  bb.on('file', (_field, stream, info) => {
    const chunks = [];
    stream.on('data', (d) => chunks.push(d));
    pending.push(
      new Promise((resolve) => {
        stream.on('limit', () => {
          failed ||= httpError(413, `${info.filename} exceeds the 512 MB upload limit`);
          resolve();
        });
        stream.on('end', async () => {
          if (failed) return resolve();
          try {
            saved.push(await files.uploadFile(req.server, dir, info.filename, Buffer.concat(chunks)));
          } catch (e) {
            failed ||= e;
          }
          resolve();
        });
      })
    );
  });

  bb.on('error', (e) => next(e));
  bb.on('close', async () => {
    await Promise.all(pending);
    if (failed) return next(failed);
    audit(req.user, req.server.id, 'file.upload', saved.map((s) => s.path).join(', '));
    res.json({ uploaded: saved });
  });

  req.pipe(bb);
});

router.post('/:id/files/mkdir', async (req, res, next) => {
  try {
    await files.mkdir(req.server, String(req.body?.path || ''));
    audit(req.user, req.server.id, 'file.mkdir', req.body?.path);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

router.post('/:id/files/rename', async (req, res, next) => {
  try {
    await files.rename(req.server, String(req.body?.from || ''), String(req.body?.to || ''));
    audit(req.user, req.server.id, 'file.rename', `${req.body?.from} -> ${req.body?.to}`);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

router.delete('/:id/files', async (req, res, next) => {
  try {
    const rel = String(req.query.path || '');
    if (!rel) throw httpError(400, 'path is required');
    await files.remove(req.server, rel);
    audit(req.user, req.server.id, 'file.delete', rel);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
