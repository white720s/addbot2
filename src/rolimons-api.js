// Plain HTTP calls to Rolimons' public/semi-public API. Much lighter than
// driving a browser for these — we only use the browser (rolimons.js) for
// the verification/login flow, which genuinely requires it.

const fs = require('fs');
const path = require('path');

const SESSIONS_DIR = path.join(__dirname, '..', 'sessions');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Referer': 'https://www.rolimons.com/',
};

// Some owned items (often UGC items) aren't in Rolimons' public
// itemdetails catalog at all, even though their numeric item ID still
// works fine for posting trade ads (confirmed by successfully posting
// "Unknown Item 128217885" and having Rolimons accept it as Fall Fairy).
// This is a manual fallback table for known items so they display with
// a real name/acronym instead of "Unknown Item [id]". Add more entries
// here any time a new one is discovered.
const MANUAL_ITEM_NAMES = {
  '128217885': { name: 'Fall Fairy', acronym: 'FaFa' },
  '16477149823': { name: 'Gold Clockwork Headphones', acronym: 'GCWHP' },
  '110673146052704': { name: "Clockwork's Golden Shades", acronym: 'GCWS' },
  // '6589085795': intentionally left unmapped — name unknown so far.
};

// ---------- Item catalog cache ----------
// The full item list is the same for everyone and Rolimons asks bot
// developers to cache it rather than hit this endpoint per-keystroke.
let itemCatalogCache = null;
let itemCatalogFetchedAt = 0;
const CATALOG_TTL_MS = 5 * 60 * 1000; // refresh every 5 minutes

async function getItemCatalog() {
  const now = Date.now();
  if (itemCatalogCache && (now - itemCatalogFetchedAt) < CATALOG_TTL_MS) {
    return itemCatalogCache;
  }

  const res = await fetch('https://www.rolimons.com/itemapi/itemdetails', { headers: HEADERS });
  if (!res.ok) throw new Error(`itemdetails fetch failed: ${res.status}`);
  const data = await res.json();

  // data.items is { "itemId": [Name, Acronym, Rap, Value, ...] }
  const list = Object.entries(data.items || {}).map(([id, fields]) => ({
    id,
    name: fields[0],
    acronym: fields[1],
    rap: fields[2],
    value: fields[3],
  }));

  itemCatalogCache = list;
  itemCatalogFetchedAt = now;
  return list;
}

/**
 * Searches the global item catalog by name or acronym, case-insensitive,
 * partial match. Used for /create ad_part:request autocomplete.
 */
async function searchItemCatalog(query) {
  const list = await getItemCatalog();
  const q = query.toLowerCase();
  return list
    .filter(item =>
      item.name.toLowerCase().includes(q) ||
      (item.acronym && item.acronym.toLowerCase().includes(q))
    )
    .slice(0, 25); // Discord autocomplete shows max 25 results anyway
}

// ---------- User inventory ----------
// Cache per-user briefly to avoid hammering the API while someone is
// typing across slot1-4 in the same /create call.
const inventoryCache = new Map(); // robloxUsername -> { items, fetchedAt }
const INVENTORY_TTL_MS = 60 * 1000;

async function getPlayerIdByUsername(username) {
  const res = await fetch(
    `https://api.rolimons.com/players/v1/playersearch?searchstring=${encodeURIComponent(username)}`,
    { headers: HEADERS }
  );
  if (!res.ok) throw new Error(`playersearch failed: ${res.status}`);
  const data = await res.json();
  const match = (data.players || []).find(
    ([, name]) => name.toLowerCase() === username.toLowerCase()
  );
  return match ? match[0] : (data.players?.[0]?.[0] ?? null);
}

/**
 * Returns the user's own inventory as a list of {id, name, acronym}.
 * Used for /create ad_part:offer autocomplete. Returns [] if the
 * inventory is private rather than throwing.
 */
