import { Router } from 'express';
import busboy from 'busboy';
import { loadServer } from './servers.js';
import * as mods from '../mods.js';
import { audit } from '../db.js';
import { httpError } from '../servers.js';

export const router = Router({ mergeParams: true });

router.use('/:id', loadServer);

router.get('/:id/mods', async (req, res, next) => {
  try {
    res.json(await mods.listMods(req.server));
  } catch (e) {
    next(e);
  }
});

router.get('/:id/mods/search', async (req, res, next) => {
  try {
    res.json(
      await mods.searchModrinth(req.server, String(req.query.q || ''), {
        limit: Number(req.query.limit) || 20,
        offset: Number(req.query.offset) || 0,
      })
    );
  } catch (e) {
    next(e);
  }
});

router.get('/:id/mods/versions/:projectId', async (req, res, next) => {
  try {
    res.json({ versions: await mods.modrinthVersions(req.server, req.params.projectId) });
  } catch (e) {
    next(e);
  }
});

router.post('/:id/mods/install', async (req, res, next) => {
  try {
    let result;
    if (req.body?.projectId) {
      result = await mods.installFromModrinth(req.server, {
        projectId: req.body.projectId,
        versionId: req.body.versionId,
      });
    } else if (req.body?.url) {
      result = await mods.installFromUrl(req.server, req.body.url, req.body.filename);
    } else {
      throw httpError(400, 'provide either projectId or url');
    }
    audit(req.user, req.server.id, 'mod.install', result.file);
    res.status(201).json({ installed: result, restartRequired: true });
  } catch (e) {
    next(e);
  }
});

router.post('/:id/mods/upload', (req, res, next) => {
  const bb = busboy({ headers: req.headers, limits: { fileSize: 256 * 1024 * 1024, files: 10 } });
  const saved = [];
  const pending = [];
  let failed = null;

  bb.on('file', (_field, stream, info) => {
    const chunks = [];
    stream.on('data', (d) => chunks.push(d));
    pending.push(
      new Promise((resolve) => {
        stream.on('limit', () => {
          failed ||= httpError(413, `${info.filename} exceeds the 256 MB limit`);
          resolve();
        });
        stream.on('end', async () => {
          if (failed) return resolve();
          try {
            saved.push(await mods.installFromBuffer(req.server, info.filename, Buffer.concat(chunks)));
          } catch (e) {
            failed ||= e;
          }
          resolve();
        });
      })
    );
  });

  bb.on('error', next);
  bb.on('close', async () => {
    await Promise.all(pending);
    if (failed) return next(failed);
    audit(req.user, req.server.id, 'mod.upload', saved.map((s) => s.file).join(', '));
    res.json({ installed: saved, restartRequired: true });
  });

  req.pipe(bb);
});

router.post('/:id/mods/toggle', async (req, res, next) => {
  try {
    const result = await mods.setEnabled(req.server, req.body?.file, req.body?.enabled !== false);
    audit(req.user, req.server.id, 'mod.toggle', `${req.body?.file} enabled=${req.body?.enabled !== false}`);
    res.json({ ...result, restartRequired: true });
  } catch (e) {
    next(e);
  }
});

router.delete('/:id/mods', async (req, res, next) => {
  try {
    const result = await mods.removeMod(req.server, String(req.query.file || ''));
    audit(req.user, req.server.id, 'mod.remove', result.removed);
    res.json({ ...result, restartRequired: true });
  } catch (e) {
    next(e);
  }
});
