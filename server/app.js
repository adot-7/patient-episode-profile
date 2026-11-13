import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSansysConnection, fetchEpisodePatient, fetchPatientShell } from './sansys.js';
import { generateEpisodeSummary, generateLongitudinalSummary } from './ai.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function appMountPath() {
  const configured = String(process.env.APP_BASE_PATH || '/').trim();
  const segments = configured.split('/').filter(Boolean);
  return segments.length ? `/${segments.join('/')}` : '';
}

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '100kb' }));
  const mountPath = appMountPath();
  const apiPath = `${mountPath}/api` || '/api';

  app.get(`${apiPath}/health`, (_req, res) => res.json({ ok: true, service: 'patient-episode-profile', aiProvider: process.env.AI_PROVIDER || 'auto', revision: process.env.RENDER_GIT_COMMIT || process.env.APP_REVISION || null }));
  app.get(`${apiPath}/health/sansys`, async (_req, res, next) => {
    try {
      res.json(await checkSansysConnection());
    } catch (error) {
      next(error);
    }
  });
  app.get(`${apiPath}/patients/:dfn/shell`, async (req, res, next) => {
    try {
      res.json(await fetchPatientShell(req.params.dfn, req.query.episodeId));
    } catch (error) {
      next(error);
    }
  });
  app.get(`${apiPath}/patients/:dfn`, async (req, res, next) => {
    try {
      res.json(await fetchEpisodePatient(req.params.dfn, req.query.episodeId, {
        includeNoteDetails: req.query.includeNoteDetails !== 'false',
      }));
    } catch (error) {
      next(error);
    }
  });
  app.post(`${apiPath}/patients/:dfn/longitudinal-summary`, async (req, res, next) => {
    try {
      const shell = await fetchPatientShell(req.params.dfn);
      const requestedIds = Array.isArray(req.body?.episodeIds)
        ? new Set(req.body.episodeIds.map((id) => String(id)))
        : null;
      const selectedEpisodes = (shell.episodes || []).filter((episode) => !requestedIds || requestedIds.has(episode.id)).slice(0, 30);
      if (!selectedEpisodes.length) {
        return res.status(400).json({ error: 'No selected episodes are available for a longitudinal summary.' });
      }

      const patients = [];
      const failures = [];
      let cursor = 0;
      const worker = async () => {
        while (cursor < selectedEpisodes.length) {
          const episode = selectedEpisodes[cursor];
          cursor += 1;
          try {
            patients.push(await fetchEpisodePatient(req.params.dfn, episode.id, { includeNoteDetails: true }));
          } catch (error) {
            failures.push({ episodeId: episode.id, error: error.message || 'Episode data could not be loaded.' });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(2, selectedEpisodes.length) }, worker));
      if (!patients.length) throw Object.assign(new Error('No episode records could be loaded to build the longitudinal summary.'), { status: 502 });

      const generated = await generateLongitudinalSummary(patients, { regenerate: req.body?.regenerate === true });
      const backgroundHistory = [...new Map(patients.flatMap((patient) => patient.backgroundHistory || []).map((item) => [JSON.stringify(item), item])).values()];
      return res.json({
        ...generated,
        backgroundHistory,
        coverage: {
          requestedEpisodes: selectedEpisodes.length,
          summarizedEpisodes: patients.length,
          failedEpisodes: failures,
          truncated: (shell.episodes || []).length > selectedEpisodes.length,
        },
      });
    } catch (error) {
      return next(error);
    }
  });
  app.post(`${apiPath}/patients/:dfn/episode-summary`, async (req, res, next) => {
    try {
      const patient = await fetchEpisodePatient(req.params.dfn, req.body?.episodeId, { includeNoteDetails: true });
      res.json(await generateEpisodeSummary(patient, { regenerate: req.body?.regenerate === true }));
    } catch (error) {
      next(error);
    }
  });

  // Clinical data remains read-only; the only write-like route generates a transient AI view.
  app.use(apiPath, (_req, res) => res.status(405).set('Allow', 'GET, POST').json({ error: 'Unsupported profile API request.' }));
  app.use((error, req, res, _next) => {
    const status = Number(error.status) || 500;
    const message = error.message || 'Clinical data request failed.';
    console.error(`[profile-api] ${req.method} ${req.originalUrl} -> ${status}: ${message}`);
    res.status(status).json({ error: message });
  });

  const dist = path.join(here, '..', 'dist');
  app.use(mountPath || '/', express.static(dist));
  const sendIndex = (_req, res) => res.sendFile(path.join(dist, 'index.html'), (error) => {
    if (error) res.status(503).send('Patient profile UI is not built. Run npm run build first.');
  });
  if (mountPath) {
    app.get(mountPath, sendIndex);
    app.get(`${mountPath}/*`, sendIndex);
  } else {
    app.get('*', sendIndex);
  }
  return app;
}
