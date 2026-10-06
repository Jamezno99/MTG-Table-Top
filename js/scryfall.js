// scryfall.js — card data for every Magic card via the free Scryfall API.
// Scryfall asks for <=10 requests/second; we throttle to ~8/s and cache results.

const API = 'https://api.scryfall.com';
const CACHE_KEY = 'mtgsim-cards-v1';
const TTL = 3 * 24 * 3600 * 1000; // re-check legality (banlist) every 3 days

const sleep = ms => new Promise(r => setTimeout(r, ms));
let nextAt = 0;

async function sf(path, init = {}) {
  const now = Date.now();
  const wait = Math.max(0, nextAt - now);
  nextAt = Math.max(now, nextAt) + 120;
  if (wait) await sleep(wait);
  const headers = { Accept: 'application/json' };
  if (init.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(API + path, { ...init, headers });
  if (res.status === 429) { await sleep(1000); return sf(path, init); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 404) throw new Error(json.details || `Scryfall error ${res.status}`);
  return { ok: res.ok, status: res.status, json };
}

const img = o => (o && o.image_uris ? { small: o.image_uris.small, normal: o.image_uris.normal } : null);

/** Keep only what the simulator needs (keeps saves and caches small). */
export function slim(c) {
  const faces = (c.card_faces || []).map(f => ({
    name: f.name, mana_cost: f.mana_cost || '', type_line: f.type_line || '', oracle_text: f.oracle_text || '',
    power: f.power, toughness: f.toughness, loyalty: f.loyalty, defense: f.defense, image: img(f),
  }));
  return {
    id: c.id, name: c.name, layout: c.layout,
    mana_cost: c.mana_cost ?? (faces[0] ? faces[0].mana_cost : ''),
    cmc: c.cmc, type_line: c.type_line || (faces[0] ? faces[0].type_line : ''),
    oracle_text: c.oracle_text ?? faces.map(f => f.oracle_text).join('\n—\n'),
    power: c.power, toughness: c.toughness, loyalty: c.loyalty, defense: c.defense,
    colors: c.colors || [], color_identity: c.color_identity || [], keywords: c.keywords || [],
    legalities: c.legalities || {}, image: img(c) || (faces[0] && faces[0].image),
    faces, scryfall_uri: c.scryfall_uri, _t: Date.now(),
  };
}

const norm = n => String(n).toLowerCase().replace(/[’`]/g, "'").replace(/\s*\/\/?\s*/g, ' // ').normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const mem = new Map();
const alias = new Map();
let loaded = false;

function index(c) {
  mem.set(norm(c.name), c);
  for (const f of c.faces || []) if (!mem.has(norm(f.name))) mem.set(norm(f.name), c);
}

function loadCache() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return;
    for (const c of JSON.parse(raw)) if (Date.now() - (c._t || 0) < TTL) index(c);
  } catch { /* storage unavailable */ }
}

function saveCache() {
  try {
    const uniq = [...new Map([...mem.values()].map(c => [c.id, c])).values()];
    localStorage.setItem(CACHE_KEY, JSON.stringify(uniq));
  } catch { /* quota or private mode — fine, we just refetch */ }
}

const find = name => mem.get(norm(name)) || mem.get(norm(String(name).split('//')[0])) || alias.get(norm(name));

/**
 * Fetches all named cards (batched 75 per request, fuzzy fallback for typos).
 * Resolves to a lookup(name) function.
 */
export async function fetchCards(names, onProgress = () => {}) {
  loadCache();
  const want = [...new Set(names.map(n => n.trim()).filter(Boolean))];
  const todo = want.filter(n => !find(n));
  for (let i = 0; i < todo.length; i += 75) {
    const chunk = todo.slice(i, i + 75);
    onProgress(`Fetching cards ${i + 1}–${i + chunk.length} of ${todo.length} from Scryfall…`);
    const { json } = await sf('/cards/collection', {
      method: 'POST',
      body: JSON.stringify({ identifiers: chunk.map(n => ({ name: n.split('//')[0].trim() })) }),
    });
    for (const c of json.data || []) index(slim(c));
  }
  for (const n of todo) {
    if (find(n)) continue;
    onProgress(`Looking up "${n}"…`);
    const r = await sf('/cards/named?fuzzy=' + encodeURIComponent(n));
    if (r.ok) { const s = slim(r.json); index(s); alias.set(norm(n), s); }
  }
  saveCache();
  return find;
}

/** Search tokens (or any card with tokensOnly=false). */
export async function searchCards(query, tokensOnly = true) {
  const q = tokensOnly ? `t:token ${query}` : query;
  const r = await sf(`/cards/search?unique=cards&order=name&include_extras=true&q=${encodeURIComponent(q)}`);
  if (!r.ok) return [];
  return (r.json.data || []).slice(0, 60).map(slim);
}

export async function autocomplete(q) {
  if (q.length < 2) return [];
  const r = await sf('/cards/autocomplete?q=' + encodeURIComponent(q));
  return r.ok ? r.json.data || [] : [];
}
