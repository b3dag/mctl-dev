import { Router } from 'express';
import fs from 'node:fs';
import { loadServer } from './servers.js';
import * as backups from '../backups.js';
import { httpError } from '../servers.js';

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
