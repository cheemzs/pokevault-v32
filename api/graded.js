// api/graded.js
// v25: this endpoint is no longer used. Graded card pricing (PSA/CGC/BGS)
// is now fetched directly via /api/pokeprice?includeEbay=true, which returns
// graded price data from PokémonPriceTracker without needing an EBAY_APP_ID.
//
// This stub is kept so any stale client calls get a clear error instead of a 404.

module.exports = function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  return res.status(410).json({
    error: 'This endpoint is deprecated in v25.',
    hint:  'Graded pricing is now served via /api/pokeprice?action=search&includeEbay=true',
  });
};
