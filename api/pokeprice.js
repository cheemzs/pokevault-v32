// api/pokeprice.js
// Vercel serverless proxy for PokémonPriceTracker API v2.
//
// Required env vars (set in Vercel dashboard):
//   POKEPRICE_API_KEY      — PokémonPriceTracker API bearer token
//   SUPABASE_URL           — your Supabase project URL
//   SUPABASE_SERVICE_KEY   — Supabase service_role key (never sent to client)

const BASE = 'https://www.pokemonpricetracker.com/api/v2';

// Exhaustive list of parameters the upstream API actually accepts.
// Any key NOT in this set is silently dropped before the request is sent.
const ALLOWED_UPSTREAM_PARAMS = new Set([
  'tcgPlayerId',
  'search',
  'setId',
  'setName',
  'set',
  'minPrice',
  'maxPrice',
  'limit',
  'offset',
  'sortBy',
  'sortOrder',
  'includeHistory',
  'days',
  'from',          // v28: start date for history window (YYYY-MM-DD)
  'to',            // v28: end date for history window (YYYY-MM-DD)
  'fetchAllInSet',
  'language',
  'includeEbay',   // v25 fix: enables eBay graded card sales data (PSA, CGC, BGS, SGC)
]);

// ── Limit cap logic ───────────────────────────────────────────────────────────
// Standard:                     max 200
// includeHistory=true:          max 100
// includeEbay=true:             max 50 (eBay calls are heavier upstream)
function resolvedLimit(raw, wantHistory, wantEbay) {
  const requested = parseInt(raw, 10) || 20;
  if (wantHistory) return Math.min(requested, 100);
  if (wantEbay)    return Math.min(requested, 50);
  return Math.min(requested, 200);
}

// ── Safe URLSearchParams builder ──────────────────────────────────────────────
// Accepts an object of candidate key/value pairs, drops any key not in
// ALLOWED_UPSTREAM_PARAMS, then returns a URLSearchParams instance.
function safeParams(candidates) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(candidates)) {
    if (v == null || v === '') continue;
    if (!ALLOWED_UPSTREAM_PARAMS.has(k)) {
      console.warn(`[pokeprice proxy] Dropping disallowed param: ${k}`);
      continue;
    }
    p.set(k, String(v));
  }
  return p;
}

// ── Supabase cache writer ─────────────────────────────────────────────────────
// Writes price rows to price_history_cache using the service_role key.
// Non-fatal: if this fails the response still goes to the client.
async function sbInsertCacheRows(rows) {
  const SUPABASE_URL        = (process.env.SUPABASE_URL         || '').replace(/\/+$/, '');
  const SUPABASE_SERVICE_KEY = (process.env.SUPABASE_SERVICE_KEY || '').trim();
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !rows.length) return;

  const url = `${SUPABASE_URL}/rest/v1/price_history_cache`;
  try {
    await fetch(url, {
      method:  'POST',
      headers: {
        'apikey':        SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'resolution=ignore-duplicates',
      },
      body: JSON.stringify(rows),
    });
  } catch (e) {
    console.warn('[pokeprice proxy] cache write failed:', e.message);
  }
}

