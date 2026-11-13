import { loadServerEnvironment } from './environment.js';

loadServerEnvironment();
// Provider URLs, models and timeouts are initialized when these modules load.
const { createApp } = await import('./app.js');

const port = Number(process.env.PORT || 3002);

createApp().listen(port, () => {
  console.log(`Patient Episode Profile listening on http://localhost:${port}`);
  console.log(`AI provider mode: ${process.env.AI_PROVIDER || 'auto'}`);
  console.log(`Direct Sansys API: ${process.env.SANSYS_BASE_URL || 'http://182.70.249.137:5050'}`);
});
