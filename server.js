'use strict';
/**
 * server.js — the web server. It does three jobs:
 *   1. serves the static website in /public
 *   2. exposes POST /api/simplify (the actual product)
 *   3. exposes GET  /api/status   (tells the page which engine is active + runs left)
 *
 * Privacy note: pasted code is processed in memory and never written to disk
 * or logged. Keep it that way if you extend this.
 */

const express = require('express');
const path = require('path');
const { MODES, LEVELS } = require('./lib/prompt');
const { simplifyWithLLM } = require('./lib/llm');
const { simplifyRuleBased } = require('./lib/engine');
const { formatCode } = require('./lib/format');
const { createLimiter } = require('./lib/rateLimit');

// ---- Configuration (override with environment variables) -------------------
const PORT = Number(process.env.PORT) || 3000;
const FREE_RUNS_PER_DAY = Number(process.env.FREE_RUNS_PER_DAY) || 5;
const MAX_CHARS = Number(process.env.MAX_CHARS) || 20000;

const LANGUAGES = [
  'python', 'javascript', 'typescript', 'java', 'csharp', 'go',
  'rust', 'php', 'ruby', 'bash', 'sql', 'html', 'css', 'json',
];

const limiter = createLimiter(FREE_RUNS_PER_DAY);
setInterval(() => limiter.sweep(), 60 * 60 * 1000).unref();

const app = express();

// Behind Vercel/Render/nginx, the real visitor IP is in X-Forwarded-For.
// Set TRUST_PROXY=1 in production so req.ip is correct (otherwise everyone shares one limit).
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY));

app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

// Basic security headers.
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'self'; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; " +
      "font-src https://fonts.gstatic.com; script-src 'self'; img-src 'self' data:",
  });
  next();
});

const hasApiKey = () => Boolean(process.env.ANTHROPIC_API_KEY);

app.get('/api/status', (req, res) => {
  res.json({
    engine: hasApiKey() ? 'ai' : 'rules',
    limit: limiter.limit,
    remaining: limiter.remaining(req.ip),
    maxChars: MAX_CHARS,
    languages: LANGUAGES,
  });
});

app.post('/api/simplify', async (req, res) => {
  const { code, language, mode = 'simplify', level = 'beginner' } = req.body || {};

  // ---- 1. Validate everything: never trust data from the browser ----------
  if (typeof code !== 'string' || !code.trim()) {
    return res.status(400).json({ error: 'Paste some code first.' });
  }
  if (code.length > MAX_CHARS) {
    return res.status(413).json({ error: `Code is too long (max ${MAX_CHARS} characters).` });
  }
  if (!LANGUAGES.includes(language)) {
    return res.status(400).json({ error: 'Unsupported language.' });
  }
  if (!MODES.includes(mode) || !(level in LEVELS)) {
    return res.status(400).json({ error: 'Invalid mode or level.' });
  }

  // ---- 2. Rate limit -------------------------------------------------------
  if (!limiter.consume(req.ip)) {
    return res.status(429).json({
      error: `You've used all ${limiter.limit} free runs for today. Come back tomorrow.`,
      remaining: 0,
    });
  }

  // ---- 3. Do the work ------------------------------------------------------
  try {
    let result;
    if (hasApiKey()) {
      result = await simplifyWithLLM({ code, language, mode, level });
    } else {
      if (mode === 'explain') {
        limiter.refund(req.ip);
        return res.status(503).json({
          error: 'Explain mode needs the AI engine. Set ANTHROPIC_API_KEY on the server.',
        });
      }
      result = await simplifyRuleBased({ code, language });
    }

    const finalCode = result.code ? await formatCode(result.code, language) : '';
    res.json({
      code: finalCode,
      notes: mode === 'simplify' && hasApiKey() ? '' : result.notes,
      engine: hasApiKey() ? 'ai' : result.engine,
      remaining: limiter.remaining(req.ip),
    });
  } catch (err) {
    limiter.refund(req.ip); // don't charge a run when we failed
    console.error('simplify failed:', err.message);
    res.status(502).json({ error: err.message || 'Something went wrong.' });
  }
});

// ---- Static site -------------------------------------------------------------
// extensions: ['html'] lets /how and /tool work as well as /how.html and /tool.html
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// Unknown API routes get JSON, not the HTML page.
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// Last-resort error handler (e.g. malformed JSON body).
app.use((err, req, res, next) => {
  const status = err.status || 500;
  res.status(status).json({ error: status === 500 ? 'Server error.' : 'Bad request.' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`PlainCode running on http://localhost:${PORT}`);
    console.log(`Engine: ${hasApiKey() ? 'AI (Anthropic)' : 'offline (no ANTHROPIC_API_KEY set)'}`);
  });
}

module.exports = app; // exported so tests can start it on a random port
