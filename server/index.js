import 'dotenv/config';
import { createApp } from './app.js';

const port = Number(process.env.PORT || 3002);

createApp().listen(port, () => {
  console.log(`Patient Episode Profile listening on http://localhost:${port}`);
  console.log(`Direct Sansys API: ${process.env.SANSYS_BASE_URL || 'http://182.70.249.137:5050'}`);
});
