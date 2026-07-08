// api/portfolio.js
// Public portfolio viewer — GET /api/portfolio?slug=<share_slug>
//
// Returns the public profile + non-sold portfolio items for any user
// who has share_enabled = true on their profile.
//
// Required env vars (Vercel dashboard):
//   SUPABASE_URL          — your Supabase project URL
//   SUPABASE_ANON_KEY     — Supabase anon/public key (safe for read-only queries)

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL      = (process.env.SUPABASE_URL      || '').replace(/\/+$/, '');
  const SUPABASE_ANON_KEY = (process.env.SUPABASE_ANON_KEY || '').trim();

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return res.status(503).json({ error: 'Supabase environment variables are not configured.' });
  }

  // ── Fix: always pass both apikey header AND Authorization header ──
  // Without apikey, Supabase returns:
  //   { "message": "No API key found in request", "hint": "No `apikey` request header …" }
  const sbHeaders = {
    'apikey':        SUPABASE_ANON_KEY,          // ← required by PostgREST
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type':  'application/json',
    'Accept':        'application/json',
  };

  const { slug } = req.query;
  if (!slug || typeof slug !== 'string' || !/^[a-zA-Z0-9_-]{1,50}$/.test(slug.trim())) {
    return res.status(400).json({ error: 'Missing or invalid slug parameter.' });
  }

  const cleanSlug = slug.trim().toLowerCase();

  try {
    // 1. Look up the profile by share_slug OR username (RLS allows this only
    //    if share_enabled = true).
    // v29 FIX: the app's share link always falls back to displaying
    // "/p/<username>" when a custom slug hasn't been set. Previously this
    // lookup only matched share_slug, so any profile whose share_slug was
    // still null (e.g. sharing enabled but slug not yet saved) produced a
    // false "Portfolio not found or sharing is disabled." for a link that
    // looked correct. Matching either column makes the lookup match what's
    // actually shown to the user.
    const profileUrl = `${SUPABASE_URL}/rest/v1/profiles`
      + `?or=(share_slug.eq.${encodeURIComponent(cleanSlug)},username.eq.${encodeURIComponent(cleanSlug)})`
      + `&share_enabled=eq.true`
      + `&select=id,username,is_premium,share_slug,created_at`
      + `&limit=1`;

    const profileRes  = await fetch(profileUrl, { headers: sbHeaders });
    const profileData = await profileRes.json();

    if (!profileRes.ok) {
      console.error('Supabase profile lookup error:', profileData);
      return res.status(502).json({ error: 'Failed to fetch profile.' });
    }

    const profile = Array.isArray(profileData) ? profileData[0] : null;
    if (!profile) {
      return res.status(404).json({ error: 'Portfolio not found or sharing is disabled.' });
    }

    // 2. Fetch non-sold portfolio items for this user
    //    RLS policy "Public can view shared portfolio items" allows this
    const itemsUrl = `${SUPABASE_URL}/rest/v1/portfolio_items`
      + `?user_id=eq.${profile.id}`
      + `&sold=eq.false`
      + `&select=id,item_id,type,name,set_name,image_url,language,purchase_price,quantity,condition_or_grade,current_value,last_value_updated,created_at`
      + `&order=created_at.desc`;

    const itemsRes  = await fetch(itemsUrl, { headers: sbHeaders });
    const items     = await itemsRes.json();

    if (!itemsRes.ok) {
      console.error('Supabase items lookup error:', items);
      return res.status(502).json({ error: 'Failed to fetch portfolio items.' });
    }

    // Strip purchase_price from public response (privacy)
    const publicItems = (Array.isArray(items) ? items : []).map(item => ({
      id:                 item.id,
      item_id:            item.item_id,
      type:               item.type,
      name:               item.name,
      set_name:           item.set_name,
      image_url:          item.image_url,
      language:           item.language,
      quantity:           item.quantity,
      condition_or_grade: item.condition_or_grade,
      current_value:      item.current_value,
      last_value_updated: item.last_value_updated,
      created_at:         item.created_at,
      // purchase_price intentionally omitted
    }));

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');
    return res.status(200).json({
      profile: {
        username:   profile.username,
        is_premium: profile.is_premium,
        share_slug: profile.share_slug,
        created_at: profile.created_at,
      },
      items: publicItems,
      total: publicItems.length,
    });

  } catch (err) {
    console.error('portfolio route error:', err);
    return res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
};
