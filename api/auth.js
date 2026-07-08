// api/auth.js — Supabase Admin API proxy for user creation
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  // Strip trailing slash and validate env vars
  const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const SERVICE_KEY  = (process.env.SUPABASE_SERVICE_KEY || '').trim();

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(503).json({
      error: !SUPABASE_URL
        ? 'SUPABASE_URL is not set in Vercel environment variables.'
        : 'SUPABASE_SERVICE_KEY is not set in Vercel environment variables.'
    });
  }

  // Parse body
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }
  if (!body) return res.status(400).json({ error: 'Empty request body' });

  const { action, username, password } = body;

  if (!action || !username || !password) {
    return res.status(400).json({ error: 'Missing fields: action, username, password' });
  }
  if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
    return res.status(400).json({ error: 'Invalid username. Use 3–30 letters, numbers, or underscores.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  if (action !== 'signup') {
    return res.status(400).json({ error: 'Invalid action.' });
  }

  const email = username.toLowerCase() + '@pokevault.app';
  const adminHeaders = {
    'apikey':        SERVICE_KEY,
    'Authorization': `Bearer ${SERVICE_KEY}`,
    'Content-Type':  'application/json',
  };

  const adminUrl   = `${SUPABASE_URL}/auth/v1/admin/users`;
  const signInUrl  = `${SUPABASE_URL}/auth/v1/token?grant_type=password`;

  // Create user via Admin API
  let createRes, createData;
  try {
    createRes  = await fetch(adminUrl, {
      method:  'POST',
      headers: adminHeaders,
      body:    JSON.stringify({ email, password, email_confirm: true, user_metadata: { username } }),
    });
    createData = await createRes.json();
  } catch (e) {
    return res.status(502).json({ error: 'Could not reach Supabase: ' + e.message });
  }

  if (!createRes.ok) {
    const detail = createData?.message || createData?.msg || JSON.stringify(createData);
    const isTaken = detail.toLowerCase().includes('already registered')
                 || detail.toLowerCase().includes('already exists')
                 || detail.toLowerCase().includes('duplicate');
    return res.status(createRes.status).json({
      error: isTaken ? 'That username is already taken. Try another.' : detail
    });
  }

  // ── Insert profiles row ───────────────────────────────────────────
  // The profiles table is NOT auto-populated by Supabase Auth triggers.
  // We must insert it manually here using the service_role key (bypasses RLS).
  // Without this row: share settings, portfolio chart anchor date, and the
  // premium badge check all fail silently for new accounts.
  const newUserId = createData?.id;
  if (newUserId) {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
        method:  'POST',
        headers: {
          'apikey':        SERVICE_KEY,
          'Authorization': `Bearer ${SERVICE_KEY}`,
          'Content-Type':  'application/json',
          'Prefer':        'resolution=ignore-duplicates',
        },
        body: JSON.stringify({
          id:           newUserId,
          username:     username.toLowerCase(),
          is_premium:   false,
          share_enabled: false,
          share_slug:   null,
        }),
      });
    } catch (profileErr) {
      // Non-fatal: user is created, profile insert failure is logged but
      // doesn't block sign-in. Profile will be re-creatable via upsert later.
      console.warn('profiles insert failed (non-fatal):', profileErr.message);
    }
  }

  // Auto sign-in
  try {
    const signInRes  = await fetch(signInUrl, {
      method:  'POST',
      headers: { 'apikey': SERVICE_KEY, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email, password }),
    });
    const signInData = await signInRes.json();
    if (signInRes.ok && signInData.access_token) {
      return res.status(200).json({
        created:       true,
        autoSignIn:    true,
        access_token:  signInData.access_token,
        refresh_token: signInData.refresh_token,
        expires_in:    signInData.expires_in,
      });
    }
  } catch (_) {}

  return res.status(200).json({ created: true, autoSignIn: false });
};
