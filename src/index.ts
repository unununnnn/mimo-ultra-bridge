import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { AccountPool } from './browser/accountPool';
import { UltraPageDriver } from './browser/ultraDriver';
import { createOpenAIRouter } from './routes/openai';
import { createAnthropicRouter } from './routes/anthropic';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const allowedKeys = new Set(
  (process.env.API_KEYS || 'sk-mimo-ultra')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
);

/**
 * Supports both OpenAI (`Authorization: Bearer <key>`) and Anthropic (`x-api-key: <key>`) authentication headers.
 */
function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.path === '/healthz') {
    next();
    return;
  }

  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '').trim();
  const xApiKey = (req.headers['x-api-key'] as string | undefined)?.trim();
  const token = bearer || xApiKey;

  if (allowedKeys.size > 0 && (!token || !allowedKeys.has(token))) {
    res.status(401).json({
      error: {
        message: 'Invalid API key. Provide Authorization: Bearer <key> or x-api-key: <key>.',
        type: 'authentication_error',
      },
    });
    return;
  }
  next();
}

const pool = new AccountPool();
const driver = new UltraPageDriver(pool);

app.get('/healthz', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    targetUrl: process.env.MIMO_ULTRA_URL || 'https://aistudio.xiaomimimo.com/#/ultra',
    accountsCount: pool.listAccounts().length,
  });
});

app.use('/v1', apiKeyAuth, createOpenAIRouter(driver, pool));
app.use('/v1', apiKeyAuth, createAnthropicRouter(driver));

const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || '127.0.0.1';

const server = app.listen(port, host, () => {
  console.log(`\n=============================================================`);
  console.log(`🚀 MiMo Ultra Playwright Bridge running on http://${host}:${port}`);
  console.log(`   • Target Page : ${process.env.MIMO_ULTRA_URL || 'https://aistudio.xiaomimimo.com/#/ultra'}`);
  console.log(`   • OpenAI API  : http://${host}:${port}/v1/chat/completions`);
  console.log(`   • Anthropic   : http://${host}:${port}/v1/messages`);
  console.log(`   • Account Pool: ${pool.listAccounts().length} profile(s) loaded`);
  console.log(`=============================================================\n`);
});

const shutdown = async () => {
  console.log('\n[MiMo Ultra Bridge] Shutting down browser sessions...');
  await driver.closeAll();
  server.close(() => process.exit(0));
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
