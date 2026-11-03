import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSansysConnection, fetchEpisodePatient, fetchPatientShell } from './sansys.js';
import { generateEpisodeSummary } from './ai.js';

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

  app.get(`${apiPath}/health`, (_req, res) => res.json({ ok: true, service: 'patient-episode-profile' }));
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
  app.post(`${apiPath}/patients/:dfn/episode-summary`, async (req, res, next) => {
    try {
      const patient = await fetchEpisodePatient(req.params.dfn, req.body?.episodeId, { includeNoteDetails: true });
      res.json(await generateEpisodeSummary(patient));
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
