// effects.js — reads Oracle text and turns common templates into structured,
// executable descriptions: mana abilities (with costs), triggered abilities,
// static effects (lords, keyword grants, equipment/auras), costs, and the
// effects of spells and abilities. Pure functions with no game state;
// game.js carries out what this file describes. Anything that doesn't match a
// known template is returned as "manual" so the players handle it themselves.

// ------------------------------------------------------------------ text helpers

const WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, twenty: 20, another: 1, single: 1 };
export function num(w) {
  if (w == null) return null;
  const s = String(w).toLowerCase().trim();
  if (s === 'x') return 'X';
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  return WORDS[s] ?? null;
}
const NW = '(a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fifteen|twenty|x|\\d+)';

const IRREG = { elves: 'Elf', dwarves: 'Dwarf', wolves: 'Wolf', werewolves: 'Werewolf', thieves: 'Thief', mice: 'Mouse',
  zombies: 'Zombie', faeries: 'Faerie', allies: 'Ally', mercenaries: 'Mercenary', harpies: 'Harpy', sorceries: 'Sorcery',
  fungi: 'Fungus', octopi: 'Octopus', cyclopes: 'Cyclops', homunculi: 'Homunculus', leeches: 'Leech', foxes: 'Fox',
  wolverines: 'Wolverine', berserkers: 'Berserker', mummies: 'Mummy', ponies: 'Pony', bodies: 'Body', sphinxes: 'Sphinx',
  lynxes: 'Lynx', boxes: 'Box', liches: 'Lich', witches: 'Witch', armies: 'Army', puppies: 'Puppy', allys: 'Ally',
  // plural card types/words that already end in "s"
  vs: 'vs', merfolk: 'Merfolk', kithkin: 'Kithkin', sheep: 'Sheep', moonfolk: 'Moonfolk' };
export function singular(w) {
  const lw = String(w).toLowerCase();
  if (IRREG[lw]) return IRREG[lw] === 'vs' ? w : IRREG[lw];
  if (/(ss|us|is)$/i.test(w)) return w;
  if (/s$/i.test(w)) return w.slice(0, -1);
  return w;
}
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Strip reminder text and replace the card's own name / "this creature" with "~". */
export function norm(text, name) {
  let t = String(text || '').replace(/\([^)]*\)/g, '').replace(/[ \t]+/g, ' ').replace(/ +\n/g, '\n').replace(/’/g, "'");
  if (name) {
    for (const full of String(name).split(' // ')) {
      if (full.length > 1) t = t.replace(new RegExp(escRe(full) + '(?![\\w])', 'g'), '~');
      const short = full.includes(',') ? full.split(',')[0].trim() : null;
      if (short && short.length > 2) t = t.replace(new RegExp('\\b' + escRe(short) + '\\b', 'g'), '~');
    }
  }
  t = t.replace(/\b[Tt]his (creature|artifact|enchantment|land|permanent|spell|Equipment|Aura|Vehicle|planeswalker|card|token|Saga|battle|Class|Room|Siege|Spacecraft)\b/g, '~');
  t = t.replace(/\benters the battlefield\b/g, 'enters').replace(/\benter the battlefield\b/g, 'enter');
  return t;
}
const stripAbilityWord = l => l.replace(/^[A-Z][\w'-]*(?: [\w'-]+){0,4} — (?=[A-Z~])/, '');
const dot = s => s.replace(/\s*\.\s*$/, '').trim();
export function sentences(s) {
  return String(s).split(/(?<=\.)\s+(?=[A-Z~•])/).map(dot).filter(Boolean);
}

// ------------------------------------------------------------------ keywords

export const KEYWORD_LIST = ['flying', 'first strike', 'double strike', 'deathtouch', 'lifelink', 'trample', 'vigilance', 'haste',
  'reach', 'menace', 'defender', 'indestructible', 'hexproof', 'shroud', 'flash', 'infect', 'wither', 'prowess', 'changeling',
  'fear', 'intimidate', 'skulk', 'shadow', 'forestwalk', 'islandwalk', 'swampwalk', 'mountainwalk', 'plainswalk', 'landwalk',
  "can't block", 'ward', 'protection', 'toxic', 'horsemanship', 'flanking', 'banding', 'exalted', 'persist', 'undying', 'devoid'];
/** "hexproof and indestructible" / "flying, vigilance, and lifelink" -> ['Hexproof', 'Indestructible'] (null if unknown words). */
export function parseKeywords(phrase) {
  const parts = String(phrase).replace(/,? and /g, ', ').split(/,\s*/).map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!parts.length) return null;
  const out = [];
  for (const p of parts) {
    if (KEYWORD_LIST.includes(p) || /^protection from /.test(p) || /^ward \{/.test(p)) out.push(cap(p));
    else return null;
  }
  return out;
}
const AUTOMATED_KEYWORDS = new Set(['flying', 'first strike', 'double strike', 'deathtouch', 'lifelink', 'trample', 'vigilance',
  'haste', 'reach', 'menace', 'defender', 'indestructible', 'hexproof', 'shroud', 'flash', 'infect', 'wither', 'changeling',
  'forestwalk', 'islandwalk', 'swampwalk', 'mountainwalk', 'plainswalk']);

// ------------------------------------------------------------------ filters

const TYPES = ['artifact', 'creature', 'enchantment', 'land', 'planeswalker', 'instant', 'sorcery', 'battle', 'kindred', 'tribal'];
const SUPERS = ['basic', 'legendary', 'snow', 'world'];
const COLORS_W = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };

/**
 * Parses phrases like "creature", "nonland permanent", "artifact or enchantment",
 * "Goblin", "Elf creature you control", "basic land", "Forest or Plains",
 * "creature with flying", "creature with power 3 or less", "another creature".
 */
