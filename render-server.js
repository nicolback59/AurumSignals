'use strict';

/**
 * RENDER FRONTEND SERVER
 *
 * Serves static HTML/CSS/JS files and transparently proxies ALL
 * other requests (API, auth, webhooks, SSE) to the Droplet backend.
 *
 * Browser → Render (this file) → Droplet (server.js)
 *
 * Cookies, sessions, and SSE streams all pass through transparently.
 * The browser never talks directly to the Droplet.
 *
 * Required env var:
 *   DROPLET_URL  — full base URL of the Droplet, e.g. http://165.232.1.2:3000
 */

const express = require('express');
const http    = require('http');
const https   = require('https');
const path    = require('path');

const PORT        = process.env.PORT        || 3001;
const DROPLET_URL = (process.env.DROPLET_URL || '').replace(/\/$/, '');

if (!DROPLET_URL) {
  console.error('[render-server] FATAL: DROPLET_URL env var is required');
  console.error('  Set it to your Droplet address, e.g.: http://165.232.1.2:3000');
  process.exit(1);
}

let targetUrl;
try {
  targetUrl = new URL(DROPLET_URL);
} catch {
  console.error('[render-server] FATAL: DROPLET_URL is not a valid URL:', DROPLET_URL);
  process.exit(1);
}

const TARGET_HOSTNAME = targetUrl.hostname;
const TARGET_PORT     = targetUrl.port
  ? parseInt(targetUrl.port)
  : (targetUrl.protocol === 'https:' ? 443 : 80);
const TARGET_PROTOCOL = targetUrl.protocol;  // 'http:' or 'https:'
const httpLib         = TARGET_PROTOCOL === 'https:' ? https : http;

const app = express();

// ── Static assets (CSS, JS, images — NOT html routes) ────────────────────────
// Serve files with a known extension directly without going through the proxy.
app.use(express.static(path.join(__dirname), {
  index:      false,
  extensions: false,
  setHeaders: (res, filePath) => {
    // CSS/JS gets a short cache; everything else defaults
    if (/\.(css|js)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=300');
    }
  },
}));

// ── HTML page routes ──────────────────────────────────────────────────────────
const PAGE_ROUTES = {
  '/':                 'home.html',
  '/landing':          'landing.html',
  '/pricing':          'pricing.html',
  '/login':            'login.html',
  '/register':         'register.html',
  '/signals':          'dashboard.html',
  '/trades':           'trades.html',
  '/stats':            'stats.html',
  '/calendar':         'calendar.html',
  '/backtest':         'backtest-dashboard.html',
  '/journal':          'journal.html',
  '/reports':          'reports.html',
  '/news':             'news.html',
  '/setup':            'setup.html',
  '/forgot-password':  'forgot-password.html',
  '/reset-password':   'reset-password.html',
};

for (const [route, file] of Object.entries(PAGE_ROUTES)) {
  app.get(route, (req, res) => {
    res.sendFile(path.join(__dirname, file));
  });
}

// ── Transparent proxy — forwards everything else to the Droplet ───────────────
app.use((req, res) => {
  const isSSE = req.headers.accept?.includes('text/event-stream');

  const proxyOptions = {
    hostname: TARGET_HOSTNAME,
    port:     TARGET_PORT,
    path:     req.url,
    method:   req.method,
    headers:  {
      ...req.headers,
      host:             `${TARGET_HOSTNAME}:${TARGET_PORT}`,
      'x-forwarded-for':  req.ip || req.socket?.remoteAddress || '',
      'x-forwarded-host': req.headers.host || '',
      'x-forwarded-proto': req.protocol || 'https',
    },
  };

  // SSE: disable compression/buffering so events reach the browser immediately
  if (isSSE) {
    proxyOptions.headers['accept-encoding'] = 'identity';
  }

  const proxyReq = httpLib.request(proxyOptions, (proxyRes) => {
    // Forward all response headers (including Set-Cookie for auth sessions)
    res.writeHead(proxyRes.statusCode, proxyRes.headers);

    if (isSSE) {
      // Flush each chunk immediately — don't buffer SSE frames
      proxyRes.on('data', chunk => {
        res.write(chunk);
        if (typeof res.flush === 'function') res.flush();
      });
      proxyRes.on('end',   () => res.end());
      proxyRes.on('error', () => res.end());
    } else {
      proxyRes.pipe(res, { end: true });
    }
  });

  proxyReq.on('error', (err) => {
    console.error(`[proxy] ${req.method} ${req.url} → ${err.message}`);
    if (!res.headersSent) {
      res.status(502).json({
        error:   'Backend unavailable',
        message: err.message,
        droplet: DROPLET_URL,
      });
    }
  });

  // Stream request body to Droplet (handles POST/PUT/PATCH with JSON bodies)
  req.pipe(proxyReq, { end: true });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Aurum Signals (Render frontend) → http://localhost:${PORT}`);
  console.log(`Proxying API/auth/webhooks     → ${DROPLET_URL}`);
});
