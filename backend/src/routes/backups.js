import { Router } from 'express';
import fs from 'node:fs';
import busboy from 'busboy';
import { loadServer } from './servers.js';
import * as backups from '../backups.js';
import { httpError } from '../errors.js';

export const router = Router({ mergeParams: true });

router.use('/:id', loadServer);

router.get('/:id/backups', async (req, res, next) => {
  try {
    res.json({
      backups: backups.listBackups(req.server.id),
      schedule: backups.getSchedule(req.server.id),
      worldDir: backups.worldDirOf(req.server),
      repo: await backups.repoStats(req.server).catch((e) => ({ error: e.message })),
    });
  } catch (e) {
    next(e);
  }
});

router.post('/:id/backups', async (req, res, next) => {
  try {
    const scope = req.body?.scope === 'all' ? 'all' : 'world';
    const b = await backups.createBackup(req.server.id, {
      scope,
      note: req.body?.note,
      actor: req.user,
    });
    res.status(201).json({ backup: b });
  } catch (e) {
    next(e);
  }
});

/** Ask restic to verify its own repository. */
router.post('/:id/backups/check', async (_req, res, next) => {
  try {
    res.json({ result: await backups.checkRepo() });
  } catch (e) {
    next(e);
  }
});

router.put('/:id/backups/schedule', (req, res, next) => {
  try {
    res.json({
      schedule: backups.setSchedule(
        req.server.id,
        {
          cron: req.body?.cron || null,
          keep: req.body?.keep ?? 7,
          enabled: req.body?.enabled !== false,
        },
        req.user
      ),
    });
  } catch (e) {
    next(e);
  }
});

function loadBackup(req, res, next) {
  const b = backups.getBackup(req.params.backupId);
  if (!b || b.server_id !== req.server.id) return res.status(404).json({ error: 'no such backup' });
  req.backup = b;
  next();
}

router.get('/:id/backups/:backupId/download', loadBackup, async (req, res, next) => {
  try {
    if (req.backup.engine === 'tar' && !fs.existsSync(backups.backupPath(req.backup)))
      throw httpError(410, 'backup file is missing from disk');

    const zip = req.query.format === 'zip';
    res.setHeader('content-type', zip ? 'application/zip' : 'application/gzip');
    res.setHeader(
      'content-disposition',
      `attachment; filename="${backups.downloadName(req.backup, zip ? 'zip' : 'tar.gz')}"`
    );
    if (zip) await backups.streamAsZip(req.backup, res);
    else await backups.streamAsTarGz(req.backup, res);
  } catch (e) {
    next(e);
  }
});

router.post('/:id/backups/:backupId/restore', loadBackup, async (req, res, next) => {
  try {
    if (String(req.query.confirm || '') !== req.server.slug)
      throw httpError(400, `confirmation required: pass ?confirm=${req.server.slug}`);
    res.json(await backups.restoreBackup(req.backup.id, { actor: req.user }));
  } catch (e) {
    next(e);
  }
});

router.delete('/:id/backups/:backupId', loadBackup, async (req, res, next) => {
  try {
    await backups.deleteBackup(req.backup.id, req.user);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

/**
 * Move a world by hand instead of through the shared backup repository: a
 * plain zip out, a plain zip back in on whichever server it lands on next.
 * Independent of the snapshot list above, so neither side needs a backup to
 * already exist.
 */
router.get('/:id/world/download', async (req, res, next) => {
  try {
    res.setHeader('content-type', 'application/zip');
    res.setHeader('content-disposition', `attachment; filename="${req.server.slug}-world.zip"`);
    await backups.worldDownloadStream(req.server, res);
  } catch (e) {
    next(e);
  }
});

router.post('/:id/world/upload', (req, res, next) => {
  const bb = busboy({ headers: req.headers, limits: { fileSize: 4 * 1024 * 1024 * 1024, files: 1 } });
  let seed = '';
  let buffer = null;
  let failed = null;
  const pending = [];

  bb.on('field', (name, value) => {
    if (name === 'seed') seed = value;
  });
  bb.on('file', (_field, stream, info) => {
    const chunks = [];
    stream.on('data', (d) => chunks.push(d));
    pending.push(
      new Promise((resolve) => {
        stream.on('limit', () => {
          failed ||= httpError(413, `${info.filename} exceeds the 4 GB upload limit`);
          resolve();
        });
        stream.on('end', () => {
          buffer = Buffer.concat(chunks);
          resolve();
        });
      })
    );
  });

  bb.on('error', (e) => next(e));
  bb.on('close', async () => {
    await Promise.all(pending);
    if (failed) return next(failed);
    if (!buffer) return next(httpError(400, 'no file uploaded'));
    try {
      if (String(req.query.confirm || '') !== req.server.slug)
        throw httpError(400, `confirmation required: pass ?confirm=${req.server.slug}`);
      res.json(await backups.worldUpload(req.server, buffer, { actor: req.user, seed: seed.trim() || undefined }));
    } catch (e) {
      next(e);
    }
  });

  req.pipe(bb);
});