export function parseFilter(phrase) {
  let p = String(phrase).trim().replace(/\s+/g, ' ').replace(/\.$/, '');
  const f = { alts: [], ctrl: null, other: false, token: null, tapped: null, attacking: null, kw: null, power: null, color: null, desc: p };
  let m;
  p = p.replace(/^(?:a|an|one|the|target|each|all)\s+/i, '');
  if ((m = p.match(/^(other|another)\s+(.+)$/i))) { f.other = true; p = m[2]; }
  const suffixes = [
    [/ you control$/i, () => { f.ctrl = 'you'; }],
    [/ (?:you don't control|an opponent controls|your opponents control|opponents control)$/i, () => { f.ctrl = 'opp'; }],
    [/ with power (\d+) or (less|greater)$/i, mm => { f.power = { n: +mm[1], cmp: mm[2] }; }],
    [/ with (flying|reach|trample|deathtouch|haste|defender|lifelink|vigilance|menace|first strike|double strike)$/i, mm => { f.kw = cap(mm[1].toLowerCase()); }],
    [/ cards?$/i, () => {}],
  ];
  for (let again = true; again;) {
    again = false;
    for (const [re, fn] of suffixes) if ((m = p.match(re))) { fn(m); p = p.slice(0, m.index).trim(); again = true; }
  }
  if ((m = p.match(/^(tapped|untapped|attacking|blocking|attacking or blocking) (.+)$/i))) {
    const w = m[1].toLowerCase();
    if (w === 'tapped') f.tapped = true; else if (w === 'untapped') f.tapped = false; else f.attacking = w;
    p = m[2];
  }
  if ((m = p.match(/^(nontoken|token) (.+)$/i))) { f.token = m[1].toLowerCase() === 'token'; p = m[2]; }
  if ((m = p.match(/^(white|blue|black|red|green) (.+)$/i))) { f.color = COLORS_W[m[1].toLowerCase()]; p = m[2]; }
  p = p.replace(/, or /g, ' or ').replace(/, /g, ' or ');
  for (const alt of p.split(/ or | and\/or /)) {
    const a = { types: [], subs: [], supers: [], nots: [] };
    for (let w of alt.trim().split(' ')) {
      const lw = w.toLowerCase();
      if (!w) continue;
      if (lw.startsWith('non') && lw.length > 4) {
        const r = lw.slice(3).replace(/^-/, '');
        if (COLORS_W[r]) { (a.notColors = a.notColors || []).push(COLORS_W[r]); continue; }
        a.nots.push(cap(singular(r))); continue;
      }
      if (COLORS_W[lw]) { (a.colors = a.colors || []).push(COLORS_W[lw]); continue; }
      if (lw === 'colorless') { a.colorless = true; continue; }
      if (lw === 'multicolored') { a.multi = true; continue; }
      const sl = singular(lw);
      if (TYPES.includes(sl)) a.types.push(cap(sl));
      else if (SUPERS.includes(lw)) a.supers.push(cap(lw));
      else if (sl === 'permanent' || sl === 'spell' || sl === 'card' || sl === 'object') { if (sl === 'permanent') a.types.push('Permanent'); }
      else if (/^[A-Z]/.test(w)) a.subs.push(singular(w));
      else return null; // unknown word — not a filter we understand
    }
    f.alts.push(a);
  }
  if (!f.alts.length) return null;
  return f;
}

const NONCREATURE_SUBS = new Set(['Forest', 'Island', 'Swamp', 'Mountain', 'Plains', 'Equipment', 'Aura', 'Vehicle', 'Treasure',
  'Food', 'Clue', 'Blood', 'Gold', 'Map', 'Saga', 'Shrine', 'Cartouche', 'Curse', 'Desert', 'Gate', 'Lair', 'Locus', 'Mine',
  'Power-Plant', 'Tower', 'Urza\'s', 'Cave', 'Sphere', 'Class', 'Room', 'Role', 'Powerstone', 'Fortification']);

/**
 * typeLine: the object's type line. info: { kw(k)->bool, ctrlIsMe, isSelf, tapped, attacking, blocking, token, power, colors, changeling }
 */
export function matchFilter(typeLine, info, f) {
  if (!f) return false;
  if (f.other && info.isSelf) return false;
  if (f.ctrl === 'you' && !info.ctrlIsMe) return false;
  if (f.ctrl === 'opp' && info.ctrlIsMe) return false;
  if (f.token != null && !!info.token !== f.token) return false;
  if (f.tapped != null && !!info.tapped !== f.tapped) return false;
  if (f.attacking === 'attacking' && !info.attacking) return false;
  if (f.attacking === 'blocking' && !info.blocking) return false;
  if (f.attacking === 'attacking or blocking' && !(info.attacking || info.blocking)) return false;
  if (f.kw && !(info.kw && info.kw(f.kw))) return false;
  if (f.power && info.power != null && (f.power.cmp === 'less' ? info.power > f.power.n : info.power < f.power.n)) return false;
  if (f.color && !(info.colors || []).includes(f.color)) return false;
  const words = String(typeLine || '').replace('—', ' ').split(/\s+/).filter(Boolean);
  const has = w => words.includes(w);
  const isPermanent = !has('Instant') && !has('Sorcery');
  return f.alts.some(a =>
    a.types.every(t => (t === 'Permanent' ? isPermanent : t === 'Kindred' ? (has('Kindred') || has('Tribal')) : has(t))) &&
    a.supers.every(has) &&
    a.subs.every(s => has(s) || (info.changeling && !NONCREATURE_SUBS.has(s))) &&
    a.nots.every(n => !has(n)) &&
    (!a.notColors || a.notColors.every(c => !(info.colors || []).includes(c))) &&
    (!a.colors || a.colors.every(c => (info.colors || []).includes(c))) &&
    (!a.colorless || !(info.colors || []).length) &&
    (!a.multi || (info.colors || []).length > 1));
}

// ------------------------------------------------------------------ counts ("for each", "where X is", "equal to")

/** Returns a count spec, or null if not understood. */
export function parseCount(expr) {
  let e = String(expr).trim().replace(/\.$/, '');
  let m;
  if ((m = e.match(/^(?:~'s|its) power$/i))) return { k: 'power', of: /^its/i.test(e) ? 'ref' : 'self' };
  if ((m = e.match(/^the greatest power among (.+)$/i))) {
    const scope = /you control$/i.test(m[1]) ? 'you' : 'all';
    const f = parseFilter(m[1]);
    return f ? { k: 'maxPower', filter: f, scope } : null;
  }
  if ((m = e.match(/^(?:the number of )?cards? in your hand$/i))) return { k: 'hand' };
  e = e.replace(/^the number of /i, '');
  let zone = 'battlefield', scope = 'all';
  if ((m = e.match(/^(.+?) (?:cards )?in your graveyard$/i))) { zone = 'graveyard'; scope = 'you'; e = m[1]; }
  else if ((m = e.match(/^(.+?) on the battlefield$/i))) { e = m[1]; scope = 'all'; }
  else if ((m = e.match(/^(.+?) you control$/i))) { e = m[1]; scope = 'you'; }
  else if ((m = e.match(/^(.+?) (?:your opponents control|an opponent controls)$/i))) { e = m[1]; scope = 'opp'; }
  else return null;
  const f = parseFilter(e);
  return f ? { k: 'count', filter: f, scope, zone } : null;
}

// ------------------------------------------------------------------ mana abilities

function parseCostParts(costStr) {
  const c = { tap: false, untap: false, mana: '', life: 0, sacSelf: false, sac: null, discard: 0, discardFilter: null,
    discardHand: false, removeCounter: null, exileSelf: false, tapOther: null, other: [] };
  const parts = String(costStr).split(/,\s*(?![^{]*\})/).map(s => s.trim()).filter(Boolean);
  let m;
  for (const p of parts) {
    if (p === '{T}') c.tap = true;
    else if (p === '{Q}') c.untap = true;
    else if (/^(\{[^}]+\})+$/.test(p) && !/\{E\}/.test(p)) c.mana += p;
    else if ((m = p.match(/^Pay (\d+|X) life$/i))) c.life = m[1] === 'X' ? 'X' : +m[1];
    else if (/^Sacrifice ~$/i.test(p)) c.sacSelf = true;
    else if ((m = p.match(new RegExp('^Sacrifice ' + NW + ' (.+)$', 'i')))) {
      const f = parseFilter(m[2]);
      if (f) { if (/^another$/i.test(m[1])) f.other = true; c.sac = { n: num(m[1]) || 1, filter: f, desc: m[2] }; } else c.other.push(p);
    } else if ((m = p.match(/^Sacrifice another (.+)$/i))) {
      const f = parseFilter(m[1]); if (f) { f.other = true; c.sac = { n: 1, filter: f, desc: m[1] }; } else c.other.push(p);
    } else if ((m = p.match(new RegExp('^Discard ' + NW + ' cards?$', 'i')))) c.discard = num(m[1]);
    else if ((m = p.match(new RegExp('^Discard ' + NW + ' (.+?) card$', 'i')))) { const f = parseFilter(m[2]); if (f) { c.discard = 1; c.discardFilter = f; } else c.other.push(p); }
    else if (/^Discard your hand$/i.test(p)) c.discardHand = true;
    else if ((m = p.match(new RegExp('^Remove ' + NW + ' (.+?) counters? from ~$', 'i')))) c.removeCounter = { n: num(m[1]), type: m[2] };
    else if (/^Exile ~ from your graveyard$/i.test(p)) c.exileSelf = true;
    else if ((m = p.match(/^Tap an untapped (.+?) you control$/i))) { const f = parseFilter(m[1]); if (f) c.tapOther = { filter: f, desc: m[1] }; else c.other.push(p); }
    else c.other.push(p);
  }
  return c;
}
export { parseCostParts };

/**
 * Parses one (normalized) line as a mana ability. Returns an array of options or null.
 * Option: { add: {W..C}, any: n, anyOne: n, identity, per, cost: {tap, life, damage, sac, mana, untap}, note }
 */
export function parseManaLine(line) {
  const m = String(line).match(/^([^:]+?): Add (.+)$/);
  if (!m) return null;
  const cost = parseCostParts(m[1]);
  if (cost.other.length || cost.sac || cost.discard || cost.discardHand || cost.removeCounter || cost.exileSelf || cost.tapOther) return null;
  if (!cost.tap && !cost.sacSelf && !cost.mana) return null;
  const sents = sentences(m[2]);
  const addPart = sents.shift();
  let damage = 0; const notes = [];
  for (const s of sents) {
    let d;
    if ((d = s.match(/^(?:~|It) deals (\d+) damage to you$/i))) damage += +d[1];
    else if (/^(Spend this mana only|Activate only|This mana can't)/i.test(s)) notes.push(s);
    else return null; // more going on than a plain mana ability
  }
  const base = { tap: cost.tap, untap: cost.untap, life: cost.life || 0, damage, sac: cost.sacSelf, mana: cost.mana };
  const opts = [];
  const mk = (o) => opts.push({ add: {}, any: 0, anyOne: 0, identity: false, per: null, ...o, cost: { ...base }, note: notes.join(' ') || '' });
  let a = addPart, mm;
  let per = null;
  if ((mm = a.match(/^(.+?) for each (.+)$/))) { per = parseCount(mm[2]); if (!per) return null; a = mm[1]; }
  if ((mm = a.match(/^an amount of ((?:\{[WUBRGC]\})+) equal to (.+)$/))) { per = parseCount(mm[2]); if (!per) return null; a = mm[1]; }
  if ((mm = a.match(/^(one|two|three|four|five|x) mana of any colou?r( in your commander's colou?r identity)?$/i))) { mk({ any: num(mm[1]), identity: !!mm[2], per }); return opts; }
  if ((mm = a.match(/^(one|two|three|four|five) mana of any one colou?r$/i))) { mk({ anyOne: num(mm[1]), per }); return opts; }
  if ((mm = a.match(/^(two|three|four) mana in any combination of colou?rs$/i))) { mk({ any: num(mm[1]), per }); return opts; }
  const pieces = a.replace(/,? or /g, ', ').split(/,\s*/);
  for (const piece of pieces) {
    const syms = [...piece.matchAll(/\{([WUBRGC])\}/g)].map(x => x[1]);
    if (!syms.length || piece.replace(/\{[WUBRGC]\}/g, '').trim()) return null;
    const add = {};
    for (const s of syms) add[s] = (add[s] || 0) + 1;
    mk({ add, per });
  }
  return opts.length ? opts : null;
}

/** All mana options of a face, from its text and basic land types. Each option carries .line (oracle line index). */
export function manaAbilities(face, name) {
  const out = [];
  const tl = face.type_line || '';
  const sub = tl.split('—')[1] || '';
  const basics = { Plains: 'W', Island: 'U', Swamp: 'B', Mountain: 'R', Forest: 'G' };
  const lines = norm(face.oracle_text || '', name || face.name).split('\n');
  let tapDamage = 0;
  for (const l of lines) { const d = l.match(/^Whenever ~ becomes tapped, it deals (\d+) damage to you\.?$/); if (d) tapDamage += +d[1]; }
  if (/\bLand\b/.test(tl)) {
    for (const [t, c] of Object.entries(basics)) {
      if (new RegExp('\\b' + t + '\\b').test(sub)) out.push({ add: { [c]: 1 }, any: 0, anyOne: 0, identity: false, per: null, cost: { tap: true, life: 0, damage: 0, sac: false, mana: '' }, note: '', line: -1 });
    }
  }
  lines.forEach((l, i) => {
    const o = parseManaLine(l.trim());
    if (o) for (const x of o) out.push({ ...x, line: i });
  });
  if (tapDamage) for (const o of out) if (o.cost.tap) o.cost.damage += tapDamage;
  // de-duplicate (basic land type + its reminder-text ability)
  const seen = new Set();
  return out.filter(o => { const k = JSON.stringify([o.add, o.any, o.anyOne, o.identity, o.per, o.cost]); if (seen.has(k)) return false; seen.add(k); return true; });
}
export const isManaLine = l => !!parseManaLine(l);

export function manaLabel(o) {
  const sym = Object.entries(o.add).map(([k, v]) => `{${k}}`.repeat(v)).join('');
  let what = o.any ? `${o.any} mana of any color${o.identity ? ' (commander identity)' : ''}` : o.anyOne ? `${o.anyOne} mana of one color` : sym;
  if (o.per) what += o.per.k === 'power' ? ' × its power' : ' × count';
  const costs = [];
  if (o.cost.mana) costs.push(o.cost.mana);
  if (o.cost.tap) costs.push('{T}');
  if (o.cost.life) costs.push(`pay ${o.cost.life} life`);
  if (o.cost.sac) costs.push('sacrifice it');
  const tail = o.cost.damage ? ` (deals ${o.cost.damage} damage to you)` : '';
  return `${costs.join(', ')}: add ${what}${tail}`;
}

// ------------------------------------------------------------------ land / permanent ETB

/** 'tapped' | 'untapped' | 'shock' | {unless: condition} | 'ask' */
export function entersTappedRule(face, name) {
  const t = norm(face.oracle_text || '', name || face.name);
  let m;
  if (/As ~ enters, you may pay (\d+) life\. If you don't, it enters tapped/i.test(t)) return { shock: +t.match(/you may pay (\d+) life/i)[1] };
  if ((m = t.match(/~ enters tapped unless (.+?)\.(?:\s|$)/i))) return { unless: m[1] };
  if (/If you don't, (?:~|it) enters tapped/i.test(t)) return 'ask';
  if (/(^|\n)~ enters tapped\.?($|\n)/i.test(t)) return 'tapped';
  return 'untapped';
}

// ------------------------------------------------------------------ triggers

/** Parses a "When/Whenever/At ..." line. Returns null if it isn't a trigger. */
export function parseTrigger(line) {
  const l = stripAbilityWord(String(line).trim());
  const m = l.match(/^(When|Whenever|At) (.+?), (.+)$/);
  if (!m) return null;
  const cond = m[2];
  let eff = m[3];
  const once = /This ability triggers only once each turn\.?$/i.test(eff);
  eff = eff.replace(/\s*This ability triggers only once each turn\.?$/i, '').trim();
  const ev = parseEvent(cond, m[1]);
  return { ...(ev || { ev: 'unknown' }), cond, effect: eff, once, text: l };
}

function parseEvent(c, word) {
  let m;
  c = c.trim();
  if (word === 'At') {
    if ((m = c.match(/^the beginning of (your|each|each player's|each opponent's|the) (upkeep|end step|draw step|precombat main phase|first main phase|second main phase|postcombat main phase)$/i))) {
      const whose = /your/i.test(m[1]) ? 'you' : /opponent/i.test(m[1]) ? 'opp' : 'each';
      const step = { 'upkeep': 'Upkeep', 'end step': 'End', 'draw step': 'Draw', 'precombat main phase': 'Main 1', 'first main phase': 'Main 1', 'second main phase': 'Main 2', 'postcombat main phase': 'Main 2' }[m[2].toLowerCase()];
      return { ev: 'step', step, whose };
    }
    if ((m = c.match(/^the beginning of combat on (your|each player's) turn$/i)) || (m = c.match(/^the beginning of (each) combat$/i)))
      return { ev: 'step', step: 'Beginning of Combat', whose: /your/i.test(m[1]) ? 'you' : 'each' };
    if (/^the beginning of the next end step$/i.test(c)) return null;
    return null;
  }
  if ((m = c.match(/^~ enters(?: or (dies|attacks))?$/i))) return { ev: 'etb', also: m[1] ? m[1].toLowerCase() : null };
  if (/^~ (?:dies|is put into a graveyard from the battlefield)$/i.test(c)) return { ev: 'dies' };
  if (/^~ attacks(?: or blocks)?$/i.test(c)) return { ev: 'attacks' };
  if ((m = c.match(/^~ deals (combat )?damage to (?:a player|an opponent)(?: or battle)?$/i))) return { ev: 'dmgPlayer', combat: !!m[1] };
  if (/^(?:equipped|enchanted) creature dies$/i.test(c)) return { ev: 'hostDies' };
  if ((m = c.match(/^(a|an|another|one or more|one or more other) (.+?) enters?(?: under your control)?$/i))) {
    const f = parseFilter(m[2]);
    if (!f) return null;
    if (/other|another/i.test(m[1])) f.other = true;
    if (/under your control/i.test(c)) f.ctrl = 'you';
    return { ev: 'enters', filter: f, oneOrMore: /one or more/i.test(m[1]) };
  }
  if ((m = c.match(/^(a|an|another|one or more|one or more other) (.+?) (?:dies|die|is put into a graveyard from the battlefield)$/i))) {
    const f = parseFilter(m[2]);
    if (!f) return null;
    if (/other|another/i.test(m[1])) f.other = true;
    return { ev: 'otherDies', filter: f };
  }
  if ((m = c.match(/^(a|another) (.+?) attacks$/i))) {
    const f = parseFilter(m[2]);
    if (!f) return null;
    if (/another/i.test(m[1])) f.other = true;
    return { ev: 'attacksAny', filter: f };
  }
  if (/^(?:you attack|one or more creatures you control attack)$/i.test(c)) return { ev: 'attackOnce' };
  if ((m = c.match(/^you cast (a|an|your first) (.+?) spell(?: each turn)?$/i)) || (m = c.match(/^you cast (a) (spell)$/i))) {
    const what = m[2];
    const f = /^spell$/i.test(what) ? { any: true } : parseFilter(what);
    if (!f) return null;
    return { ev: 'cast', filter: f, first: /first/i.test(m[1]) };
  }
  return null;
}

// ------------------------------------------------------------------ statics

/** Parses a static-ability line. Returns an object or null. */
export function parseStatic(line) {
  let l = dot(String(line).trim());
  let m;
  if (/until end of turn|^When|^Whenever|^At |:/.test(l)) return null;
  if (/^Each creature gets \+1\/\+1 for each other creature on the battlefield that shares at least one creature type with it$/i.test(l)) return { k: 'coatOfArms' };
  if ((m = l.match(/^As long as your devotion to (white|blue|black|red|green)(?: and (white|blue|black|red|green))? is less than (\w+), ~ isn't a creature$/i)))
    return { k: 'devotionNotCreature', colors: [m[1], m[2]].filter(Boolean).map(c => COLORS_W[c.toLowerCase()]), n: num(m[3]) };
  if ((m = l.match(/^(Equipped|Enchanted) creature (gets ([+-]\d+)\/([+-]\d+)(?: and (?:has|gains) (.+))?|has (.+))$/i))) {
    const kws = m[5] || m[6] ? parseKeywords(m[5] || m[6]) : [];
    if ((m[5] || m[6]) && !kws) return null;
    return { k: 'attached', dp: m[3] ? +m[3] : 0, dt: m[4] ? +m[4] : 0, kws };
  }
  if ((m = l.match(/^~ gets ([+-]\d+)\/([+-]\d+) for each (.+)$/i))) {
    const per = parseCount(m[3]);
    return per ? { k: 'selfPer', dp: +m[1], dt: +m[2], per } : null;
  }
  if (/^~ can't block$/i.test(l)) return { k: 'selfKw', kws: ["Can't block"] };
  if ((m = l.match(/^(\w+ )?(creature |noncreature |artifact |instant and sorcery |enchantment )?spells you cast cost \{(\d+)\} less to cast$/i))) {
    const words = `${m[1] || ''}${m[2] || ''}`.trim();
    const f = words ? parseFilter(words.replace(/ and /, ' or ')) : { any: true };
    return f ? { k: 'costReduce', n: +m[3], filter: f } : null;
  }
  // lords: "<subject> get +N/+N [and have X]" / "<subject> have X"
  if ((m = l.match(/^(.+?) (get|have) (.+)$/i))) {
    let subj = m[1];
    if (/^~|^Each |^All /.test(subj) && !/^All /i.test(subj)) return null;
    subj = subj.replace(/^All /i, '');
    let pred = m[3], dp = 0, dt = 0, kws = [];
    if (/get/i.test(m[2])) {
      const pm = pred.match(/^([+-]\d+)\/([+-]\d+)(?: and have (.+))?$/i);
      if (!pm) return null;
      dp = +pm[1]; dt = +pm[2];
      if (pm[3]) { kws = parseKeywords(pm[3]); if (!kws) return null; }
    } else { kws = parseKeywords(pred); if (!kws) return null; }
    let other = false;
    if (/^Other /i.test(subj)) { other = true; subj = subj.replace(/^Other /i, ''); }
    let ctrl = null;
    if (/ you control$/i.test(subj)) { ctrl = 'you'; subj = subj.replace(/ you control$/i, ''); }
    else if (/ your opponents control$/i.test(subj)) { ctrl = 'opp'; subj = subj.replace(/ your opponents control$/i, ''); }
    // "Goblins" / "Elf creatures" / "creatures" / "nontoken creatures"
    const f = parseFilter(subj.split(' ').map(w => singular(w)).join(' '));
    if (!f) return null;
    if (!f.alts.some(a => a.types.length || a.subs.length)) return null;
    f.other = other; f.ctrl = ctrl;
    if (!f.alts.every(a => a.types.length)) for (const a of f.alts) if (!a.types.length) a.types.push('Creature');
    return { k: 'lord', dp, dt, kws, filter: f };
  }
  return null;
}

// ------------------------------------------------------------------ costs on spells

/** Reads alternative/additional costs, kicker, flashback and self cost reduction from a spell's text. */
export function spellCosts(face, name) {
  const lines = norm(face.oracle_text || '', name || face.name).split('\n').map(s => dot(s.trim()));
  const out = { additional: null, altLife: null, altOther: null, kicker: null, flashback: null, selfReduce: null, enchant: null };
  let m;
  for (const l of lines) {
    if ((m = l.match(/^As an additional cost to cast ~, (.+)$/i))) {
      const a = { life: 0, sac: null, discard: 0, manual: [] };
      for (const part of m[1].split(/,? and |, /)) {
        let mm;
        if ((mm = part.match(/^pay (\d+) life$/i))) a.life += +mm[1];
        else if ((mm = part.match(new RegExp('^sacrifice ' + NW + ' (.+)$', 'i'))) && parseFilter(mm[2])) a.sac = { n: num(mm[1]) || 1, filter: parseFilter(mm[2]), desc: mm[2] };
        else if ((mm = part.match(new RegExp('^discard ' + NW + ' cards?$', 'i')))) a.discard = num(mm[1]);
        else a.manual.push(part);
      }
      out.additional = a;
    } else if ((m = l.match(/^(?:If (.+?), )?you may pay (\d+) life rather than pay ~'s mana cost$/i))) { out.altLife = +m[2]; out.altLifeCond = m[1] || null; }
    else if ((m = l.match(/^(?:If .+?, )?you may (.+?) rather than pay ~'s mana cost$/i))) out.altOther = m[1];
    else if ((m = l.match(/^Kicker ((?:\{[^}]+\})+)$/i))) out.kicker = m[1];
    else if ((m = l.match(/^Flashback ((?:\{[^}]+\})+)$/i))) out.flashback = m[1];
    else if ((m = l.match(/^~ costs \{(\d+)\} less to cast for each (.+)$/i))) { const per = parseCount(m[2]); if (per) out.selfReduce = { n: +m[1], per }; }
    else if ((m = l.match(/^Enchant (.+)$/i))) { const f = parseFilter(m[1]); out.enchant = f ? { filter: f, desc: m[1] } : { filter: null, desc: m[1] }; }
  }
  return out;
}

// ------------------------------------------------------------------ effects

const NON_EFFECT_LINE = /^(?:(?:Flashback|Kicker|Multikicker|Buyback|Cycling|\w+cycling|Overload|Convoke|Delve|Improvise|Affinity for|Storm|Cascade|Escape|Retrace|Jump-start|Rebound|Split second|Flash|Entwine|Spectacle|Surge|Emerge|Madness|Foretell|Plot|Disturb|Evoke|Ninjutsu|Dash|Bestow|Morph|Megamorph|Channel|Replicate|Splice|Cipher|Epic|Fuse|Aftermath|Casualty|Bargain|Gift|Freerunning|Spree|Enchant)\b|As an additional cost to cast ~|(?:If .+?, )?you may .* rather than pay ~'s mana cost|~ costs .* (?:less|more) to cast|~ can't be countered)/i;

/** The lines of an instant/sorcery that actually do something when it resolves. */
export function spellEffectText(face, name) {
  return norm(face.oracle_text || '', name || face.name).split('\n').map(s => s.trim())
    .filter(l => l && !NON_EFFECT_LINE.test(l) && !parseKeywords(l.replace(/\.$/, '')) && !parseStatic(l)).join('\n');
}

const REF_IT = /^(it|that creature|that permanent|that card|that token|those tokens|them|the token|the creature)$/i;

/** Parses who/what an effect touches: a target, a group, or a reference. */
export function parseObjects(phrase) {
  let p = String(phrase).trim();
  let m;
  if (p === '~') return { ref: 'self' };
  if (REF_IT.test(p)) return { ref: /token/i.test(p) ? 'tokens' : 'it' };
  if ((m = p.match(/^(up to (one|two|three|four|five|\d+) |any number of |(one|two|three|\d+) )?(other )?target (.+?)(?: from (?:a|your|an opponent's|target player's) graveyard)?$/i))) {
    const fromGy = /from (?:a|your|an opponent's|target player's) graveyard$/i.test(p);
    let min = 1, max = 1;
    if (m[2]) { min = 0; max = num(m[2]); }
    else if (m[3]) { min = max = num(m[3]); }
    else if (/^any number of/i.test(m[1] || '')) { min = 0; max = 99; }
    const what = m[5];
    if (/^(spell|creature spell|noncreature spell|instant or sorcery spell|activated ability|activated or triggered ability|spell or ability)$/i.test(what)) return { tgt: 'stack', min, max, desc: p };
    const words = what.split(' ').map(singular).join(' ');
    const f = parseFilter(words);
    if (!f) return null;
    if (m[4]) f.other = true;
    if (fromGy) return { tgt: 'gy', filter: f, min, max, desc: p, gy: /your graveyard/i.test(p) ? 'you' : 'any' };
    return { tgt: 'perm', filter: f, min, max, desc: p };
  }
  if ((m = p.match(/^(?:all|each) (other )?(.+)$/i))) {
    const words = m[2].split(' ').map(singular).join(' ');
    const f = parseFilter(words);
    if (!f) return null;
    if (m[1]) f.other = true;
    return { group: 'perm', filter: f, desc: p };
  }
  return null;
}

function parsePlayers(phrase) {
  const p = String(phrase).trim().toLowerCase();
  if (p === 'you' || p === '') return { players: 'you' };
  if (p === 'each opponent') return { players: 'opps' };
  if (p === 'each player') return { players: 'all' };
  if (p === 'target player') return { tgt: 'player', min: 1, max: 1, desc: 'target player' };
  if (p === 'target opponent') return { tgt: 'player', opp: true, min: 1, max: 1, desc: 'target opponent' };
  if (p === 'that player' || p === 'its controller' || p === 'their controller') return { players: 'ref' };
  if (p === 'defending player' || p === 'the player or planeswalker it\'s attacking' || p === 'the player it\'s attacking' || p === 'that opponent') return { players: 'defender' };
  return null;
}

function parseRecipients(phrase) {
  let p = String(phrase).trim();
  let m;
  if (/^any target$/i.test(p)) return [{ tgt: 'any', min: 1, max: 1, desc: 'any target' }];
  if ((m = p.match(/^(up to (one|two|three)|one|two|three) target creatures?(?: and\/or (?:players|planeswalkers))*$/i)) && /up to/i.test(p) && /and\/or/.test(p)) return [{ tgt: 'any', min: 0, max: num(m[2]), desc: p }];
  if (/^target creature or player$/i.test(p)) return [{ tgt: 'any', noPw: true, min: 1, max: 1, desc: p }];
  if (/^target (?:player|opponent) or planeswalker$/i.test(p)) return [{ tgt: 'any', noCreature: true, opp: /opponent/i.test(p), min: 1, max: 1, desc: p }];
  const pl = parsePlayers(p);
  if (pl) return [pl];
  if (/^each (?:creature and each player|player and each creature)$/i.test(p)) return [{ group: 'perm', filter: parseFilter('creature'), desc: 'each creature' }, { players: 'all' }];
  if ((m = p.match(/^each opponent and each creature (your opponents control|they control)$/i))) return [{ players: 'opps' }, { group: 'perm', filter: { ...parseFilter('creature'), ctrl: 'opp' }, desc: 'each creature your opponents control' }];
  if ((m = p.match(/^each (.+?) and each (.+)$/i))) {
    const a = parseRecipients('each ' + m[1]), b = parseRecipients('each ' + m[2]);
    return a && b ? [...a, ...b] : null;
  }
  const o = parseObjects(p);
  return o ? [o] : null;
}

const TOKEN_NAMED = {
  treasure: { name: 'Treasure', type_line: 'Token Artifact — Treasure', oracle_text: '{T}, Sacrifice this artifact: Add one mana of any color.' },
  food: { name: 'Food', type_line: 'Token Artifact — Food', oracle_text: '{2}, {T}, Sacrifice this artifact: You gain 3 life.' },
  clue: { name: 'Clue', type_line: 'Token Artifact — Clue', oracle_text: '{2}, Sacrifice this artifact: Draw a card.' },
  blood: { name: 'Blood', type_line: 'Token Artifact — Blood', oracle_text: '{1}, {T}, Discard a card, Sacrifice this artifact: Draw a card.' },
  gold: { name: 'Gold', type_line: 'Token Artifact — Gold', oracle_text: 'Sacrifice this artifact: Add one mana of any color.' },
  powerstone: { name: 'Powerstone', type_line: 'Token Artifact — Powerstone', oracle_text: '{T}: Add {C}. This mana can\'t be spent to cast a nonartifact spell.' },
  map: { name: 'Map', type_line: 'Token Artifact — Map', oracle_text: '{1}, {T}, Sacrifice this artifact: Target creature you control explores. Activate only as a sorcery.' },
};
const COLOR_WORDS = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G', colorless: null };

/** "two 1/1 red Goblin creature tokens with haste" -> { count, token } */
export function parseTokenPhrase(rest) {
  let s = String(rest).trim(), m;
  let count = 1, countExpr = null;
  if ((m = s.match(/^(?:(a number of)|(a|an|one|two|three|four|five|six|seven|eight|nine|ten|x|\d+)) /i))) {
    count = m[1] ? 'EXPR' : num(m[2]);
    s = s.slice(m[0].length);
  }
  let tapped = false;
  if (/^tapped /i.test(s)) { tapped = true; s = s.slice(7); }
  m = s.match(/^(.+?) tokens?\b(.*)$/i);
  if (!m) return null;
  const body = m[1].trim();
  let tail = m[2].trim();
  let kws = [], note = '';
  let mm;
  if ((mm = tail.match(/ ?equal to (.+)$/i))) { countExpr = parseCount(mm[1]); if (!countExpr) return null; tail = tail.slice(0, mm.index).trim(); }
  if ((mm = tail.match(/ ?for each (.+)$/i))) { countExpr = parseCount(mm[1]); if (!countExpr) return null; if (count === 1) count = 'EXPR'; tail = tail.slice(0, mm.index).trim(); }
  if ((mm = tail.match(/^with (.+?)(?: and (?:it|they) (.+))?$/i))) { kws = parseKeywords(mm[1]); if (!kws) return null; if (mm[2]) note = mm[2]; tail = ''; }
  if ((mm = tail.match(/^that(?:'s| are) (tapped and attacking|attacking)/i))) { note = mm[0]; if (/tapped/i.test(mm[1])) tapped = true; tail = ''; }
  if (tail) return null;
  if (count === 'EXPR' && !countExpr) return null;
  const named = TOKEN_NAMED[body.toLowerCase()];
  let token;
  if (named) token = { ...named, power: undefined, toughness: undefined, colors: [] };
  else {
    const pm = body.match(/^(\d+|X)\/(\d+|X) (.+?) ((?:artifact |enchantment )*)creature$/i);
    if (!pm) return null;
    const words = pm[3].split(/ and |, | /).filter(Boolean);
    const colors = [], subs = [];
    for (const w of words) {
      const lw = w.toLowerCase();
      if (lw in COLOR_WORDS) { if (COLOR_WORDS[lw]) colors.push(COLOR_WORDS[lw]); }
      else if (/^[A-Z]/.test(w)) subs.push(w);
      else return null;
    }
    const extra = pm[4].trim().split(' ').filter(Boolean).map(cap).join(' ');
    const name = subs.join(' ') || 'Creature';
    token = {
      name, power: pm[1], toughness: pm[2], colors,
      type_line: `Token ${extra ? extra + ' ' : ''}Creature${subs.length ? ' — ' + subs.join(' ') : ''}`,
      oracle_text: kws.join(', '),
    };
  }
  const key = 'gen:' + [token.name, token.power, token.toughness, (token.colors || []).join(''), token.oracle_text].join('|');
  return { count, countExpr, tapped, kws, note, key, token: { mana_cost: '', faces: [], keywords: [], legalities: {}, color_identity: token.colors || [], ...token } };
}

function parseSearch(s) {
  let m = s.match(/^search your library for (.+?)(?:,| and) (?:reveal (?:it|them|that card|those cards)(?:,| and) )?(put .+?)(?:,? then shuffle)?$/i);
  if (!m) return null;
  let what = m[1], max = 1, min = 0, mm;
  if ((mm = what.match(/^up to (one|two|three|four|five|seven|\d+) (.+)$/i))) { max = num(mm[1]); what = mm[2]; }
  else if ((mm = what.match(/^any number of (.+)$/i))) { max = 99; what = mm[1]; }
  else if ((mm = what.match(/^(a|an|one|two|three) (.+)$/i))) { max = num(mm[1]); what = mm[2]; }
  what = what.replace(/ cards?$/i, '').replace(/^card$/i, '');
  const filter = what ? parseFilter(what.split(' ').map(singular).join(' ')) : { alts: [{ types: [], subs: [], supers: [], nots: [] }] };
  if (!filter) return null;
  const put = m[2];
  let dest = null, tapped = false;
  if ((mm = put.match(/^put (?:it|that card|them|those cards|one of them|those cards) onto the battlefield( tapped)?(?: under your control)?$/i))) { dest = 'battlefield'; tapped = !!mm[1]; }
  else if (/^put (?:it|that card|them|those cards) into your hand$/i.test(put)) dest = 'hand';
  else if (/^put one onto the battlefield tapped and the other into your hand$/i.test(put)) { dest = 'split'; tapped = true; }
  else if (/^put (?:it|that card) on top(?: of your library)?$/i.test(put)) dest = 'top';
  else if (/^put (?:it|that card|them) into your graveyard$/i.test(put)) dest = 'graveyard';
  if (!dest) return null;
  return { k: 'search', filter, min, max, dest, tapped, what: what || 'card' };
}

/** Parses a single clause (no ". " inside). Returns a step or null. */
function parseClause(clause, ctx) {
  let s = dot(clause).replace(/^then /i, '').replace(/^and /i, '');
  let m;
  const step = (o) => ({ ...o, text: clause.trim() });
  // things we can safely ignore
  if (/^(it|they) can't be regenerated$|^activate (only )?(as a sorcery|once each turn|only during your turn)|^spend this mana only|^this ability triggers only once each turn$/i.test(s)) return step({ k: 'noop' });
  if (/^(?:then )?shuffle(?: your library)?$/i.test(s)) return step({ k: 'shuffle' });

  // draw
  if ((m = s.match(new RegExp('^(?:(you|target player|target opponent|each player|each opponent|that player) )?draws? ' + NW + ' cards?(?: for each (.+))?$', 'i')))) {
    const per = m[3] ? parseCount(m[3]) : null;
    if (m[3] && !per) return null;
    return step({ k: 'draw', who: parsePlayers(m[1] || 'you'), n: num(m[2]), per });
  }
  if ((m = s.match(/^(?:you )?draw cards equal to (.+)$/i))) { const per = parseCount(m[1]); return per ? step({ k: 'draw', who: { players: 'you' }, n: 1, per }) : null; }
  // life
  if ((m = s.match(new RegExp('^(?:(you|target player|each player|that player) )?gains? ' + NW + ' life(?: for each (.+))?$', 'i')))) {
    const per = m[3] ? parseCount(m[3]) : null;
    if (m[3] && !per) return null;
    return step({ k: 'gain', who: parsePlayers(m[1] || 'you'), n: num(m[2]), per });
  }
  if ((m = s.match(/^(?:you )?gain life equal to (.+)$/i))) { const per = parseCount(m[1]); return per ? step({ k: 'gain', who: { players: 'you' }, n: 1, per }) : null; }
  if ((m = s.match(new RegExp('^(you|target player|target opponent|each player|each opponent|that player|its controller) loses? ' + NW + ' life(?: for each (.+))?$', 'i')))) {
    const per = m[3] ? parseCount(m[3]) : null;
    if (m[3] && !per) return null;
    return step({ k: 'lose', who: parsePlayers(m[1]), n: num(m[2]), per });
  }
  // damage
  if ((m = s.match(new RegExp('^(?:~|it) deals ' + NW + ' damage to (.+?)(?: for each (.+))?$', 'i')))) {
    if (/divided as you choose/i.test(s)) return null;
    const to = parseRecipients(m[2]);
    const per = m[3] ? parseCount(m[3]) : null;
    if (!to || (m[3] && !per)) return null;
    return step({ k: 'damage', n: num(m[1]), to, per });
  }
  if ((m = s.match(/^(?:~|it) deals damage equal to (.+?) to (.+)$/i))) {
    const per = parseCount(m[1]), to = parseRecipients(m[2]);
    return per && to ? step({ k: 'damage', n: 1, to, per }) : null;
  }
  // destroy / exile / bounce / tap / untap / control
  if ((m = s.match(/^destroy (.+)$/i))) { const t = parseObjects(m[1]); return t ? step({ k: 'destroy', t }) : null; }
  if ((m = s.match(/^exile (.+?)(?: until (.+))?$/i))) {
    const t = parseObjects(m[1]);
    return t ? step({ k: 'exile', t, until: m[2] || null }) : null;
  }
  if ((m = s.match(/^return (.+?) to (?:its|their) owners?'? hands?$/i))) { const t = parseObjects(m[1]); return t ? step({ k: 'bounce', t }) : null; }
  if ((m = s.match(/^return (.+?) from your graveyard to (your hand|the battlefield( tapped)?)(?: under your control)?$/i))) {
    const t = parseObjects(m[1] + ' from your graveyard');
    if (!t || t.tgt !== 'gy') return null;
    return step({ k: 'regrow', t, dest: /hand/i.test(m[2]) ? 'hand' : 'battlefield', tapped: !!m[3] });
  }
  if ((m = s.match(/^(tap|untap) (.+)$/i))) { const t = parseObjects(m[2]); return t ? step({ k: m[1].toLowerCase(), t }) : null; }
  if ((m = s.match(/^gain control of (.+?)( until end of turn)?$/i))) { const t = parseObjects(m[1]); return t ? step({ k: 'control', t, eot: !!m[2] }) : null; }
  // counters
  if ((m = s.match(new RegExp('^put ' + NW + ' ([+-]\\d+\\/[+-]\\d+|[a-z]+) counters? on (.+)$', 'i')))) {
    const t = parseObjects(m[3]);
    return t ? step({ k: 'counters', n: num(m[1]), ctype: m[2].toLowerCase(), t }) : null;
  }
  if ((m = s.match(/^put a number of ([+-]\d+\/[+-]\d+|[a-z]+) counters on (.+?) equal to (.+)$/i))) {
    const t = parseObjects(m[2]), per = parseCount(m[3]);
    return t && per ? step({ k: 'counters', n: 1, per, ctype: m[1].toLowerCase(), t }) : null;
  }
  // pump & keywords
  if ((m = s.match(/^(.+?) (?:gets?) ([+-](?:\d+|X))\/([+-](?:\d+|X))(?: and (?:gains?|has|have) (.+?))? until end of turn$/i))) {
    const t = parseObjects(m[1].replace(/^(?:each|all) /i, 'each ').replace(/^(creatures|.+ creatures|permanents|.+s) (you control|your opponents control)$/i, 'each $1 $2'));
    const kws = m[4] ? parseKeywords(m[4]) : [];
    if (!t || (m[4] && !kws)) return null;
    return step({ k: 'pump', t, dp: m[2], dt: m[3], kws });
  }
  if ((m = s.match(/^(.+?) gains? (.+?) and gets? ([+-](?:\d+|X))\/([+-](?:\d+|X)) until end of turn$/i))) {
    const t = parseObjects(m[1].replace(/^(creatures|.+ creatures|permanents) (you control|your opponents control)$/i, 'each $1 $2'));
    const kws = parseKeywords(m[2]);
    if (!t || !kws) return null;
    return step({ k: 'pump', t, dp: m[3], dt: m[4], kws });
  }
  if ((m = s.match(/^(.+?) (?:gains?|has|have) (.+?) until end of turn(?: and (.+))?$/i))) {
    const t = parseObjects(m[1].replace(/^(creatures|.+ creatures|permanents|.+s) (you control|your opponents control)$/i, 'each $1 $2'));
    const kws = parseKeywords(m[2]);
    if (!t || !kws) return null;
    return step({ k: 'pump', t, dp: '+0', dt: '+0', kws, note: m[3] || '' });
  }
  if ((m = s.match(/^(.+?) can't block this turn$/i))) { const t = parseObjects(m[1]); return t ? step({ k: 'pump', t, dp: '+0', dt: '+0', kws: ["Can't block"] }) : null; }
  // tokens
  if ((m = s.match(/^(?:(you|its controller|that player|target player|each player|each opponent|target opponent) )?creates? (.+)$/i))) {
    const tp = parseTokenPhrase(m[2]);
    if (!tp) return null;
    return step({ k: 'token', who: parsePlayers(m[1] || 'you'), ...tp });
  }
  // library
  if ((m = s.match(new RegExp('^(?:(you|target player|target opponent|each player|each opponent) )?mills? ' + NW + ' cards?$', 'i'))))
    return step({ k: 'mill', who: parsePlayers(m[1] || 'you'), n: num(m[2]) });
  if ((m = s.match(new RegExp('^(scry|surveil) ' + NW + '$', 'i')))) return step({ k: 'look', mode: m[1].toLowerCase(), n: num(m[2]) });
  if ((m = s.match(new RegExp('^look at the top ' + NW + ' cards of your library$', 'i')))) return step({ k: 'look', mode: 'look', n: num(m[1]) });
  if (/^search your library/i.test(s)) { const r = parseSearch(s); return r ? step(r) : null; }
  if ((m = s.match(/^put (a|an) (.+?) card from your hand onto the battlefield( tapped)?$/i))) {
    const f = parseFilter(m[2]);
    return f ? step({ k: 'fromHand', filter: f, tapped: !!m[3], what: m[2] }) : null;
  }
  // stack
  if ((m = s.match(/^counter (target .+?)(?: unless (.+))?$/i))) {
    const t = parseObjects(m[1]);
    return t && t.tgt === 'stack' ? step({ k: 'counter', t, unless: m[2] || null }) : null;
  }
  // mana
  if ((m = s.match(/^add ((?:\{[WUBRGC]\})+)$/i))) {
    const add = {};
    for (const x of m[1].matchAll(/\{([WUBRGC])\}/g)) add[x[1]] = (add[x[1]] || 0) + 1;
    return step({ k: 'mana', add, any: 0 });
  }
  if ((m = s.match(/^add (one|two|three) mana of any (?:one )?colou?r$/i))) return step({ k: 'mana', add: {}, any: num(m[1]) });
  // sacrifice / discard
  if (/^sacrifice (?:~|it)$/i.test(s)) return step({ k: 'sacSelf', ref: /it$/i.test(s) ? 'it' : 'self' });
  if ((m = s.match(new RegExp('^discard ' + NW + ' cards?( at random)?$', 'i')))) return step({ k: 'discard', who: { players: 'you' }, n: num(m[1]), random: !!m[2] });
  if (/^discard your hand$/i.test(s)) return step({ k: 'discard', who: { players: 'you' }, n: 'hand' });
  if ((m = s.match(new RegExp('^(each player|each opponent|target player|target opponent) discards ' + NW + ' cards?( at random)?$', 'i'))))
    return step({ k: 'discard', who: parsePlayers(m[1]), n: num(m[2]), random: !!m[3] });
  if ((m = s.match(/^(each player|each opponent|target player|target opponent) discards (?:their|his or her) hand$/i))) return step({ k: 'discard', who: parsePlayers(m[1]), n: 'hand' });
  // fight / attach
  if ((m = s.match(/^(.+?) fights (.+)$/i))) {
    const a = parseObjects(m[1]), b = parseObjects(m[2]);
    return a && b ? step({ k: 'fight', a, b }) : null;
  }
  if ((m = s.match(/^attach ~ to (.+)$/i))) { const t = parseObjects(m[1]); return t ? step({ k: 'attach', t }) : null; }
  return null;
}

/**
 * Parses the effect text of a spell or ability.
 * Returns { modal: null | {min, max, modes: [text]}, steps: [...], manual: [text] }.
 * Steps keep .optional ("you may"), .cond ({kicked} / {ifYouDo} / {control: filter} / {unknown}), .xExpr.
 */
export function parseEffects(text, opts = {}) {
  const t = opts.normalized ? String(text) : norm(text, opts.name);
  const lines = t.split('\n').map(s => s.trim()).filter(Boolean);
  const mi = lines.findIndex(l => /^Choose (one|two|three|one or both|one or more|any number)\b.*—/i.test(l) || /^Choose (one|two|three|one or both|one or more)/i.test(l) && lines.some(x => x.startsWith('•')));
  if (mi >= 0) {
    const head = lines[mi];
    const cm = head.match(/^Choose (one or both|one or more|any number|one|two|three)/i);
    const range = { 'one': [1, 1], 'two': [2, 2], 'three': [3, 3], 'one or both': [1, 2], 'one or more': [1, 9], 'any number': [0, 9] }[cm[1].toLowerCase()];
    const modes = lines.slice(mi + 1).filter(l => l.startsWith('•')).map(l => l.replace(/^•\s*/, ''));
    const pre = lines.slice(0, mi).join('\n');
    const base = pre ? parseEffects(pre, { normalized: true }) : { steps: [], manual: [] };
    return { modal: { min: range[0], max: Math.min(range[1], modes.length), modes }, steps: base.steps, manual: base.manual };
  }
  const steps = [], manual = [];
  for (const line of lines) {
    for (let sent of sentences(line)) {
      let m;
      // "where X is ..." applies to the whole sentence
      let xExpr = null;
      if ((m = sent.match(/,? where X is (.+)$/i))) { xExpr = parseCount(m[1]); sent = sent.slice(0, m.index); if (!xExpr) { manual.push(sent); continue; } }
      let cond = null, optional = false;
      if ((m = sent.match(/^If ~ was kicked, (.+)$/i))) { cond = { kicked: true }; sent = m[1]; }
      else if ((m = sent.match(/^If you do, (.+)$/i))) { cond = { ifYouDo: true }; sent = m[1]; }
      else if ((m = sent.match(/^If (you control (?:another|a|an|two or more|three or more) .+?), (.+)$/i))) { cond = { control: m[1] }; sent = m[2]; }
      else if ((m = sent.match(/^If (.+?), (.+)$/i))) { cond = { unknown: m[1] }; sent = m[2]; }
      if ((m = sent.match(/^you may (.+)$/i))) { optional = true; sent = m[1]; }
      // reveal the top N ... put all X into your hand and the rest on the bottom
      if ((m = sent.match(new RegExp('^reveal the top ' + NW + ' cards of your library$', 'i')))) {
        steps.push({ k: 'reveal', n: num(m[1]), text: sent, cond, optional, xExpr });
        continue;
      }
      if ((m = sent.match(/^put all (.+?) cards revealed this way into your hand and the rest on the bottom of your library(?: in any order| in a random order)?$/i)) && steps.length && steps[steps.length - 1].k === 'reveal') {
        const f = parseFilter(m[1]);
        if (f) { steps[steps.length - 1].take = f; steps[steps.length - 1].what = m[1]; continue; }
      }
      const parsed = parseSentence(sent);
      if (!parsed) { manual.push((optional ? 'You may ' : '') + sent); continue; }
      parsed.forEach((p, i) => {
        if (i === 0) { p.optional = p.optional || optional; p.cond = cond; }
        if (xExpr) p.xExpr = xExpr;
        if (p.k !== 'noop') steps.push(p);
      });
    }
  }
  // An unfinished "reveal" (no matching "put all ...") can't be automated.
  for (let i = steps.length - 1; i >= 0; i--) if (steps[i].k === 'reveal' && !steps[i].take) { manual.unshift(steps[i].text); steps.splice(i, 1); }
  return { modal: null, steps, manual };
}

function parseSentence(sent) {
  const one = parseClause(sent);
  if (one) return [one];
  // split ", then" / "; then"
  for (const sep of [/, then /i, /; then /i, /\. Then /i]) {
    const parts = sent.split(sep);
    if (parts.length > 1) {
      const res = parts.map(p => parseClause(p));
      if (res.every(Boolean)) return res;
    }
  }
  // split once on " and " where both halves parse (e.g. "Each opponent loses 2 life and you gain 2 life")
  const words = sent.split(' and ');
  for (let i = 1; i < words.length; i++) {
    const a = parseClause(words.slice(0, i).join(' and ')), b = parseClause(words.slice(i).join(' and '));
    if (a && b) return [a, b];
  }
  return null;
}

// ------------------------------------------------------------------ activated abilities

/** Lists activated abilities (non-mana) of a face, with parsed costs. */
export function activatedAbilities(face, name) {
  const raw = String(face.oracle_text || '').split('\n');
  const out = [];
  raw.forEach((line, i) => {
    const l = dot(norm(line, name || face.name).trim());
    if (!l) return;
    let m;
    if ((m = l.match(/^Equip(?: (.+?))? ((?:\{[^}]+\})+)$/))) {
      const f = m[1] ? parseFilter(m[1] + ' creature') : parseFilter('creature');
      out.push({ i, kind: 'activated', cost: m[2], costParts: parseCostParts(m[2]), text: `Attach ~ to target ${m[1] ? m[1] + ' ' : ''}creature you control`, label: `Equip ${m[2]}`, sorcery: true, equip: f });
      return;
    }
    if ((m = l.match(/^(Cycling|Ninjutsu|Unearth|Embalm|Eternalize|Reconfigure|Outlast|Level up|Scavenge|Fortify|Transmute|Forecast|Channel)\b[^{:]*((?:\{[^}]+\})+)$/))) {
      const text = m[1] === 'Cycling' ? 'Draw a card' : `${m[1]} ability`;
      out.push({ i, kind: 'activated', cost: m[2], costParts: parseCostParts(m[2]), text, label: `${m[1]} ${m[2]}`, keyword: m[1], fromHand: m[1] === 'Cycling' || m[1] === 'Channel' || m[1] === 'Ninjutsu' });
      return;
    }
    m = l.match(/^([^:"]+?):\s*(.+)$/);
    if (!m) return;
    const cost = m[1].trim();
    if (parseManaLine(l)) return; // mana ability: use "Tap for mana"
    const loyal = cost.match(/^([+−-]?)(\d+|X)$/);
    if (loyal) {
      const sign = loyal[1] === '+' ? 1 : loyal[1] ? -1 : 0;
      out.push({ i, kind: 'loyalty', cost, text: m[2], sign, amount: loyal[2] === 'X' ? null : parseInt(loyal[2], 10), label: cost });
      return;
    }
    if (!/\{[^}]+\}|Sacrifice|Discard|Pay |Exile|Tap |Remove|Return|Put |Crew/i.test(cost)) return;
    const effect = m[2];
    out.push({ i, kind: 'activated', cost, costParts: parseCostParts(cost), text: effect, label: cost,
      sorcery: /Activate only as a sorcery/i.test(effect), oncePerTurn: /Activate only once each turn/i.test(effect) });
  });
  return out;
}

// ------------------------------------------------------------------ "what the app understands" about a card

export function describeStep(st) {
  const n = st.n === 'X' ? 'X' : st.n;
  const who = w => !w ? '' : w.players === 'you' ? '' : w.players === 'opps' ? 'Each opponent: ' : w.players === 'all' ? 'Each player: ' : w.tgt ? 'Target player: ' : w.players === 'ref' ? 'That player: ' : w.players === 'defender' ? 'Defending player: ' : '';
  const tgt = t => !t ? '' : t.ref === 'self' ? 'itself' : t.ref ? 'it' : t.desc || (t.group ? 'all matching' : '');
  const per = st.per ? ' (counted)' : '';
  switch (st.k) {
    case 'draw': return `${who(st.who)}draw ${n}${per}`;
    case 'gain': return `${who(st.who)}gain ${n} life${per}`;
    case 'lose': return `${who(st.who)}lose ${n} life${per}`;
    case 'damage': return `${n}${per} damage to ${st.to.map(r => r.tgt === 'any' ? 'any target' : r.players ? ({ you: 'you', opps: 'each opponent', all: 'each player', ref: 'that player', defender: 'defending player' })[r.players] : tgt(r)).join(' and ')}`;
    case 'destroy': case 'exile': case 'bounce': case 'tap': case 'untap': return `${{ bounce: 'return to hand', destroy: 'destroy', exile: 'exile', tap: 'tap', untap: 'untap' }[st.k]} ${tgt(st.t)}`;
    case 'control': return `gain control of ${tgt(st.t)}${st.eot ? ' until end of turn' : ''}`;
    case 'regrow': return `return ${st.t.desc} to ${st.dest === 'hand' ? 'hand' : 'the battlefield'}`;
    case 'counters': return `${n}${per} ${st.ctype} counter(s) on ${tgt(st.t)}`;
    case 'pump': return `${tgt(st.t)} ${st.dp !== '+0' || st.dt !== '+0' ? `${st.dp}/${st.dt}` : ''}${st.kws.length ? ' ' + st.kws.join(', ') : ''} until end of turn`.replace(/\s+/g, ' ');
    case 'token': return `${who(st.who)}create ${st.count === 'EXPR' || st.count === 'X' ? 'X' : st.count}× ${st.token.name}${st.token.power != null ? ` ${st.token.power}/${st.token.toughness}` : ''} token${st.kws.length ? ` with ${st.kws.join(', ')}` : ''}`;
    case 'mill': return `${who(st.who)}mill ${n}`;
    case 'look': return `${st.mode} ${n}`;
    case 'search': return `search library for ${st.max > 1 ? `up to ${st.max} ` : ''}${st.what} → ${st.dest === 'split' ? '1 to battlefield tapped, 1 to hand' : st.dest}${st.tapped && st.dest === 'battlefield' ? ' tapped' : ''}`;
    case 'shuffle': return 'shuffle';
    case 'fromHand': return `put a ${st.what} card from hand onto the battlefield`;
    case 'counter': return `counter ${tgt(st.t)}`;
    case 'mana': return `add ${st.any ? `${st.any} mana of any color` : Object.entries(st.add).map(([k, v]) => `{${k}}`.repeat(v)).join('')}`;
    case 'sacSelf': return 'sacrifice it';
    case 'discard': return `${who(st.who)}discard ${st.n === 'hand' ? 'hand' : n}${st.random ? ' at random' : ''}`;
    case 'reveal': return `reveal top ${n}, take ${st.what}`;
    case 'fight': return 'fight';
    case 'attach': return `attach to ${tgt(st.t)}`;
    default: return st.k;
  }
}

/**
 * For the card reader: what each line of a card does in the app.
 * Returns [{ text, status: 'auto' | 'partial' | 'manual', what }].
 */
export function understand(face, name) {
  const nm = name || face.name;
  const raw = String(face.oracle_text || '').split('\n');
  const tl = face.type_line || '';
  const isSpell = /\b(Instant|Sorcery)\b/.test(tl);
  const mana = manaAbilities(face, nm);
  const acts = activatedAbilities(face, nm);
  const out = [];
  raw.forEach((rawLine, i) => {
    const line = dot(norm(rawLine, nm).trim());
    const shown = rawLine.replace(/\([^)]*\)/g, '').trim();
    if (!line) return;
    const kws = parseKeywords(line);
    if (kws) {
      const unknown = kws.filter(k => !AUTOMATED_KEYWORDS.has(k.toLowerCase()) && !/^(Protection|Ward)/.test(k));
      out.push({ text: shown, status: unknown.length ? (unknown.length === kws.length ? 'manual' : 'partial') : 'auto', what: 'Keyword' + (kws.length > 1 ? 's' : '') });
      return;
    }
    if (mana.some(o => o.line === i)) { out.push({ text: shown, status: 'auto', what: 'Mana ability' }); return; }
    const etb = entersTappedRule({ oracle_text: rawLine, type_line: tl }, nm);
    if (etb !== 'untapped') { out.push({ text: shown, status: etb === 'ask' ? 'partial' : 'auto', what: 'Enters tapped' }); return; }
    const act = acts.find(a => a.i === i);
    if (act) {
      const eff = parseEffects(act.text, { name: nm });
      const costOk = act.kind === 'loyalty' || !act.costParts.other.length;
      out.push({ text: shown, status: statusOf(eff, costOk), what: act.kind === 'loyalty' ? 'Loyalty ability' : act.equip ? 'Equip' : 'Activated ability', detail: eff.steps.map(describeStep) });
      return;
    }
    const trig = parseTrigger(line);
    if (trig) {
      const eff = parseEffects(trig.effect, { normalized: true });
      out.push({ text: shown, status: trig.ev === 'unknown' ? 'manual' : statusOf(eff, true), what: 'Triggered ability', detail: eff.steps.map(describeStep) });
      return;
    }
    const st = parseStatic(line);
    if (st) { out.push({ text: shown, status: 'auto', what: 'Static ability' }); return; }
    const costs = spellCosts({ oracle_text: rawLine, type_line: tl }, nm);
    if (costs.additional) { out.push({ text: shown, status: costs.additional.manual.length ? 'partial' : 'auto', what: 'Additional cost' }); return; }
    if (costs.altLife != null) { out.push({ text: shown, status: 'auto', what: 'Alternative cost' }); return; }
    if (costs.kicker || costs.flashback || costs.selfReduce) { out.push({ text: shown, status: 'auto', what: costs.kicker ? 'Kicker' : costs.flashback ? 'Flashback' : 'Cost reduction' }); return; }
    if (costs.enchant) { out.push({ text: shown, status: costs.enchant.filter ? 'auto' : 'manual', what: 'Aura' }); return; }
    if (isSpell || /^(Choose|•)/.test(line)) {
      const eff = parseEffects(line, { normalized: true });
      if (/^Choose/.test(line)) { out.push({ text: shown, status: 'auto', what: 'Modes' }); return; }
      out.push({ text: shown, status: statusOf(eff, true), what: line.startsWith('•') ? 'Mode' : 'Spell effect', detail: eff.steps.map(describeStep) });
      return;
    }
    out.push({ text: shown, status: 'manual', what: 'Rules text' });
  });
  return out;
}

function statusOf(eff, costOk) {
  const auto = eff.steps.length > 0;
  if (auto && !eff.manual.length && costOk) return 'auto';
  if (auto || eff.modal) return 'partial';
  return 'manual';
}
