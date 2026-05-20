'use strict';

/**
 * Test ntfy notification delivery.
 * Usage: node scripts/test-ntfy.js [entry|win|loss|expired]
 * Reads NTFY_URL, NTFY_TOPIC, NTFY_TOKEN from env (or .env file).
 */

// Try to load .env if present
try { require('../node_modules/dotenv/config'); } catch {}

const { buildNtfyBody, buildNtfyHeaders, buildNtfyOutcomeBody, buildNtfyOutcomeHeaders } = require('../signals/alert-payload');

const NTFY_URL   = (process.env.NTFY_URL || 'https://ntfy.sh').replace(/\/$/, '');
const NTFY_TOPIC = process.env.NTFY_TOPIC || '';
const NTFY_TOKEN = process.env.NTFY_TOKEN || '';

if (!NTFY_TOPIC) {
  console.error('ERROR: NTFY_TOPIC env var not set');
  process.exit(1);
}

const mode = process.argv[2] || 'entry';

// ── Mock signal data ──────────────────────────────────────────────────────────
const mockSig = {
  id:            9999,
  instrument:    'MGC',
  direction:     'LONG',
  strategy_name: 'MGC_SCALP',
  entry:         3387.4,
  sl:            3383.2,
  tp1:           3392.8,
  tp2:           3397.5,
  tp3:           3401.0,
  rr:            1.6,
  session:       'NY Open',
  received_at:   new Date(Date.now() - 18 * 60000).toISOString(), // 18 min ago
};

// ── Mock canonical payload for entry ──────────────────────────────────────────
const mockPayload = {
  v:              2,
  instrument:     mockSig.instrument,
  direction:      mockSig.direction,
  strategy_name:  mockSig.strategy_name,
  quality: {
    tier:                'A',
    adjusted_confidence: 84,
    confidence:          82,
    quant_score:         76,
    quant_grade:         'A',
  },
  levels: {
    entry: mockSig.entry,
    sl:    mockSig.sl,
    tp1:   mockSig.tp1,
    tp2:   mockSig.tp2,
    tp3:   mockSig.tp3,
    rr:    mockSig.rr,
  },
  context: { session: mockSig.session },
  meta: { trigger_reason: 'VWAP reclaim + liquidity sweep + 3m confirmation' },
};

async function send(headers, body) {
  const url = `${NTFY_URL}/${NTFY_TOPIC}`;
  console.log(`\n→ Sending to ${url}`);
  console.log('Headers:', JSON.stringify({ ...headers, Authorization: headers.Authorization ? '[REDACTED]' : undefined }, null, 2));
  console.log('Body:\n' + body);

  const res = await fetch(url, { method: 'POST', headers, body });
  if (res.ok) {
    console.log(`\n✅ NOTIFICATION_SEND_SUCCESS HTTP ${res.status}`);
  } else {
    const text = await res.text().catch(() => '');
    console.error(`\n❌ NOTIFICATION_SEND_FAILED HTTP ${res.status} — ${text}`);
  }
}

(async () => {
  try {
    if (mode === 'entry') {
      console.log('=== TEST: TRADE_ENTRY notification ===');
      const body    = buildNtfyBody(mockPayload);
      const headers = buildNtfyHeaders(mockPayload, { ntfyToken: NTFY_TOKEN });
      await send(headers, body);

    } else if (mode === 'win') {
      console.log('=== TEST: TRADE_WIN notification ===');
      const body    = buildNtfyOutcomeBody('TRADE_WIN', mockSig, {
        exitPrice: mockSig.tp1,
        exitAt:    new Date().toISOString(),
        pnlPts:    +(mockSig.tp1 - mockSig.entry).toFixed(2),
      });
      const headers = buildNtfyOutcomeHeaders('TRADE_WIN', mockSig, { ntfyToken: NTFY_TOKEN });
      await send(headers, body);

    } else if (mode === 'loss') {
      console.log('=== TEST: TRADE_LOSS notification ===');
      const body    = buildNtfyOutcomeBody('TRADE_LOSS', mockSig, {
        exitPrice: mockSig.sl,
        exitAt:    new Date().toISOString(),
        pnlPts:    +(mockSig.sl - mockSig.entry).toFixed(2),
      });
      const headers = buildNtfyOutcomeHeaders('TRADE_LOSS', mockSig, { ntfyToken: NTFY_TOKEN });
      await send(headers, body);

    } else if (mode === 'expired') {
      console.log('=== TEST: TRADE_EXPIRED_MARKET_CLOSE notification ===');
      const body    = buildNtfyOutcomeBody('TRADE_EXPIRED_MARKET_CLOSE', mockSig, {
        exitAt:    new Date().toISOString(),
        expReason: 'EXPIRED_MARKET_CLOSE',
      });
      const headers = buildNtfyOutcomeHeaders('TRADE_EXPIRED_MARKET_CLOSE', mockSig, { ntfyToken: NTFY_TOKEN });
      await send(headers, body);

    } else {
      console.error(`Unknown mode: ${mode}. Use: entry | win | loss | expired`);
      process.exit(1);
    }
  } catch (err) {
    console.error('Test failed:', err.message);
    process.exit(1);
  }
})();