module.exports = async function handler(req, res) {
  // CORS — allows the browser to call /api/pokeprice from the same Vercel domain
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.POKEPRICE_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      error: 'POKEPRICE_API_KEY is not set in Vercel environment variables.',
    });
  }

  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Accept': 'application/json',
  };

  // Destructure only params we actually intend to use internally.
  // Any others that arrive from the client are simply ignored.
  const {
    action,
    name,
    set,
    id,
    language,
    days,
    from,          // v28: history start date
    to,            // v28: history end date
    includeHistory,
    includeEbay,       // v25 fix: forwarded through to upstream
    limit: clientLimit,
    offset,
    sortBy,
    sortOrder,
  } = req.query;

  const lang        = language === 'japanese' ? 'japanese' : 'english';
  const wantHistory = includeHistory === 'true';
  const wantEbay    = includeEbay    === 'true';
  const historyDays = Math.min(parseInt(days, 10) || 30, 365);

  // ── Validate action ───────────────────────────────────────────────────────
  const VALID_ACTIONS = new Set(['search', 'bynumber', 'sealed', 'card']);
  if (!action || !VALID_ACTIONS.has(action)) {
    return res.status(400).json({
      error: 'Invalid action. Valid values: search | bynumber | sealed | card',
    });
  }

  // ── action=search  (card name / set search) ───────────────────────────────
  if (action === 'search') {
    if (!name) return res.status(400).json({ error: 'Missing param: name' });

    const searchStr = set ? `${name.trim()} ${set.trim()}` : name.trim();
    const lim       = resolvedLimit(clientLimit || 20, wantHistory, wantEbay);

    const candidates = {
      language:      lang,
      search:        searchStr,
      limit:         lim,
    };
    if (wantHistory)  { candidates.includeHistory = 'true'; candidates.days = String(historyDays); }
    if (wantEbay)       candidates.includeEbay    = 'true';   // v25 fix: pass through to upstream
    if (offset)         candidates.offset         = offset;
    if (sortBy)         candidates.sortBy         = sortBy;
    if (sortOrder)      candidates.sortOrder      = sortOrder;

    const params   = safeParams(candidates);
    const url      = `${BASE}/cards?${params}`;

    let results;
    try {
      const upstream = await fetch(url, { headers });
      if (!upstream.ok) {
        const body = await upstream.text();
        console.error('[pokeprice search] upstream error:', upstream.status, body.slice(0, 200));
        return res.status(502).json({ error: 'Upstream API error', status: upstream.status });
      }
      const json = await upstream.json();
      results = Array.isArray(json) ? json : (json.results || json.data || []);
    } catch (err) {
      console.error('[pokeprice search] fetch error:', err.message);
      return res.status(502).json({ error: 'Failed to reach upstream API', detail: err.message });
    }

    // Cache non-eBay price rows (raw market prices only)
    if (!wantEbay) {
      const today     = new Date().toISOString().split('T')[0];
      const priceRows = results
        .map(r => {
          const price = r.prices?.market ?? r.prices?.midPrice ?? r.japanesePrice ?? r.averagePrice ?? null;
          const itemId = String(r.tcgPlayerId || r.id || r.productId || '');
          if (!price || !itemId) return null;
          return { item_id: itemId, type: 'card', price, language: lang, recorded_date: today };
        })
        .filter(Boolean);
      if (priceRows.length) sbInsertCacheRows(priceRows);
    }

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    return res.status(200).json({ results });
  }

  // ── action=bynumber  (exact card number, e.g. 199/165) ───────────────────
  if (action === 'bynumber') {
    if (!name) return res.status(400).json({ error: 'Missing param: name (card number)' });

    const candidates = {
      language: lang,
      search:   name.trim(),
      limit:    resolvedLimit(clientLimit || 5, false, false),
    };
    if (set)    candidates.set    = set.trim();
    if (offset) candidates.offset = offset;

    const params   = safeParams(candidates);
    const url      = `${BASE}/cards?${params}`;

    try {
      const upstream = await fetch(url, { headers });
      if (!upstream.ok) {
        const body = await upstream.text();
        return res.status(502).json({ error: 'Upstream API error', status: upstream.status });
      }
      const json = await upstream.json();
      const results = Array.isArray(json) ? json : (json.results || json.data || []);
      res.setHeader('Cache-Control', 's-maxage=600');
      return res.status(200).json({ results });
    } catch (err) {
      return res.status(502).json({ error: 'Failed to reach upstream API', detail: err.message });
    }
  }

  // ── action=sealed  (sealed products — MUST use /sealed-products endpoint) ─
  if (action === 'sealed') {
    const candidates = { language: lang };
    if (name) candidates.search = name.trim();
    if (set)  candidates.set    = set.trim();
    candidates.limit = resolvedLimit(clientLimit || 20, false, false);
    if (offset) candidates.offset = offset;

    const params   = safeParams(candidates);
    const url      = `${BASE}/sealed-products?${params}`;

    try {
      const upstream = await fetch(url, { headers });
      if (!upstream.ok) {
        const body = await upstream.text();
        return res.status(502).json({ error: 'Upstream API error', status: upstream.status });
      }
      const json = await upstream.json();
      const results = Array.isArray(json) ? json : (json.results || json.data || []);

      // Cache sealed product prices
      const today     = new Date().toISOString().split('T')[0];
      const priceRows = results
        .map(r => {
          const price  = r.unopenedPrice ?? r.price ?? null;
          const itemId = String(r.tcgPlayerId || r.id || r.productId || '');
          if (!price || !itemId) return null;
          return { item_id: itemId, type: 'sealed', price, language: lang, recorded_date: today };
        })
        .filter(Boolean);
      if (priceRows.length) sbInsertCacheRows(priceRows);

      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
      return res.status(200).json({ results });
    } catch (err) {
      return res.status(502).json({ error: 'Failed to reach upstream API', detail: err.message });
    }
  }

  // ── action=card  (single card by TCGPlayer ID) ────────────────────────────
  if (action === 'card') {
    if (!id) return res.status(400).json({ error: 'Missing param: id' });

    const candidates = {
      tcgPlayerId:    id,
      language:       lang,
    };
    if (wantHistory) { candidates.includeHistory = 'true'; candidates.days = String(historyDays); }
    if (from) candidates.from = from;  // v28: explicit date window start
    if (to)   candidates.to   = to;    // v28: explicit date window end

    const params   = safeParams(candidates);
    const url      = `${BASE}/cards?${params}`;

    try {
      const upstream = await fetch(url, { headers });
      if (!upstream.ok) {
        return res.status(502).json({ error: 'Upstream API error', status: upstream.status });
      }
      const json = await upstream.json();
      const results = Array.isArray(json) ? json : (json.results || json.data || [json]);
      res.setHeader('Cache-Control', 's-maxage=600');
      return res.status(200).json({ results });
    } catch (err) {
      return res.status(502).json({ error: 'Failed to reach upstream API', detail: err.message });
    }
  }

  return res.status(400).json({
    error: 'Invalid action. Valid values: search | bynumber | sealed | card',
  });
};
