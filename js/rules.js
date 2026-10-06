// rules.js — pure rules helpers: deck parsing/validation, formats, mana costs.
// No DOM, no network: safe to unit-test in Node.

export class RuleError extends Error {
  constructor(msg) { super(msg); this.name = 'RuleError'; }
}

export const COLORS = ['W', 'U', 'B', 'R', 'G'];
export const COLOR_NAMES = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green', C: 'Colorless' };

// `legality` is the key in Scryfall's card.legalities object, which Scryfall
// keeps in sync with official banned & restricted announcements.
export const FORMATS = {
  commander: { name: 'Commander (EDH)', legality: 'commander', deckSize: 100, maxCopies: 1, sideboard: 0, commander: true, life: 40 },
  standard:  { name: 'Standard', legality: 'standard', deckSize: 60, maxCopies: 4, sideboard: 15, life: 20 },
  pioneer:   { name: 'Pioneer',  legality: 'pioneer',  deckSize: 60, maxCopies: 4, sideboard: 15, life: 20 },
  modern:    { name: 'Modern',   legality: 'modern',   deckSize: 60, maxCopies: 4, sideboard: 15, life: 20 },
  legacy:    { name: 'Legacy',   legality: 'legacy',   deckSize: 60, maxCopies: 4, sideboard: 15, life: 20 },
  vintage:   { name: 'Vintage',  legality: 'vintage',  deckSize: 60, maxCopies: 4, sideboard: 15, life: 20 },
  pauper:    { name: 'Pauper',   legality: 'pauper',   deckSize: 60, maxCopies: 4, sideboard: 15, life: 20 },
  freeform:  { name: 'Freeform (no deck checks)', legality: null, deckSize: 0, maxCopies: Infinity, sideboard: Infinity, life: 20 },
};

const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15 };

// ---------------------------------------------------------------- decklists

