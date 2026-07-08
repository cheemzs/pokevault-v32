// api/search.js
// Vercel serverless proxy — simple card search forwarded to PokémonPriceTracker API v2.
// Used by any legacy callers that still hit /api/search directly.
// New code should use /api/pokeprice?action=search instead.

const BASE_URL = 'https://www.pokemonpricetracker.com/api/v2';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.POKEPRICE_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      error: 'API key not configured. Set POKEPRICE_API_KEY in Vercel environment variables.',
    });
  }

  const { search, language, limit, set, tcgPlayerId } = req.query;

  const params = new URLSearchParams();
  if (search)      params.set('search',      search.trim());
  if (language)    params.set('language',    language === 'japanese' ? 'japanese' : 'english');
  if (limit)       params.set('limit',       String(Math.min(Number(limit) || 20, 50)));
  if (set)         params.set('set',         set.trim());
  if (tcgPlayerId) params.set('tcgPlayerId', tcgPlayerId.trim());
  if (!params.has('limit')) params.set('limit', '24');

  try {
    const response = await fetch(`${BASE_URL}/cards?${params}`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
      },
    });

    const body = await response.text();
    if (!response.ok) {
      return res.status(response.status).json({ error: 'Upstream API error', detail: body });
    }

    const data  = JSON.parse(body);
    const cards = Array.isArray(data.data) ? data.data : (data.data ? [data.data] : []);

    res.setHeader('Cache-Control', 's-maxage=180, stale-while-revalidate=60');
    return res.status(200).json({ cards, metadata: data.metadata || {}, total: cards.length });
  } catch (err) {
    console.error('search proxy error:', err);
    return res.status(500).json({ error: 'Proxy fetch failed', detail: err.message });
  }
}
