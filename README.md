# PokéVault v32

Pokémon card & sealed product portfolio tracker with live TCG prices, price history charts, graded card market data, trade analyser, P/L dashboard, and public portfolio sharing.

## What's new in v28

### Price history chart — fixed
- **Root cause**: v27 fetched without `includeHistory=true`, so `r.priceHistory` was always undefined and the chart had no data.
- **Fix**: The card detail chart now always fetches `includeHistory=true&days=365`, giving 365 days of data upfront so range buttons (1M/3M/6M/MAX) work without re-fetching.
- **New API shape handled**: Parses `priceHistory.conditions` keyed by condition name → date → `{ average, sevenDayAverage, count, totalValue, rollingWindow, … }`, using `sevenDayAverage` as the primary value (smoothed line) with `average` as fallback.
- **Graceful fallback**: If the conditions shape isn't present, falls back to the old flat `history[]` array, then to a spot price today.

### Compare function — restored and improved
- **Compare All button** added next to the grade dropdown / condition chips.
- For **raw/sealed cards**: clicking Compare All plots every condition (`Near Mint`, `Lightly Played`, `Moderately Played`, `Heavily Played`, `Damaged`) as separate coloured lines on the same chart.
- For **graded cards**: Compare All overlays both the raw condition history and all available grade lines (PSA 10, PSA 9, BGS, etc.) simultaneously.
- Clicking any individual condition chip or changing the dropdown deactivates compare mode and returns to single-line view.

### Condition chips (raw/sealed cards)
- When price history has multiple conditions, clickable chips appear above the chart so you can switch between conditions at a glance without a dropdown.
- Each chip uses the colour that represents that line on the compare chart.

### API proxy update (`api/pokeprice.js`)
- Added `from` and `to` to `ALLOWED_UPSTREAM_PARAMS` so explicit date-window requests (`from=2024-01-01&to=2024-06-30`) pass through to the upstream API cleanly.

## Stack

- **Frontend**: Vanilla HTML/CSS/JS (no build step)
- **Backend**: Vercel serverless functions (`/api/*.js`)
- **Database**: Supabase (Postgres)
- **Prices**: PokémonPriceTracker API v2 with eBay graded sales data

## Supabase schema

Run `supabase_schema_v26.sql` against your Supabase project. No schema changes from v26/v27.

## API endpoints

| Endpoint | Method | Notes |
|---|---|---|
| `/api/pokeprice` | GET | Proxies PokémonPriceTracker API. `includeHistory=true` for price history, `includeEbay=true` for graded data. `from`/`to` for date windows. |
| `/api/search` | GET | Card search helper |
| `/api/portfolio` | GET/POST/PATCH/DELETE | Portfolio CRUD (requires auth) |
| `/api/auth` | POST | Auth helper |
| `/api/graded` | GET | Legacy endpoint (unused) |