async function getPlayerInventory(robloxUsername) {
  const cached = inventoryCache.get(robloxUsername);
  if (cached && (Date.now() - cached.fetchedAt) < INVENTORY_TTL_MS) {
    return cached.items;
  }

  const playerId = await getPlayerIdByUsername(robloxUsername);
  if (!playerId) return [];

  const res = await fetch(`https://api.rolimons.com/players/v1/playerassets/${playerId}`, {
    headers: HEADERS,
  });
  if (!res.ok) return []; // treat failures as "private/unavailable" rather than crashing

  const data = await res.json();
  if (!data.success || data.playerPrivacyEnabled) return [];

  const catalog = await getItemCatalog();
  const catalogById = new Map(catalog.map(i => [String(i.id), i]));

  // Confirmed via live test (real DevTools capture of a real createad
  // request): the offer payload needs the unique INSTANCE id (a long
  // number, sometimes called UAID) — e.g. 110673146052704 — not the
  // short catalog item id (e.g. 1365767). playerAssets maps catalog
  // item id -> list of instance ids owned (one entry per physical copy,
  // which is why duplicates can repeat the same instance id if you own
  // more than one — confirmed from the real captured payload).
  const playerAssets = data.playerAssets || {};
  const items = Object.entries(playerAssets)
    .flatMap(([itemId, instanceIds]) => {
      const fromCatalog = catalogById.get(String(itemId));
      const manual = MANUAL_ITEM_NAMES[String(itemId)];
      const ids = Array.isArray(instanceIds) ? instanceIds : [instanceIds];

      // Some owned items have no entry in Rolimons' public catalog (often
      // UGC items). Check our manual fallback table first; only show the
      // generic "Unknown Item" label if we truly have no name for it.
      const name = fromCatalog ? fromCatalog.name : (manual ? manual.name : `Unknown Item ${itemId}`);
      const acronym = fromCatalog ? fromCatalog.acronym : (manual ? manual.acronym : '—');

      if (ids.length === 1) {
        return [{ id: itemId, instanceId: ids[0], name, acronym, copiesOwned: 1 }];
      }

      return ids.map((instanceId, idx) => ({
        id: itemId,
        instanceId,
        name: `${name} #${idx + 1}`,
        acronym,
        copiesOwned: ids.length,
      }));
    });

  inventoryCache.set(robloxUsername, { items, fetchedAt: Date.now() });
  return items;
}

// ---------- Cookie helper ----------
// Reads the saved Playwright session file and pulls out the cookie(s)
// Rolimons needs for authenticated API calls, so we don't need to spin
// up a browser just to make an HTTP request.
function getSessionCookieHeader(discordId) {
  const file = path.join(SESSIONS_DIR, `${discordId}.json`);
  if (!fs.existsSync(file)) return null;

  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cookies = state.cookies || [];
  const relevant = cookies.filter(c => c.domain.includes('rolimons.com'));
  if (relevant.length === 0) return null;

  return relevant.map(c => `${c.name}=${c.value}`).join('; ');
}

// ---------- Trade ad posting ----------
/**
 * Attempts to post a trade ad via Rolimons' HTTP API using the user's
 * saved session cookie. Returns { ok: true } or { ok: false, reason }.
 *
 * NOTE: the exact required JSON shape for this endpoint is not confirmed
 * against the live API yet — this is our best construction from public
 * documentation and will likely need one round of live adjustment,
 * similar to what we did for the login flow.
 */
async function postTradeAd(discordId, adConfig, playerId) {
  const cookieHeader = getSessionCookieHeader(discordId);
  if (!cookieHeader) {
    return { ok: false, reason: 'not_logged_in' };
  }

  const payload = {
    player_id: Number(playerId),
    offer_item_ids: (adConfig.offerItemIds || []).map(Number),
    request_item_ids: (adConfig.requestItemIds || []).map(Number),
    request_tags: adConfig.requestTags || [],
  };

  // Confirmed via live capture: a real successful request did not include
  // an offer_robux field at all when robux wasn't being offered. We only
  // include it when actually offering robux, to match real behavior.
  if (adConfig.robux && adConfig.robux > 0) {
    payload.offer_robux = adConfig.robux;
  }

  console.error('postTradeAd SENDING payload:', JSON.stringify(payload));

  const res = await fetch('https://api.rolimons.com/tradeads/v1/createad', {
    method: 'POST',
    headers: {
      ...HEADERS,
      'Content-Type': 'application/json',
      Cookie: cookieHeader,
    },
    body: JSON.stringify(payload),
  });

  if (res.status === 429) return { ok: false, reason: 'cooldown' };
  if (res.status === 403 || res.status === 401) return { ok: false, reason: 'logged_out' };

  const data = await res.json().catch(() => ({}));

  if (!res.ok || data.success === false) {
    // Try to map known Rolimons error messages to our error categories.
    const msg = (data.error || data.message || '').toLowerCase();
    console.error('postTradeAd error — status:', res.status, 'body:', JSON.stringify(data));
    if (msg.includes('limit')) return { ok: false, reason: 'daily_limit' };
    if (msg.includes('cooldown')) return { ok: false, reason: 'cooldown' };
    if (msg.includes('item')) return { ok: false, reason: 'missing_items' };
    return { ok: false, reason: 'unknown', raw: data };
  }

  return { ok: true };
}

module.exports = {
  getItemCatalog,
  searchItemCatalog,
  getPlayerInventory,
  getPlayerIdByUsername,
  postTradeAd,
  getSessionCookieHeader,
};
