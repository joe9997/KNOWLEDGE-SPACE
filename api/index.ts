// Vercel Serverless Function entry for the Express API.
// server/index.ts already exports `app` and guards app.listen() with `if (!process.env.VERCEL)`.
import server from '../server/index.js';

export default server;