/** Parses Arena / MTGO / Moxfield / Archidekt-style text lists. */
export function parseDecklist(text) {
  const out = { main: [], side: [], commanders: [] };
  let section = 'main';
  for (const raw of String(text || '').split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    if (/^(\/\/|#)/.test(line)) {
      const h = line.replace(/^(\/\/|#)\s*/, '').toLowerCase();
      if (/^commanders?\b/.test(h)) section = 'commanders';
      else if (/^(sideboard|side|maybeboard|considering)\b/.test(h)) section = 'side';
      else if (/^(deck|main|mainboard|main deck|library)\b/.test(h)) section = 'main';
      continue;
    }
    const low = line.toLowerCase().replace(/:$/, '').replace(/\s*\(\d+\)$/, '');
    if (['commander', 'commanders'].includes(low)) { section = 'commanders'; continue; }
    if (['deck', 'main', 'mainboard', 'main deck', 'library'].includes(low)) { section = 'main'; continue; }
    if (['sideboard', 'side', 'maybeboard', 'considering', 'companion'].includes(low)) { section = 'side'; continue; }

    let target = section;
    if (/^SB:\s*/i.test(line)) { target = 'side'; line = line.replace(/^SB:\s*/i, ''); }
    if (/\*CMDR\*|\[commander\]|\(commander\)/i.test(line)) {
      target = 'commanders';
      line = line.replace(/\*CMDR\*|\[commander\]|\(commander\)/ig, '').trim();
    }
    let qty = 1, name = line;
    const m = line.match(/^(\d+)\s*x?\s+(.+)$/i);
    if (m) { qty = parseInt(m[1], 10); name = m[2]; }
    name = name
      .replace(/\s+\*[A-Z]\*\s*$/i, '')                        // *F* foil markers
      .replace(/\s+\([A-Za-z0-9]{2,6}\)(\s+[\w★-]+)?\s*$/, '') // (SET) 123
      .replace(/\s+\[[A-Za-z0-9]{2,6}\]\s*$/, '')               // [SET]
      .replace(/\s*\/\/?\s*/g, ' // ')                          // Fire/Ice -> Fire // Ice
      .trim();
    if (!name || qty <= 0) continue;
    const list = out[target];
    const existing = list.find(e => e.name.toLowerCase() === name.toLowerCase());
    if (existing) existing.qty += qty; else list.push({ qty, name });
  }
  return out;
}

export function frontType(card) {
  return (card.faces && card.faces[0] && card.faces[0].type_line) || card.type_line || '';
}

export function canBeCommander(card) {
  const tl = frontType(card);
  return (/\bLegendary\b/.test(tl) && /\bCreature\b/.test(tl)) || /can be your commander/i.test(card.oracle_text || '');
}

function partnerInfo(card) {
  const info = { generic: false, with: null, groups: [], chooseBg: false, companion: false,
    isBg: /\bBackground\b/.test(card.type_line || ''), doctor: /Time Lord Doctor/.test(card.type_line || '') };
  for (const l of (card.oracle_text || '').split('\n')) {
    let m;
    if (/^Partner(\s*\(|\s*$)/.test(l)) info.generic = true;
    else if ((m = l.match(/^Partner with ([^(]+?)\s*(\(|$)/))) info.with = m[1].trim();
    else if ((m = l.match(/^Partner—([^(]+?)\s*(\(|$)/))) info.groups.push(m[1].trim().toLowerCase());
    if (/^Friends forever/.test(l)) info.groups.push('friends forever');
    if (/^Choose a Background/.test(l)) info.chooseBg = true;
    if (/^Doctor's companion/.test(l)) info.companion = true;
  }
  return info;
}

/** Can these two cards be co-commanders? (Partner, Partner with, Partner—X, Friends forever, Backgrounds, Doctor's companion) */
export function canPair(a, b) {
  const A = partnerInfo(a), B = partnerInfo(b);
  if (A.generic && B.generic) return true;
  if (A.with === b.name || B.with === a.name) return true;
  if (A.groups.some(g => B.groups.includes(g))) return true;
  if ((A.chooseBg && B.isBg) || (B.chooseBg && A.isBg)) return true;
  if ((A.companion && B.doctor) || (B.companion && A.doctor)) return true;
  return false;
}

export function copyLimit(card, fmt) {
  if (/\bBasic\b/.test(card.type_line || '')) return Infinity;
  const text = card.oracle_text || '';
  if (/A deck can have any number of cards named/i.test(text)) return Infinity;
  const m = text.match(/A deck can have up to (\w+) cards named/i);
  if (m) return NUMBER_WORDS[m[1].toLowerCase()] || parseInt(m[1], 10) || fmt.maxCopies;
  return fmt.maxCopies;
}

const sumQty = list => list.reduce((n, e) => n + e.qty, 0);

/**
 * Validates a parsed deck. `lookup(name)` returns slim Scryfall card data or undefined.
 * Returns { errors: string[], warnings: string[], missing: string[], identity: string[] }.
 */
export function validateDeck(deck, lookup, fmtKey) {
  const fmt = FORMATS[fmtKey] || FORMATS.freeform;
  const errors = [], warnings = [];
  const entries = [
    ...deck.commanders.map(e => ({ ...e, zone: 'commander' })),
    ...deck.main.map(e => ({ ...e, zone: 'main' })),
    ...deck.side.map(e => ({ ...e, zone: 'side' })),
  ];
  for (const e of entries) e.card = lookup(e.name);
  const missing = [...new Set(entries.filter(e => !e.card).map(e => e.name))];
  if (missing.length) errors.push(`Card${missing.length > 1 ? 's' : ''} not found: ${missing.join(', ')}`);
  let identity = [];
  if (!fmt.legality) return { errors, warnings, missing, identity };

  const mainCount = sumQty(deck.main) + (fmt.commander ? sumQty(deck.commanders) : 0);
  const counted = entries.filter(e => e.card && (fmt.commander ? e.zone !== 'side' : true));

  if (fmt.commander) {
    const cmdrs = entries.filter(e => e.zone === 'commander' && e.card).map(e => e.card);
    if (!deck.commanders.length) errors.push('No commander marked. Put it under a "Commander" heading or add *CMDR* after its name.');
    if (deck.commanders.length > 2) errors.push('A deck can have at most two commanders.');
    for (const e of deck.commanders) if (e.qty > 1) errors.push(`${e.name}: a commander is a single card.`);
    for (const c of cmdrs) {
      const asBackground = cmdrs.length === 2 && /\bBackground\b/.test(c.type_line || '');
      if (!canBeCommander(c) && !asBackground) errors.push(`${c.name} can't be your commander (it must be a legendary creature or say it can be your commander).`);
    }
    if (cmdrs.length === 2 && !canPair(cmdrs[0], cmdrs[1])) errors.push(`${cmdrs[0].name} and ${cmdrs[1].name} can't be commanders together (they need Partner, Friends forever, Choose a Background, Doctor's companion, etc.).`);
    if (mainCount !== fmt.deckSize) errors.push(`Deck has ${mainCount} cards including commander${cmdrs.length > 1 ? 's' : ''}; Commander decks must be exactly ${fmt.deckSize}.`);
    if (deck.side.length) warnings.push('Sideboard/maybeboard cards are ignored in Commander.');
    identity = COLORS.filter(c => cmdrs.some(cd => (cd.color_identity || []).includes(c)));
    for (const e of entries.filter(x => x.zone === 'main' && x.card)) {
      const off = (e.card.color_identity || []).filter(c => !identity.includes(c));
      if (off.length) errors.push(`${e.card.name} is outside your commander's color identity (${identity.length ? identity.join('') : 'colorless'}).`);
    }
  } else {
    if (mainCount < fmt.deckSize) errors.push(`Main deck has ${mainCount} cards; minimum is ${fmt.deckSize}.`);
    const side = sumQty(deck.side);
    if (side > fmt.sideboard) errors.push(`Sideboard has ${side} cards; maximum is ${fmt.sideboard}.`);
  }

  const byName = new Map();
  for (const e of counted) {
    const cur = byName.get(e.card.name) || { qty: 0, card: e.card };
    cur.qty += e.qty;
    byName.set(e.card.name, cur);
  }
  for (const [name, { qty, card }] of byName) {
    const limit = copyLimit(card, fmt);
    if (qty > limit) errors.push(`${qty}× ${name}: maximum is ${limit === 1 ? '1 (singleton)' : limit}.`);
    const status = card.legalities && card.legalities[fmt.legality];
    if (status === 'banned') errors.push(`${name} is BANNED in ${fmt.name}.`);
    else if (status === 'not_legal') errors.push(`${name} is not legal in ${fmt.name}.`);
    else if (status === 'restricted' && qty > 1) errors.push(`${name} is restricted in ${fmt.name} (max 1).`);
  }
  return { errors, warnings, missing, identity };
}

// ---------------------------------------------------------------- mana

export function parseCost(str) {
  const c = { generic: 0, X: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, hybrid: [], phyrexian: [] };
  for (const m of String(str || '').matchAll(/\{([^}]+)\}/g)) {
    const s = m[1].toUpperCase();
    if (/^\d+$/.test(s)) c.generic += parseInt(s, 10);
    else if (s === 'X' || s === 'Y' || s === 'Z') c.X++;
    else if (/^[WUBRGC]$/.test(s)) c[s]++;
    else if (s === 'S') c.generic++; // snow mana approximated as generic
    else if (s.includes('/')) {
      const parts = s.split('/');
      if (parts.includes('P')) c.phyrexian.push(parts.find(p => p !== 'P'));
      else c.hybrid.push(parts);
    }
  }
  return c;
}

export const poolTotal = p => ['W', 'U', 'B', 'R', 'G', 'C'].reduce((n, k) => n + (p[k] || 0), 0);

function spendGeneric(p, n) {
  if (poolTotal(p) < n) return false;
  while (n > 0) {
    if (p.C > 0) { p.C--; n--; continue; }
    let best = null;
    for (const k of COLORS) if (p[k] > 0 && (!best || p[k] > p[best])) best = k;
    p[best]--; n--;
  }
  return true;
}

/** Tries to pay `cost` from `pool`. Returns { pool: remaining, lifeLoss } or null. */
export function payCost(pool, cost, x = 0, allowLife = true) {
  const p = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, ...pool };
  let lifeLoss = 0;
  for (const k of ['W', 'U', 'B', 'R', 'G', 'C']) {
    if (p[k] < cost[k]) return null;
    p[k] -= cost[k];
  }
  for (const col of cost.phyrexian) {
    if (p[col] > 0) p[col]--;
    else if (allowLife) lifeLoss += 2;
    else return null;
  }
  for (const opts of cost.hybrid) {
    const col = opts.find(o => /^[WUBRGC]$/.test(o) && p[o] > 0);
    if (col) { p[col]--; continue; }
    const num = opts.find(o => /^\d+$/.test(o));
    if (num && spendGeneric(p, parseInt(num, 10))) continue;
    return null;
  }
  if (!spendGeneric(p, cost.generic + cost.X * x)) return null;
  return { pool: p, lifeLoss };
}

/** Colors still missing from `pool` to pay `cost` (used by auto-tap). */
export function colorNeeds(pool, cost) {
  const p = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, ...pool };
  const need = [];
  for (const k of ['W', 'U', 'B', 'R', 'G', 'C']) {
    if (p[k] < cost[k]) need.push(k);
    p[k] = Math.max(0, p[k] - cost[k]);
  }
  for (const col of cost.phyrexian) { if (p[col] > 0) p[col]--; else need.push(col); }
  for (const opts of cost.hybrid) {
    const col = opts.find(o => /^[WUBRGC]$/.test(o) && p[o] > 0);
    if (col) { p[col]--; continue; }
    if (opts.some(o => /^\d+$/.test(o))) continue; // can be paid generically
    need.push(opts.find(o => /^[WUBRGC]$/.test(o)));
  }
  return [...new Set(need.filter(Boolean))];
}

/**
 * Simple mana abilities of a permanent ("{T}: Add {G}.", basic land types, etc.).
 * Returns a list of options, each like {G:1} or {C:2} or {any:1}.
 */
export function manaOptions(face) {
  const opts = [];
  const tl = face.type_line || '';
  const sub = tl.split('—')[1] || '';
  const basics = { Plains: 'W', Island: 'U', Swamp: 'B', Mountain: 'R', Forest: 'G' };
  if (/\bLand\b/.test(tl)) for (const [t, c] of Object.entries(basics)) if (new RegExp('\\b' + t + '\\b').test(sub)) opts.push({ [c]: 1 });
  for (const line of String(face.oracle_text || '').split('\n')) {
    if (!/^\{T\}: Add /.test(line)) continue;
    const rest = line.slice('{T}: Add '.length).split(/\.\s|\.$|\s*Activate|\s*Spend/)[0];
    if (/mana of any (one )?(color|type)/i.test(rest)) { opts.push({ any: 1 }); continue; }
    const parts = / or /.test(rest) ? rest.split(/,? or |, /) : [rest];
    for (const part of parts) {
      const syms = [...part.matchAll(/\{([WUBRGC])\}/g)].map(x => x[1]);
      if (!syms.length) continue;
      const o = {};
      for (const s of syms) o[s] = (o[s] || 0) + 1;
      opts.push(o);
    }
  }
  const seen = new Set();
  return opts.filter(o => { const k = JSON.stringify(o); if (seen.has(k)) return false; seen.add(k); return true; });
}

/** Does this oracle text grant the card a keyword itself (not to other things)? */
export function hasKeyword(oracle, kw) {
  const lk = kw.toLowerCase();
  return String(oracle || '').split('\n').some(line =>
    line.split(/[,;]\s*/).some(part => {
      const p = part.trim().toLowerCase();
      return p === lk || p.startsWith(lk + ' ') || p.startsWith(lk + '—') || p.startsWith(lk + '(');
    }));
}

// ---------------------------------------------------------------- sample decks

const ELF_CORE = ['Sol Ring', 'Arcane Signet', 'Llanowar Elves', 'Elvish Mystic', 'Fyndhorn Elves', 'Elvish Archdruid',
  'Priest of Titania', 'Elvish Visionary', 'Wood Elves', 'Cultivate', "Kodama's Reach", 'Rampant Growth', 'Harmonize',
  'Beast Within', 'Heroic Intervention', 'Craterhoof Behemoth', 'Ezuri, Renegade Leader', 'Elvish Champion',
  'Imperious Perfect', 'Timberwatch Elf', 'Wellwisher', 'Lys Alana Huntmaster', "Dwynen's Elite", 'Eternal Witness',
  'Reclamation Sage', 'Return of the Wildspeaker', 'Overrun', 'Swiftfoot Boots', 'Lightning Greaves',
  'Joraga Treespeaker', 'Essence Warden', 'Elvish Warmaster'];
const GOBLIN_CORE = ['Sol Ring', 'Arcane Signet', 'Mind Stone', 'Goblin Instigator', 'Goblin Matron', 'Goblin Recruiter',
  'Skirk Prospector', 'Goblin Chieftain', 'Goblin King', 'Goblin Warchief', 'Goblin Lackey', 'Goblin Ringleader',
  'Siege-Gang Commander', 'Beetleback Chief', 'Mogg War Marshal', 'Legion Warboss', 'Purphoros, God of the Forge',
  'Impact Tremors', 'Shared Animosity', 'Coat of Arms', 'Lightning Bolt', 'Chaos Warp', 'Blasphemous Act',
  'Vandalblast', 'Skullclamp', 'Swiftfoot Boots', 'Lightning Greaves', 'Goblin Bombardment', 'Hellrider',
  'Goblin Rabblemaster', 'Krenko, Tin Street Kingpin'];

function build(commander, core, basic) {
  return `Commander\n1 ${commander}\n\nDeck\n${core.map(n => '1 ' + n).join('\n')}\n${99 - core.length} ${basic}\n`;
}

export const SAMPLE_DECKS = {
  'Elves (Marwyn)': build('Marwyn, the Nurturer', ELF_CORE, 'Forest'),
  'Goblins (Krenko)': build('Krenko, Mob Boss', GOBLIN_CORE, 'Mountain'),
};
