import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3002);
const backend = process.env.SANSYS_BACKEND_URL || 'http://localhost:3001';

app.use('/api', async (req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.set('Allow', 'GET, HEAD').status(405).json({ error: 'This clinical profile is read-only.' });
    return;
  }
  try {
    const url = new URL(req.originalUrl, backend);
    const upstream = await fetch(url, {
      method: req.method,
      headers: { Accept: req.get('accept') || 'application/json' },
      signal: AbortSignal.timeout(120000),
    });
    res.status(upstream.status);
    const contentType = upstream.headers.get('content-type');
    if (contentType) res.set('Content-Type', contentType);
    if (req.method === 'HEAD') res.end();
    else res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) {
    console.error(`[profile-api] upstream unavailable: ${error.message}`);
    res.status(502).json({ error: 'Sansys clinical data service is unavailable.' });
  }
});

const dist = path.join(here, '..', 'dist');
app.use(express.static(dist));
app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html'), (error) => {
  if (error) res.status(503).send('Patient profile UI is not built. Run npm run build first.');
}));

app.listen(port, () => {
  console.log(`Patient Episode Profile listening on http://localhost:${port}`);
  console.log(`Read-only Sansys API bridge: ${backend}`);
});
