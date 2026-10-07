// game.js — the game engine: zones, turn structure, stack, mana, combat,
// state-based actions, Commander rules, and the card-text engine
// (triggers, effects, static abilities, alternative costs). No DOM.

import { parseCost, payCost, colorNeeds, hasKeyword, FORMATS, RuleError } from './rules.js?v=20261007-3';
import * as FX from './effects.js?v=20261007-3';
export { RuleError };

export const PHASES = ['Untap', 'Upkeep', 'Draw', 'Main 1', 'Beginning of Combat', 'Declare Attackers',
  'Declare Blockers', 'Combat Damage', 'End of Combat', 'Main 2', 'End', 'Cleanup'];
export const ZONES = ['library', 'hand', 'battlefield', 'graveyard', 'exile', 'command'];
const SAVE_KEY = 'mtgsim-save-v1';
const COLOR_KEYS = ['W', 'U', 'B', 'R', 'G'];
export const DEFAULT_SETTINGS = { cmdrToCommandZone: true, autoTriggers: true, autoUpkeep: true, autoDraw: true, forceCleanup: true };

export const emptyPool = () => ({ W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 });
const blankEot = () => ({ p: 0, t: 0, kw: [] });

function rnd(n) {
  const a = new Uint32Array(1);
  globalThis.crypto.getRandomValues(a);
  return a[0] % n;
}
export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) { const j = rnd(i + 1); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const PACKS = new Map(); // parsed card text, cached per card face

export class Game {
  constructor(db = {}, s = null) {
    this.db = db;         // key -> slim card data (cards + tokens)
    this.s = s;           // serialisable game state
    this.undoStack = [];
    this.onChange = () => {};  // UI re-render
    this.onSync = () => {};    // network broadcast (online host)
    this._events = [];
    this._entering = null;
    this._kwDepth = 0;
  }

  canUndo() { return this.undoStack.length > 0; }
  opt(k) { return !this.s || !this.s.settings || this.s.settings[k] !== false; }

  /**
   * Starts a fresh game with the same players and decks, in place, so the same
   * Game object (and online connections) carry on. Keeps the match score.
   * In a two-player game the loser of the last game goes first.
   */
  rematch(byPid = null) {
    const prev = this.s;
    if (!prev.setup) throw new Error('This game has no deck information to rematch with.');
    const losers = prev.players.filter(p => p.lost).map(p => p.id);
    const first = prev.players.length === 2 && losers.length === 1 ? losers[0] : null;
    const g = Game.create({ format: prev.setup.format, players: prev.setup.players, db: this.db, first });
    Object.assign(g.s, { score: prev.score || {}, match: (prev.match || 1) + 1, online: prev.online, settings: prev.settings });
    this.s = g.s;
    this.undoStack = [];
    const who = byPid != null && this.players[byPid] ? `${this.players[byPid].name} started a rematch. ` : '';
    this.log(`🔁 ${who}Game ${this.s.match} — score: ${this.scoreLine()}.`);
    this.save();
    this.onChange();
    this.onSync();
  }

  scoreLine() {
    return this.players.map(p => `${p.name} ${this.s.score[p.id] || 0}`).join(' · ');
  }

  // ------------------------------------------------------------ setup

  /** players: [{ name, main: [{key, qty}], commanders: [key] }] */
  static create({ format, players, db, first = null }) {
    const g = new Game(db);
    const f = FORMATS[format] || FORMATS.freeform;
    g.s = {
      format, turn: 0, active: 0, phase: 0, stage: 'mulligan', stack: [], log: [], nextId: 1,
      winner: null, firstPlayer: 0, cmdrNames: {}, settings: { ...DEFAULT_SETTINGS }, pending: null,
      setup: JSON.parse(JSON.stringify({ format, players })), match: 1, score: {},
      players: players.map((p, i) => ({
        id: i, name: p.name, life: f.life, poison: 0, cmdrDmg: {}, pool: emptyPool(), landsPlayed: 0,
        cmdrCasts: {}, lost: false, drewEmpty: false, mulligans: 0, kept: false, toBottom: 0, spellsCast: 0,
        zones: { library: [], hand: [], battlefield: [], graveyard: [], exile: [], command: [] },
      })),
    };
    players.forEach((p, i) => {
      const pl = g.s.players[i];
      for (const { key, qty } of p.main) for (let k = 0; k < qty; k++) pl.zones.library.push(g.newInst(key, i));
      for (const key of p.commanders) {
        const c = g.newInst(key, i);
        c.isCommander = true;
        pl.zones.command.push(c);
        pl.cmdrCasts[c.iid] = 0;
        g.s.cmdrNames[c.iid] = db[key].name;
      }
      shuffle(pl.zones.library);
      g.drawN(pl, 7);
    });
    g.s.firstPlayer = first != null && first >= 0 && first < players.length ? first : rnd(players.length);
    g.s.active = g.s.firstPlayer;
    g.log(`Format: ${f.name}. Starting life ${f.life}.`);
    g.log(`${g.s.players[g.s.firstPlayer].name} ${first != null ? 'lost the last game and goes first' : 'was chosen at random to go first'}.`);
    g.log(`Mulligans: London mulligan${g.freeMulligan() ? ', first mulligan is free' : ''}.`);
    g.save();
    return g;
  }

  static load() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      const { db, s } = JSON.parse(raw);
      s.settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
      return new Game(db, s);
    } catch { return null; }
  }
  static hasSave() { try { return !!localStorage.getItem(SAVE_KEY); } catch { return false; } }
  static clearSave() { try { localStorage.removeItem(SAVE_KEY); } catch { /* ignore */ } }
  save() {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(SAVE_KEY, JSON.stringify({ db: this.db, s: this.s })); }
    catch { /* ignore */ }
  }

  newInst(key, owner) {
    return {
      iid: this.s.nextId++, key, owner, controller: owner, tapped: false, face: 0, counters: {},
      damage: 0, deathtouched: false, sick: false, token: false, isCommander: false,
      attacking: null, blocking: null, eot: blankEot(), mod: { p: 0, t: 0 }, note: '', castAs: null, x: 0,
    };
  }

  freeMulligan() { return this.s.players.length > 2 || this.s.format === 'commander'; }

  // ------------------------------------------------------------ queries

  log(msg) {
    this.s.log.push({ turn: this.s.turn, msg });
    if (this.s.log.length > 600) this.s.log.shift();
  }
  get players() { return this.s.players; }
  alive() { return this.s.players.filter(p => !p.lost); }

  face(inst) {
    const d = this.db[inst.key];
    if (!d) return { name: '?', type_line: '', oracle_text: '', faces: [] };
    if (inst.castAs) return { ...d, ...inst.castAs, image: d.image };
    const ownImages = d.faces && d.faces.length > 1 && d.faces[0].image;
    if (ownImages) {
      const f = d.faces[inst.face] || d.faces[0];
      return { ...d, ...f, image: f.image || d.image };
    }
    return d;
  }
  hasFaces(inst) { const d = this.db[inst.key]; return !!(d && d.faces && d.faces.length > 1 && d.faces[0].image); }

  /** Parsed text of an object's current face (cached). */
  pack(inst) {
    const f = this.face(inst);
    const id = `${inst.key}|${inst.castAs ? 'c:' + inst.castAs.name : inst.face}`;
    let p = PACKS.get(id);
    if (p) return p;
    const name = f.name;
    const lines = FX.norm(f.oracle_text || '', name).split('\n').map(l => l.trim());
    const triggers = [], statics = [];
    lines.forEach((l, i) => {
      const t = FX.parseTrigger(l);
      if (t && t.ev !== 'unknown') { triggers.push({ ...t, line: i }); return; }
      const st = FX.parseStatic(l);
      if (st) statics.push({ ...st, line: i });
    });
    p = {
      name, triggers, statics,
      manas: FX.manaAbilities(f, name),
      acts: FX.activatedAbilities(f, name),
      costs: FX.spellCosts(f, name),
      etb: FX.entersTappedRule(f, name),
    };
    PACKS.set(id, p);
    return p;
  }

  onBattlefield(inst) {
    const p = this.s && this.s.players[inst.controller];
    return !!(p && p.zones.battlefield.includes(inst));
  }

  /** All static abilities currently in effect, with their source. */
  _statics() {
    const out = [];
    for (const p of this.players) for (const c of p.zones.battlefield) for (const st of this.pack(c).statics) out.push({ src: c, st });
    return out;
  }

  devotion(pid, colors) {
    let n = 0;
    for (const c of this.players[pid].zones.battlefield) {
      const mc = this.face(c).mana_cost || '';
      for (const m of mc.matchAll(/\{([^}]+)\}/g)) if (m[1].split('/').some(x => colors.includes(x))) n++;
    }
    return n;
  }

  isType(inst, t) { return new RegExp('\\b' + t + '\\b').test(this.face(inst).type_line || ''); }
  isCreature(inst) {
    if (!this.isType(inst, 'Creature')) return false;
    if (this.s && inst.controller != null && this.players[inst.controller]) {
      for (const st of this.pack(inst).statics) if (st.k === 'devotionNotCreature' && this.devotion(inst.controller, st.colors) < st.n) return false;
    }
    return true;
  }

  /** Does `inst` match a parsed filter, from the point of view of player `refPid` (and source `selfIid`)? */
  matches(inst, f, refPid, selfIid = null) {
    if (!f) return false;
    if (f.any) return true;
    const face = this.face(inst);
    let tl = face.type_line || '';
    if (/\bCreature\b/.test(tl) && this.onBattlefield(inst) && !this.isCreature(inst)) tl = tl.replace(/\bCreature\b/, '');
    return FX.matchFilter(tl, {
      ctrlIsMe: inst.controller === refPid, isSelf: inst.iid === selfIid, tapped: inst.tapped, attacking: inst.attacking != null,
      blocking: inst.blocking != null, token: !!inst.token, power: this.isCreature(inst) ? this.pt(inst).p : null,
      colors: face.colors || [], changeling: hasKeyword(face.oracle_text, 'Changeling'),
      kw: k => this.kw(inst, k),
    }, f);
  }

  kw(inst, k) {
    const lk = k.toLowerCase();
    if ((inst.eot && inst.eot.kw || []).some(x => x.toLowerCase() === lk)) return true;
    if (hasKeyword(this.face(inst).oracle_text, k)) return true;
    if (!this.s || this._kwDepth > 1 || !this.onBattlefield(inst)) return false;
    this._kwDepth++;
    try {
      for (const { src, st } of this._statics()) {
        if (!st.kws || !st.kws.some(x => x.toLowerCase() === lk)) continue;
        if (st.k === 'attached' && src.attachedTo === inst.iid) return true;
        if (st.k === 'selfKw' && src === inst) return true;
        if (st.k === 'lord' && this.isCreature(inst) && this.matches(inst, st.filter, src.controller, src.iid)) return true;
      }
    } finally { this._kwDepth--; }
    return false;
  }

  pt(inst) {
    const f = this.face(inst);
    const n = v => { const x = parseInt(v, 10); return isNaN(x) ? 0 : x; };
    const c = inst.counters || {};
    const plus = (c['+1/+1'] || 0) - (c['-1/-1'] || 0);
    let p = n(f.power) + plus + (inst.mod ? inst.mod.p : 0) + (inst.eot ? inst.eot.p : 0);
    let t = n(f.toughness) + plus + (inst.mod ? inst.mod.t : 0) + (inst.eot ? inst.eot.t : 0);
    if (this.s && !this._ptBusy && this.onBattlefield(inst)) {
      this._ptBusy = true;
      try {
        for (const { src, st } of this._statics()) {
          if (st.k === 'lord' && (st.dp || st.dt) && this.matches(inst, st.filter, src.controller, src.iid)) { p += st.dp; t += st.dt; }
          else if (st.k === 'attached' && src.attachedTo === inst.iid) { p += st.dp; t += st.dt; }
          else if (st.k === 'selfPer' && src === inst) { const k = this.count(st.per, inst.controller, inst); p += st.dp * k; t += st.dt * k; }
          else if (st.k === 'coatOfArms' && this.isCreature(inst)) {
            const mine = this._creatureTypes(inst);
            let k = 0;
            for (const pl of this.players) for (const o of pl.zones.battlefield) {
              if (o === inst || !this.isCreature(o)) continue;
              const theirs = this._creatureTypes(o);
              if (mine.all || theirs.all ? (mine.list.length || mine.all) && (theirs.list.length || theirs.all) : mine.list.some(x => theirs.list.includes(x))) k++;
            }
            p += k; t += k;
          }
        }
      } finally { this._ptBusy = false; }
    }
    return { p, t };
  }
  _creatureTypes(inst) {
    const f = this.face(inst);
    const sub = (f.type_line || '').split('—')[1] || '';
    return { list: sub.trim().split(/\s+/).filter(Boolean), all: hasKeyword(f.oracle_text, 'Changeling') };
  }

  /** Evaluates a count spec ("for each Elf you control", "~'s power", ...). */
  count(spec, pid, src = null, ref = null) {
    if (!spec) return 1;
    if (spec.k === 'power') { const o = spec.of === 'ref' ? (ref || src) : src; return o ? Math.max(0, this.pt(o).p) : 0; }
    if (spec.k === 'hand') return this.players[pid].zones.hand.length;
    if (spec.k === 'maxPower') {
      let best = 0;
      for (const p of this.players) for (const c of p.zones.battlefield)
        if ((spec.scope !== 'you' || c.controller === pid) && this.isCreature(c) && this.matches(c, spec.filter, pid, src && src.iid)) best = Math.max(best, this.pt(c).p);
      return best;
    }
    if (spec.k === 'count') {
      let n = 0;
      if (spec.zone === 'graveyard') {
        for (const c of this.players[pid].zones.graveyard) if (FX.matchFilter(this.face(c).type_line, { ctrlIsMe: true, colors: this.face(c).colors }, spec.filter)) n++;
        return n;
      }
      for (const p of this.players) for (const c of p.zones.battlefield) {
        if (spec.scope === 'you' && c.controller !== pid) continue;
        if (spec.scope === 'opp' && c.controller === pid) continue;
        if (this.matches(c, spec.filter, pid, src && src.iid)) n++;
      }
      return n;
    }
    return 1;
  }

  locate(iid) {
    iid = +iid;
    for (const p of this.s.players) for (const z of ZONES) {
      const arr = p.zones[z];
      const i = arr.findIndex(c => c.iid === iid);
      if (i >= 0) return { pl: p, zone: z, idx: i, inst: arr[i], arr };
    }
    const i = this.s.stack.findIndex(c => c.iid === iid);
    if (i >= 0) return { pl: this.s.players[this.s.stack[i].controller], zone: 'stack', idx: i, inst: this.s.stack[i], arr: this.s.stack };
    return null;
  }
  need(iid) { const L = this.locate(iid); if (!L) throw new Error('That card is no longer there.'); return L; }
  nameOf(iid) { const L = this.locate(iid); return L ? this.face(L.inst).name : (this.s.cmdrNames[iid] || 'a card'); }
  commanderTax(inst) { return 2 * (this.s.players[inst.owner].cmdrCasts[inst.iid] || 0); }

  /** Activated (non-mana) abilities, with parsed costs. */
  abilities(inst) {
    const f = this.face(inst);
    return FX.activatedAbilities(f, f.name);
  }

  /** What the app understands about a card, line by line (for the card reader). */
  understand(inst) {
    const f = this.face(inst);
    return FX.understand(f, f.name);
  }

  commanderIdentity(pid) {
    const keys = (this.s.setup && this.s.setup.players[pid] && this.s.setup.players[pid].commanders) || [];
    if (!keys.length) return COLOR_KEYS;
    const ids = new Set();
    for (const k of keys) for (const c of ((this.db[k] || {}).color_identity || [])) ids.add(c);
    return COLOR_KEYS.filter(c => ids.has(c));
  }

  timingError(pl, inst, typeLine) {
    const instantSpeed = /\bInstant\b/.test(typeLine) || this.kw(inst, 'Flash');
    if (instantSpeed) return null;
    if (this.s.stage !== 'play') return 'The game has not started yet (finish mulligans).';
    if (this.s.active !== pl.id) return 'Sorcery speed: you can only do this during your own turn.';
    const ph = PHASES[this.s.phase];
    if (ph !== 'Main 1' && ph !== 'Main 2') return 'Sorcery speed: only during your main phase.';
    if (this.s.stack.length) return 'Sorcery speed: the stack must be empty.';
    return null;
  }

  // ------------------------------------------------------------ action plumbing

  act(fn) {
    const snap = JSON.stringify(this.s);
    this._events = [];
    this._entering = null;
    try { fn(); this._settle(); }
    catch (e) { this.s = JSON.parse(snap); this._events = []; this._entering = null; throw e; }
    this._entering = null;
    this.undoStack.push(snap);
    if (this.undoStack.length > 80) this.undoStack.shift();
    this.save();
    this.onChange();
    this.onSync();
  }

  /** After every action: state-based actions, triggered abilities, automatic turn steps. */
  _settle() {
    for (let guard = 0; guard < 30; guard++) {
      this.sba();
      const t = this._flushTriggers();
      const a = this._autoAdvance();
      if (!t && !a && !this._events.length) break;
    }
  }

  undo() {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.s = JSON.parse(prev);
    this.log('↶ Last action undone.');
    this.save();
    this.onChange();
    this.onSync();
    return true;
  }

  /** Chat / notes go to the log without touching the undo history. */
  chat(pid, text) {
    const t = String(text || '').trim().slice(0, 300);
    if (!t) return;
    this.log(`💬 ${this.players[pid] ? this.players[pid].name : '?'}: ${t}`);
    this.save();
    this.onChange();
    this.onSync();
  }

  /** Returns copies of the top n library cards (top first). */
  peekTop(pid, n, quiet = false) {
    const pl = this.players[pid];
    const out = JSON.parse(JSON.stringify(pl.zones.library.slice(-n).reverse()));
    if (!quiet) this.act(() => this.log(`${pl.name} looks at the top ${n} card${n === 1 ? '' : 's'} of their library.`));
    return out;
  }

  revealHand(pid) {
    this.act(() => {
      const pl = this.players[pid];
      this.log(`${pl.name} reveals their hand: ${pl.zones.hand.map(c => this.face(c).name).join(', ') || '(empty)'}.`);
    });
  }

  // ------------------------------------------------------------ zone movement

  _reset(inst) {
    Object.assign(inst, {
      tapped: false, counters: {}, damage: 0, deathtouched: false, attacking: null, blocking: null,
      eot: blankEot(), mod: { p: 0, t: 0 }, sick: false, note: '', castAs: null, x: 0, controller: inst.owner,
      attachedTo: null, choices: null, kicked: false, flashback: false, trigTurns: null, actTurns: null, eotControl: null,
    });
  }

  /** Should this permanent enter tapped? choice: 'pay' | 'tapped' | 'untapped' from the player, if they were asked. */
  _etbTapped(inst, pid, choice) {
    const rule = this.pack(inst).etb;
    const pl = this.players[pid];
    if (rule === 'untapped') return false;
    if (rule === 'tapped') return true;
    if (rule && rule.shock) {
      if (choice === 'pay') { pl.life -= rule.shock; this.log(`${pl.name} pays ${rule.shock} life so ${this.face(inst).name} enters untapped.`); return false; }
      return true;
    }
    if (rule === 'ask') return choice !== 'untapped';
    if (rule && rule.unless) {
      const ok = this._condition(rule.unless, pid, inst);
      if (ok === null) { this.log(`⚠ ${this.face(inst).name}: enters tapped unless ${rule.unless} — check this yourself.`); return choice === 'tapped'; }
      return !ok;
    }
    return false;
  }

  /** Evaluates simple conditions like "you control two or fewer other lands". Returns true/false, or null if unknown. */
  _condition(text, pid, self) {
    const t = String(text).trim().replace(/\.$/, '');
    const lands = this.players[pid].zones.battlefield.filter(c => c !== self && this.isType(c, 'Land')).length;
    let m;
    if (/^you control two or fewer other lands$/i.test(t)) return lands <= 2;
    if (/^you control two or more other lands$/i.test(t)) return lands >= 2;
    if (/^you have two or more opponents$/i.test(t)) return this.alive().filter(p => p.id !== pid).length >= 2;
    if ((m = t.match(/^you control (another|a|an|two or more|three or more) (.+)$/i))) {
      const f = FX.parseFilter(m[2].replace(/ or an? /g, ' or ').split(' ').map(FX.singular).join(' '));
      if (!f) return null;
      if (/another/i.test(m[1])) f.other = true;
      const need = /two or more/i.test(m[1]) ? 2 : /three or more/i.test(m[1]) ? 3 : 1;
      const n = this.players[pid].zones.battlefield.filter(c => this.matches(c, f, pid, self && self.iid)).length;
      return n >= need;
    }
    return null;
  }

  _enterBf(inst, pid, tapped = false, etbChoice = null) {
    inst.controller = pid;
    inst.tapped = tapped || this._etbTapped(inst, pid, etbChoice);
    inst.sick = true;
    const f = this.face(inst);
    const loy = parseInt(f.loyalty, 10);
    if (this.isType(inst, 'Planeswalker') && !isNaN(loy) && inst.counters.loyalty === undefined) inst.counters.loyalty = loy;
    const def = parseInt(f.defense, 10);
    if (this.isType(inst, 'Battle') && !isNaN(def) && inst.counters.defense === undefined) inst.counters.defense = def;
    this.s.players[pid].zones.battlefield.push(inst);
    this._events.push({ t: 'enter', iid: inst.iid });
  }

  /** Low-level move; must be called inside act(). */
  _move(inst, zone, { toPlayer = null, pos = 'top', tapped = false, keepFace = false, silent = false, why = '', etb = null } = {}) {
    const L = this.need(inst.iid);
    const from = L.zone;
    L.arr.splice(L.idx, 1);
    const name = this.face(inst).name;
    if (inst.ability) return; // abilities on the stack simply disappear
    if (from === 'battlefield') {
      if (zone === 'graveyard' && this.isCreature(inst)) {
        const attached = [];
        for (const p of this.players) for (const c of p.zones.battlefield) if (c.attachedTo === inst.iid) attached.push(c.iid);
        this._events.push({ t: 'die', snap: { iid: inst.iid, key: inst.key, face: inst.face, controller: inst.controller, owner: inst.owner,
          token: !!inst.token, power: this.pt(inst).p, attached } });
      }
    }
    if (inst.token && zone !== 'battlefield') {
      if (!silent) this.log(`${name} (token) left the battlefield and ceased to exist.`);
      return;
    }
    const ctrl = toPlayer ?? (from === 'stack' || from === 'battlefield' ? inst.controller : inst.owner);
    const face = inst.face;
    this._reset(inst);
    inst.face = keepFace ? face : 0;
    let dest = zone;
    if (inst.isCommander && (zone === 'graveyard' || zone === 'exile') && this.s.settings.cmdrToCommandZone) {
      dest = 'command';
    }
    if (dest === 'battlefield') this._enterBf(inst, ctrl, tapped, etb);
    else {
      const owner = this.s.players[inst.owner];
      const lib = owner.zones.library;
      if (dest === 'library') {
        if (pos === 'bottom') lib.unshift(inst);
        else if (typeof pos === 'number') lib.splice(Math.max(0, lib.length - pos), 0, inst);
        else lib.push(inst);
      } else owner.zones[dest].push(inst);
    }
    if (silent) return;
    const hidden = (from === 'library' && (dest === 'hand' || dest === 'library')) || (from === 'hand' && dest === 'library');
    const label = hidden ? 'a card' : name;
    const where = dest === 'library' ? `${pos === 'bottom' ? 'bottom' : 'top'} of library` : dest;
    let msg = `${label}: ${from} → ${where}${why ? ` (${why})` : ''}`;
    if (dest === 'command' && zone !== 'command') msg += ' — commander returned to the command zone';
    this.log(msg);
  }

  drawN(pl, n) {
    let drawn = 0;
    for (let i = 0; i < n; i++) {
      if (!pl.zones.library.length) {
        if (this.s.stage === 'play') { pl.drewEmpty = true; this.log(`${pl.name} tried to draw from an empty library!`); }
        break;
      }
      pl.zones.hand.push(pl.zones.library.pop());
      drawn++;
    }
    return drawn;
  }

  // ------------------------------------------------------------ public actions

  draw(pid, n = 1) {
    this.act(() => { const pl = this.players[pid]; const d = this.drawN(pl, n); this.log(`${pl.name} draws ${d} card${d === 1 ? '' : 's'}.`); });
  }
  _mill(pl, n) {
    const names = [];
    for (let i = 0; i < n && pl.zones.library.length; i++) {
      const c = pl.zones.library[pl.zones.library.length - 1];
      names.push(this.face(c).name);
      this._move(c, 'graveyard', { silent: true });
    }
    this.log(`${pl.name} mills ${names.length}: ${names.join(', ') || 'nothing'}.`);
  }
  mill(pid, n = 1) { this.act(() => this._mill(this.players[pid], n)); }
  shuffleLibrary(pid) {
    this.act(() => { shuffle(this.players[pid].zones.library); this.log(`${this.players[pid].name} shuffles their library.`); });
  }
  move(iid, zone, opts = {}) { this.act(() => this._move(this.need(iid).inst, zone, opts)); }

  // mulligans
  mulligan(pid) {
    this.act(() => {
      const pl = this.players[pid];
      if (this.s.stage !== 'mulligan' || pl.kept) throw new Error('You already kept.');
      pl.zones.library.push(...pl.zones.hand);
      pl.zones.hand = [];
      shuffle(pl.zones.library);
      this.drawN(pl, 7);
      pl.mulligans++;
      this.log(`${pl.name} mulligans (${pl.mulligans}).`);
    });
  }
  keep(pid) {
    this.act(() => {
      const pl = this.players[pid];
      if (pl.kept) return;
      pl.kept = true;
      pl.toBottom = Math.max(0, pl.mulligans - (this.freeMulligan() ? 1 : 0));
      this.log(`${pl.name} keeps${pl.toBottom ? ` and must put ${pl.toBottom} card${pl.toBottom > 1 ? 's' : ''} on the bottom` : ''}.`);
      this._checkStart();
    });
  }
  bottomFromHand(pid, iid) {
    this.act(() => {
      const pl = this.players[pid];
      if (pl.toBottom <= 0) throw new Error('No cards need to go to the bottom.');
      this._move(this.need(iid).inst, 'library', { pos: 'bottom', silent: true });
      pl.toBottom--;
      this._checkStart();
    });
  }
  _checkStart() {
    if (this.s.stage === 'mulligan' && this.players.every(p => p.kept && p.toBottom === 0)) {
      this.s.stage = 'play';
      this.s.turn = 0;
      this.log('All players have kept. The game begins!');
      this._beginTurn(this.s.firstPlayer);
    }
  }

  // ------------------------------------------------------------ turn structure

  _emptyPools() { for (const p of this.players) p.pool = emptyPool(); }

  _nextAlive(pid) {
    const n = this.players.length;
    for (let k = 1; k <= n; k++) { const q = (pid + k) % n; if (!this.players[q].lost) return q; }
    return pid;
  }

  _beginTurn(pid) {
    const s = this.s;
    s.active = pid;
    s.turn++;
    s.phase = 0;
    s.pending = null;
    this._emptyPools();
    const pl = this.players[pid];
    pl.landsPlayed = 0;
    for (const p of this.players) p.spellsCast = 0;
    for (const c of pl.zones.battlefield) { c.tapped = false; c.sick = false; }
    this.log(`━━ Turn ${s.turn}: ${pl.name} ━━  (untap step: permanents untapped)`);
    s.phase = 1;
    this._events.push({ t: 'step', step: 'Upkeep' });
    this._entering = 'Upkeep';
  }

  /** Auto upkeep / auto draw: move on through steps where nothing happened. */
  _autoAdvance() {
    const s = this.s;
    if (!this._entering || s.stage !== 'play' || s.winner != null || s.pending || s.stack.length || this._events.length) return false;
    const st = this._entering;
    this._entering = null;
    if (st === 'Upkeep' && this.opt('autoUpkeep') && PHASES[s.phase] === 'Upkeep') {
      s.phase = PHASES.indexOf('Draw');
      this._enterStep();
      return true;
    }
    if (st === 'Draw' && this.opt('autoDraw') && PHASES[s.phase] === 'Draw') {
      s.phase = PHASES.indexOf('Main 1');
      this._enterStep();
      return true;
    }
    return false;
  }

  _blockIfPending() {
    const p = this.s.pending;
    if (p && p.type === 'discard') throw new RuleError(`${this.players[p.pid].name} must first discard ${plural(p.n, 'card')} down to their maximum hand size.`);
  }

  nextStep({ force = false } = {}) {
    this.act(() => {
      const s = this.s;
      if (s.stage !== 'play') throw new Error('Finish mulligans first.');
      if (s.winner != null) throw new Error('The game is over.');
      this._blockIfPending();
      if (s.stack.length && !force) throw new RuleError('There are spells/abilities on the stack. Resolve them before moving on.');
      if (PHASES[s.phase] === 'Declare Attackers' && !force) {
        const atk = this.players[s.active].zones.battlefield.filter(c => c.attacking != null);
        if (atk.length) this.log(`${this.players[s.active].name} attacks with ${atk.map(c => this.face(c).name).join(', ')}.`);
      }
      this._emptyPools();
      if (PHASES[s.phase] === 'Cleanup') {
        const pl = this.players[s.active];
        if (pl.zones.hand.length > 7 && !force) throw new RuleError(`${pl.name} has ${pl.zones.hand.length} cards and must discard down to 7.`);
        this._cleanup();
        this._beginTurn(this._nextAlive(s.active));
        return;
      }
      s.phase++;
      this._enterStep();
    });
  }

  _enterStep() {
    const s = this.s;
    const ph = PHASES[s.phase];
    const pl = this.players[s.active];
    if (ph === 'Draw') {
      if (s.turn === 1 && this.players.length === 2) this.log(`${pl.name} skips the first draw (two-player game).`);
      else { this.drawN(pl, 1); this.log(`${pl.name} draws for the turn.`); }
      this._entering = 'Draw';
    } else if (ph === 'Combat Damage') this.combatDamage();
    else if (ph === 'End of Combat') {
      for (const p of this.players) for (const c of p.zones.battlefield) { c.attacking = null; c.blocking = null; delete c.wasBlocked; }
    } else if (ph === 'Cleanup') {
      if (pl.zones.hand.length > 7) {
        const n = pl.zones.hand.length - 7;
        if (this.opt('forceCleanup')) {
          s.pending = { type: 'discard', pid: pl.id, n };
          this.log(`${pl.name} must discard ${plural(n, 'card')} (maximum hand size 7).`);
        } else this.log(`${pl.name} must discard ${n} card(s) (hand size 7).`);
      } else {
        this._cleanup();
        if (this.opt('forceCleanup')) this._beginTurn(this._nextAlive(s.active));
      }
    }
    if (['Upkeep', 'Draw', 'Main 1', 'Beginning of Combat', 'Main 2', 'End'].includes(ph)) this._events.push({ t: 'step', step: ph });
  }

  /** Forced cleanup: the active player discards down to 7, then the turn passes. */
  cleanupDiscard(pid, iids) {
    this.act(() => {
      const p = this.s.pending;
      if (!p || p.type !== 'discard') throw new Error('Nothing needs to be discarded.');
      if (p.pid !== pid) throw new Error(`Only ${this.players[p.pid].name} can choose what to discard.`);
      const pl = this.players[pid];
      const ids = [...new Set((iids || []).map(Number))];
      if (ids.length !== p.n) throw new Error(`Choose exactly ${plural(p.n, 'card')} to discard.`);
      const cards = ids.map(id => pl.zones.hand.find(c => c.iid === id));
      if (cards.some(c => !c)) throw new Error('Those cards are not in your hand.');
      for (const c of cards) this._move(c, 'graveyard', { silent: true });
      this.log(`${pl.name} discards ${cards.map(c => this.face(c).name).join(', ')} (hand size).`);
      this.s.pending = null;
      this._cleanup();
      this._beginTurn(this._nextAlive(this.s.active));
    });
  }

  _cleanup() {
    for (const p of this.players) for (const c of [...p.zones.battlefield]) {
      c.damage = 0; c.deathtouched = false; c.eot = blankEot();
      if (c.eotControl != null && c.controller !== c.eotControl) {
        const back = c.eotControl;
        p.zones.battlefield.splice(p.zones.battlefield.indexOf(c), 1);
        c.controller = back; c.eotControl = null; c.attacking = null; c.blocking = null;
        this.players[back].zones.battlefield.push(c);
        this.log(`${this.face(c).name} returns to ${this.players[back].name}'s control.`);
      }
    }
  }

  endTurn({ force = false } = {}) {
    this.act(() => {
      const s = this.s;
      if (s.stage !== 'play') throw new Error('Finish mulligans first.');
      this._blockIfPending();
      if (s.stack.length && !force) throw new RuleError('There are spells/abilities on the stack.');
      this._emptyPools();
      for (const p of this.players) for (const c of p.zones.battlefield) { c.attacking = null; c.blocking = null; }
      const pl = this.players[s.active];
      const endIdx = PHASES.indexOf('End');
      if (this.opt('forceCleanup')) {
        if (s.phase < endIdx) {
          s.phase = endIdx;
          this._enterStep();
          this._flushTriggers();
          if (s.stack.length) { this.log('End step: triggered abilities are on the stack.'); return; }
        }
        s.phase = PHASES.indexOf('Cleanup');
        this._enterStep();
        return;
      }
      if (pl.zones.hand.length > 7 && !force) {
        s.phase = PHASES.indexOf('Cleanup');
        this.log(`${pl.name} must discard down to 7 before the turn ends.`);
        return;
      }
      this._cleanup();
      this._beginTurn(this._nextAlive(s.active));
    });
  }

  skipCombat() {
    this.act(() => {
      const s = this.s;
      const i = PHASES.indexOf('Main 2');
      if (s.phase >= i) throw new Error('Combat is already over this turn.');
      if (s.stack.length) throw new Error('Resolve the stack first.');
      this._blockIfPending();
      for (const p of this.players) for (const c of p.zones.battlefield) { c.attacking = null; c.blocking = null; }
      this._emptyPools();
      const boc = PHASES.indexOf('Beginning of Combat');
      if (s.phase < boc) {
        s.phase = boc;
        this._enterStep();
        this._flushTriggers();
        if (s.stack.length) { this.log('Beginning of combat: triggered abilities are on the stack.'); return; }
      }
      s.phase = i;
      this._enterStep();
      this.log('Combat skipped → Main 2.');
    });
  }

  // ------------------------------------------------------------ lands

  /** What a land needs from its player when played: null | {shock: life} | 'ask' | {unless} */
  landPrompt(inst) {
    const r = this.pack(inst).etb;
    if (r && r.shock) return r;
    if (r === 'ask') return 'ask';
    return null;
  }

  playLand(iid, { force = false, etb = null } = {}) {
    this.act(() => {
      const { inst, zone } = this.need(iid);
      const pl = this.players[inst.owner];
      const f = this.face(inst);
      if (!/\bLand\b/.test(f.type_line)) throw new Error('That is not a land.');
      if (!force) {
        if (zone !== 'hand') throw new RuleError(`Playing a land from your ${zone} requires an effect that allows it.`);
        const err = this.timingError(pl, inst, 'Land');
        if (err) throw new RuleError(err.replace('Sorcery speed', 'Lands'));
        if (pl.landsPlayed >= 1) throw new RuleError('You already played a land this turn.');
      }
      pl.landsPlayed++;
      this._move(inst, 'battlefield', { toPlayer: pl.id, keepFace: true, silent: true, etb });
      inst.sick = false;
      this.log(`${pl.name} plays ${f.name}${inst.tapped ? ' (enters tapped)' : ''}.`);
    });
  }

  // ------------------------------------------------------------ mana

  /** Mana abilities of a permanent with their current amounts. */
  manaChoices(inst) {
    return this.pack(inst).manas.map((o, idx) => {
      const n = o.per ? this.count(o.per, inst.controller, inst) : 1;
      return { ...o, idx, n, label: FX.manaLabel(o) + (o.per ? ` (= ${n})` : '') };
    });
  }

  canTapForMana(inst) {
    if (inst.tapped) return false;
    if (this.isCreature(inst) && inst.sick && !this.kw(inst, 'Haste')) return false;
    return true;
  }

  /**
   * Untapped sources that can pay automatically. Sacrifice and mana-costed abilities are never used automatically;
   * painful ones (life / damage) only when allowPain.
   */
  manaSources(pl, exclude, allowPain = false) {
    const ident = this.commanderIdentity(pl.id);
    return pl.zones.battlefield
      .filter(c => c.iid !== exclude && this.canTapForMana(c))
      .map(c => {
        const opts = this.manaChoices(c)
          .filter(o => o.cost.tap && !o.cost.sac && !o.cost.mana && !o.cost.untap && (allowPain || (!o.cost.life && !o.cost.damage)))
          .map(o => {
            const add = {};
            for (const k in o.add) add[k] = o.add[k] * o.n;
            return { add, any: o.any * o.n, anyOne: o.anyOne * o.n, colors: o.identity ? ident : COLOR_KEYS, pain: (o.cost.life || 0) + (o.cost.damage || 0) };
          })
          .filter(o => o.any || o.anyOne || Object.keys(o.add).length);
        return { c, opts };
      })
      .filter(x => x.opts.length)
      .sort((a, b) => (this.isCreature(a.c) - this.isCreature(b.c)) || (a.opts.length - b.opts.length) ||
        (Math.min(...a.opts.map(o => o.pain)) - Math.min(...b.opts.map(o => o.pain))));
  }

  _tryPay(pl, cost, x, exclude, allowPain) {
    const pool = { ...pl.pool };
    const taps = [];
    const used = new Set();
    const srcs = this.manaSources(pl, exclude, allowPain);
    for (let guard = 0; guard < 300; guard++) {
      const r = payCost(pool, cost, x, false);
      if (r) return { ...r, taps };
      const avail = srcs.filter(s => !used.has(s.c.iid));
      if (!avail.length) break;
      const need = colorNeeds(pool, cost);
      let pick = null, add = null, pain = 0;
      outer: for (const col of need) {
        for (const s of avail) { const o = s.opts.filter(o => o.add[col]).sort((a, b) => a.pain - b.pain)[0]; if (o) { pick = s; add = o.add; pain = o.pain; break outer; } }
        for (const s of avail) {
          const o = s.opts.filter(o => (o.any || o.anyOne) && o.colors.includes(col)).sort((a, b) => a.pain - b.pain)[0];
          if (o) { pick = s; add = { [col]: o.any || o.anyOne }; pain = o.pain; break outer; }
        }
      }
      if (!pick) {
        if (need.length) break;
        pick = avail[0];
        const o = [...pick.opts].sort((a, b) => a.pain - b.pain)[0];
        add = Object.keys(o.add).length ? o.add : { [o.colors[0] || 'C']: o.any || o.anyOne };
        pain = o.pain;
      }
      used.add(pick.c.iid);
      taps.push({ c: pick.c, pain });
      for (const k in add) pool[k] = (pool[k] || 0) + add[k];
    }
    const r = payCost(pool, cost, x, true);
    return r ? { ...r, taps } : null;
  }

  /** Pays from the pool, auto-tapping mana sources if needed. Returns {pool, lifeLoss} or null. */
  autoPay(pl, cost, x = 0, exclude = null) {
    const r = this._tryPay(pl, cost, x, exclude, false) || this._tryPay(pl, cost, x, exclude, true);
    if (!r) return null;
    let pain = 0;
    for (const t of r.taps) { t.c.tapped = true; pain += t.pain; }
    if (r.taps.length) this.log(`Auto-tapped ${r.taps.map(t => this.face(t.c).name).join(', ')} for mana${pain ? ` (${pain} life from painful sources)` : ''}.`);
    return { pool: r.pool, lifeLoss: r.lifeLoss + pain };
  }

  _payMana(pl, costStr, x, exclude, force, what) {
    if (!costStr) return '';
    const r = this.autoPay(pl, typeof costStr === 'string' ? parseCost(costStr) : costStr, x, exclude);
    if (r) { pl.pool = r.pool; if (r.lifeLoss) { pl.life -= r.lifeLoss; return ` (paid ${r.lifeLoss} life)`; } return ''; }
    if (!force) throw new RuleError(`Not enough mana to pay ${what || costStr}.`);
    return ' (cost not paid — override)';
  }

  /** optIdx: index into manaChoices(inst). colors: color or array of colors for "any color" abilities. */
  tapForMana(iid, optIdx, colors = null, { force = false } = {}) {
    this.act(() => {
      const { inst, zone } = this.need(iid);
      if (zone !== 'battlefield') throw new Error('Not on the battlefield.');
      const o = this.manaChoices(inst)[optIdx];
      if (!o) throw new Error('That mana ability was not found.');
      const name = this.face(inst).name;
      const pl = this.players[inst.controller];
      if (o.cost.tap) {
        if (inst.tapped && !force) throw new RuleError(`${name} is already tapped.`);
        if (this.isCreature(inst) && inst.sick && !this.kw(inst, 'Haste') && !force)
          throw new RuleError(`${name} has summoning sickness and can't tap for mana this turn.`);
      }
      const extra = [];
      if (o.cost.mana) { const note = this._payMana(pl, o.cost.mana, 0, iid, force); extra.push(`paying ${o.cost.mana}${note}`); }
      if (o.cost.tap) inst.tapped = true;
      if (o.cost.untap) inst.tapped = false;
      if (o.cost.life) { pl.life -= o.cost.life; extra.push(`paying ${o.cost.life} life`); }
      if (o.cost.damage) { pl.life -= o.cost.damage; extra.push(`it deals ${o.cost.damage} damage to them`); }
      const n = o.n;
      const add = {};
      for (const k in o.add) add[k] = o.add[k] * n;
      const list = Array.isArray(colors) ? colors : colors ? [colors] : [];
      const allowed = o.identity ? this.commanderIdentity(pl.id) : COLOR_KEYS;
      if (o.any) {
        const want = o.any * n;
        for (let i = 0; i < want; i++) {
          const c = list[i] || list[list.length - 1] || allowed[0] || 'C';
          if (!allowed.includes(c) && !force) throw new RuleError(`${name} can only make ${allowed.join('')} mana.`);
          add[c] = (add[c] || 0) + 1;
        }
      }
      if (o.anyOne) { const c = list[0] || 'C'; add[c] = (add[c] || 0) + o.anyOne * n; }
      for (const k in add) pl.pool[k] = (pl.pool[k] || 0) + add[k];
      const made = Object.entries(add).map(([k, v]) => `{${k}}`.repeat(v)).join('') || 'nothing';
      this.log(`${pl.name} ${o.cost.tap ? 'taps' : 'uses'} ${name} for ${made}${extra.length ? ` (${extra.join(', ')})` : ''}.`);
      if (o.cost.sac) this._move(inst, 'graveyard', { silent: true, why: 'sacrificed for mana' });
    });
  }
  addMana(pid, color, n = 1) {
    this.act(() => {
      const pl = this.players[pid];
      const before = pl.pool[color] || 0;
      pl.pool[color] = Math.max(0, before + n);
      const d = pl.pool[color] - before;
      if (d) this.log(`${pl.name} ${d > 0 ? 'adds' : 'removes'} ${`{${color}}`.repeat(Math.abs(d))} ${d > 0 ? 'to' : 'from'} their mana pool.`);
    });
  }
  clearPool(pid) {
    this.act(() => { const pl = this.players[pid]; pl.pool = emptyPool(); this.log(`${pl.name} empties their mana pool.`); });
  }

  /**
   * What a player could still make by tapping untapped mana sources
   * (lands, rocks, dorks without summoning sickness). Each source counts once
   * toward `total`; `per[color]` is how much of that color is reachable.
   */
  availableMana(pid) {
    const pl = this.players[pid];
    const per = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
    let total = 0;
    const srcs = this.manaSources(pl, null, true);
    for (const { opts } of srcs) {
      total += Math.max(...opts.map(o => Object.values(o.add).reduce((a, b) => a + b, 0) + o.any + o.anyOne));
      for (const k of Object.keys(per)) per[k] += Math.max(0, ...opts.map(o => (o.add[k] || 0) + (k !== 'C' && o.colors.includes(k) ? o.any + o.anyOne : 0)));
    }
    return { total, per, sources: srcs.length };
  }

  // ------------------------------------------------------------ casting

  /** Generic mana reduction for casting `inst` (static "Goblin spells cost {1} less" + self "costs {1} less for each"). */
  costReduction(inst, pid) {
    let n = 0;
    const f = this.face(inst);
    for (const { src, st } of this._statics()) {
      if (st.k !== 'costReduce' || src.controller !== pid) continue;
      if (st.filter.any || FX.matchFilter(f.type_line, { ctrlIsMe: true, colors: f.colors }, st.filter)) n += st.n;
    }
    const sr = this.pack(inst).costs.selfReduce;
    if (sr) n += sr.n * this.count(sr.per, pid, inst);
    return n;
  }

  /** Cast options for a card in hand/command zone/graveyard (for the UI). */
  castOptions(inst) {
    const c = this.pack(inst).costs;
    const L = this.locate(inst.iid);
    return {
      altLife: c.altLife, altLifeCond: c.altLifeCond || null, altOther: c.altOther,
      kicker: c.kicker, flashback: L && L.zone === 'graveyard' ? c.flashback : null,
      additional: c.additional, enchant: c.enchant, reduce: L ? this.costReduction(inst, inst.owner) : 0,
    };
  }

  /**
   * half: optional {name, mana_cost, type_line, oracle_text, adventure} for split/adventure cards.
   * alt: null | 'life' | 'flashback'. kicked: bool.
   * choices: { modes: [i], targets: {slotKey: [id]}, sac: [iid], discard: [iid] }
   */
  cast(iid, { force = false, x = 0, ignoreCost = false, half = null, alt = null, kicked = false, choices = {} } = {}) {
    this.act(() => {
      let L = this.need(iid);
      const inst = L.inst;
      const pl = this.players[inst.owner];
      const f = half || this.face(inst);
      const costs = this.pack(inst).costs;
      if (/\bLand\b/.test(f.type_line) && !/\/\//.test(f.type_line)) throw new Error('That is a land — use "Play land".');
      if (L.zone === 'battlefield' || L.zone === 'stack') throw new Error(`It's already on the ${L.zone}.`);
      if (alt === 'flashback' && (L.zone !== 'graveyard' || !costs.flashback)) throw new Error('Only a card with flashback in your graveyard can be cast with flashback.');
      if (!force) {
        const err = this.timingError(pl, inst, f.type_line);
        if (err) throw new RuleError(err);
        if (L.zone !== 'hand' && !(L.zone === 'command' && inst.isCommander) && alt !== 'flashback')
          throw new RuleError(`Casting from your ${L.zone} requires an effect that allows it (flashback, etc.).`);
      }
      // additional costs first (they may need choices)
      const add = costs.additional;
      const notes = [];
      if (add && !ignoreCost) {
        if (add.sac) {
          const ids = (choices.sac || []).map(Number);
          const ok = ids.length === add.sac.n && ids.every(id => { const c = pl.zones.battlefield.find(b => b.iid === id); return c && this.matches(c, add.sac.filter, pl.id); });
          if (!ok && !force) throw new RuleError(`As an additional cost, sacrifice ${add.sac.n} ${add.sac.desc}.`);
        }
        if (add.discard) {
          const ids = (choices.discard || []).map(Number);
          if ((ids.length !== add.discard || ids.some(id => id === inst.iid || !pl.zones.hand.some(h => h.iid === id))) && !force)
            throw new RuleError(`As an additional cost, discard ${plural(add.discard, 'card')}.`);
        }
      }
      let costStr = alt === 'flashback' ? costs.flashback : alt === 'life' ? '' : (f.mana_cost || '');
      const cost = parseCost(costStr);
      if (kicked && costs.kicker) {
        const k = parseCost(costs.kicker);
        for (const key of ['generic', 'X', 'W', 'U', 'B', 'R', 'G', 'C']) cost[key] += k[key];
        cost.hybrid.push(...k.hybrid); cost.phyrexian.push(...k.phyrexian);
        notes.push(`kicked ${costs.kicker}`);
      }
      const fromCommand = L.zone === 'command' && inst.isCommander;
      const tax = fromCommand ? this.commanderTax(inst) : 0;
      cost.generic += tax;
      const reduce = this.costReduction(inst, pl.id);
      if (reduce) { const r = Math.min(reduce, cost.generic); cost.generic -= r; if (r) notes.push(`{${r}} less`); }
      let paidNote = '';
      if (alt === 'life') {
        if (costs.altLife == null && !force) throw new RuleError("This spell doesn't have a pay-life alternative cost.");
        if (costs.altLifeCond && this._condition(costs.altLifeCond, pl.id, inst) === false && !force) throw new RuleError(`You can only pay life instead if ${costs.altLifeCond}.`);
        pl.life -= costs.altLife || 0;
        paidNote = ` by paying ${costs.altLife} life instead of its mana cost`;
      } else if (!ignoreCost) {
        const r = this.autoPay(pl, cost, x, iid);
        if (r) { pl.pool = r.pool; if (r.lifeLoss) { pl.life -= r.lifeLoss; paidNote = ` (paid ${r.lifeLoss} life)`; } }
        else if (!force) throw new RuleError(`Not enough mana to pay ${costStr || '{0}'}${kicked && costs.kicker ? ` + kicker ${costs.kicker}` : ''}${tax ? ` + {${tax}} commander tax` : ''}${reduce ? ` (−{${reduce}})` : ''}.`);
        else paidNote = ' (cost not paid — override)';
      } else paidNote = ' without paying its mana cost';
      if (add && !ignoreCost) {
        if (add.life) { pl.life -= add.life; notes.push(`paid ${add.life} life`); }
        for (const id of (choices.sac || []).map(Number)) { const c = pl.zones.battlefield.find(b => b.iid === id); if (c) { notes.push(`sacrificed ${this.face(c).name}`); this._move(c, 'graveyard', { silent: true }); } }
        for (const id of (choices.discard || []).map(Number)) { const c = pl.zones.hand.find(b => b.iid === id); if (c) { notes.push(`discarded ${this.face(c).name}`); this._move(c, 'graveyard', { silent: true }); } }
        for (const m of add.manual) notes.push(`also: ${m}`);
      }
      if (fromCommand) pl.cmdrCasts[inst.iid] = (pl.cmdrCasts[inst.iid] || 0) + 1;
      L = this.need(iid);
      L.arr.splice(L.idx, 1);
      inst.castAs = half ? { name: half.name, mana_cost: half.mana_cost, type_line: half.type_line, oracle_text: half.oracle_text, adventure: !!half.adventure } : null;
      inst.x = x;
      inst.controller = pl.id;
      inst.kicked = !!kicked;
      inst.flashback = alt === 'flashback';
      inst.choices = { modes: choices.modes || null, targets: choices.targets || {} };
      this.s.stack.push(inst);
      pl.spellsCast = (pl.spellsCast || 0) + 1;
      const tgt = this.describeTargets(inst.choices.targets);
      this.log(`${pl.name} casts ${f.name}${x ? ` (X=${x})` : ''}${tax ? ` (commander tax {${tax}})` : ''}${paidNote}${notes.length ? ` — ${notes.join(', ')}` : ''}${tgt ? ` targeting ${tgt}` : ''}.`);
      this._events.push({ t: 'cast', iid: inst.iid, pid: pl.id, typeLine: f.type_line, colors: f.colors || [] });
    });
  }

  // ------------------------------------------------------------ activated abilities

  activate(iid, lineIdx, { force = false, x = 0, choices = {} } = {}) {
    this.act(() => {
      const L = this.need(iid);
      const inst = L.inst;
      const ab = this.abilities(inst).find(a => a.i === lineIdx);
      if (!ab) throw new Error('Ability not found.');
      const pl = this.players[L.zone === 'battlefield' ? inst.controller : inst.owner];
      const name = this.face(inst).name;
      const notes = [];
      if (ab.kind === 'loyalty') {
        if (L.zone !== 'battlefield') throw new Error('Planeswalker must be on the battlefield.');
        if (!force) {
          const err = this.timingError(pl, inst, 'Sorcery');
          if (err) throw new RuleError(err.replace('Sorcery speed', 'Loyalty abilities'));
          if (inst.loyaltyTurn === this.s.turn) throw new RuleError('Only one loyalty ability per planeswalker per turn.');
        }
        const delta = ab.sign * (ab.amount ?? x);
        const loy = (inst.counters.loyalty || 0) + delta;
        if (loy < 0 && !force) throw new RuleError(`Not enough loyalty (has ${inst.counters.loyalty || 0}).`);
        inst.counters.loyalty = loy;
        inst.loyaltyTurn = this.s.turn;
      } else {
        const c = ab.costParts;
        if (ab.fromHand) { if (L.zone !== 'hand' && !force) throw new RuleError(`${ab.keyword} is activated from your hand.`); }
        else if (L.zone !== 'battlefield' && !c.exileSelf && !force) throw new RuleError(`${name} must be on the battlefield to use that ability.`);
        if (!force && (ab.sorcery || ab.equip)) { const err = this.timingError(pl, inst, 'Sorcery'); if (err) throw new RuleError(err.replace('Sorcery speed', 'This ability is sorcery speed')); }
        if (ab.oncePerTurn) {
          inst.actTurns = inst.actTurns || {};
          if (inst.actTurns[ab.i] === this.s.turn && !force) throw new RuleError('This ability can only be activated once each turn.');
          inst.actTurns[ab.i] = this.s.turn;
        }
        if (c.tap) {
          if (inst.tapped && !force) throw new RuleError(`${name} is already tapped.`);
          if (this.isCreature(inst) && inst.sick && !this.kw(inst, 'Haste') && !force)
            throw new RuleError(`${name} has summoning sickness: it can't use {T} abilities this turn.`);
        }
        if (c.removeCounter) {
          const have = inst.counters[c.removeCounter.type] || 0;
          const n = c.removeCounter.n === 'X' ? x : c.removeCounter.n;
          if (have < n && !force) throw new RuleError(`${name} needs ${n} ${c.removeCounter.type} counter(s).`);
        }
        const sacIds = (choices.sac || []).map(Number);
        if (c.sac) {
          const ok = sacIds.length === c.sac.n && sacIds.every(id => { const s = pl.zones.battlefield.find(b => b.iid === id); return s && this.matches(s, c.sac.filter, pl.id, inst.iid); });
          if (!ok && !force) throw new RuleError(`To activate, sacrifice ${c.sac.n} ${c.sac.desc}.`);
        }
        const discIds = (choices.discard || []).map(Number);
        if (c.discard && discIds.length !== c.discard && !force) throw new RuleError(`To activate, discard ${plural(c.discard, 'card')}.`);
        const tapIds = (choices.tapOther || []).map(Number);
        if (c.tapOther) {
          const t = pl.zones.battlefield.find(b => b.iid === tapIds[0]);
          if ((!t || t.tapped || !this.matches(t, c.tapOther.filter, pl.id)) && !force) throw new RuleError(`To activate, tap an untapped ${c.tapOther.desc} you control.`);
        }
        // pay
        if (c.mana) notes.push(this._payMana(pl, c.mana, x, iid, force).trim());
        if (c.tap) inst.tapped = true;
        if (c.untap) inst.tapped = false;
        if (c.life) { const n = c.life === 'X' ? x : c.life; pl.life -= n; notes.push(`paid ${n} life`); }
        if (c.removeCounter) { const n = c.removeCounter.n === 'X' ? x : c.removeCounter.n; inst.counters[c.removeCounter.type] = Math.max(0, (inst.counters[c.removeCounter.type] || 0) - n); }
        for (const id of tapIds) { const t = pl.zones.battlefield.find(b => b.iid === id); if (t) { t.tapped = true; notes.push(`tapped ${this.face(t).name}`); } }
        for (const id of sacIds) { const s = pl.zones.battlefield.find(b => b.iid === id); if (s) { notes.push(`sacrificed ${this.face(s).name}`); this._move(s, 'graveyard', { silent: true }); } }
        for (const id of discIds) { const d = pl.zones.hand.find(b => b.iid === id); if (d) { notes.push(`discarded ${this.face(d).name}`); this._move(d, 'graveyard', { silent: true }); } }
        if (c.discardHand) { for (const d of [...pl.zones.hand]) this._move(d, 'graveyard', { silent: true }); notes.push('discarded their hand'); }
        if (c.sacSelf || c.exileSelf || ab.fromHand) {
          const dest = c.exileSelf ? 'exile' : 'graveyard';
          if (ab.fromHand || this.locate(iid)) this._move(inst, dest, { silent: true });
          notes.push(c.sacSelf ? `sacrificed ${name}` : ab.fromHand ? `discarded ${name}` : `exiled ${name}`);
        }
        if (c.other.length) notes.push(`also pay: ${c.other.join(', ')}`);
      }
      const item = {
        iid: this.s.nextId++, ability: true, key: inst.key, face: inst.face, source: inst.iid, controller: pl.id, owner: pl.id,
        label: `${name}: ${ab.label || ab.cost}`, text: ab.text, srcName: name, x, counters: {}, eot: blankEot(), mod: { p: 0, t: 0 }, castAs: null,
        choices: { modes: choices.modes || null, targets: choices.targets || {} }, ctx: {},
      };
      this.s.stack.push(item);
      const tgt = this.describeTargets(item.choices.targets);
      this.log(`${pl.name} activates ${name} [${ab.label || ab.cost}]${notes.filter(Boolean).length ? ` (${notes.filter(Boolean).join(', ')})` : ''}: ${ab.text}${tgt ? ` — targeting ${tgt}` : ''}`);
    });
  }

  // ------------------------------------------------------------ attachments

  _attach(att, host) {
    if (!host || !this.onBattlefield(host)) return false;
    att.attachedTo = host.iid;
    this.log(`${this.face(att).name} is attached to ${this.face(host).name}.`);
    return true;
  }
  attach(iid, hostIid) {
    this.act(() => {
      const a = this.need(iid).inst, h = this.need(hostIid);
      if (h.zone !== 'battlefield') throw new Error('Attach to something on the battlefield.');
      this._attach(a, h.inst);
    });
  }
  unattach(iid) {
    this.act(() => { const a = this.need(iid).inst; a.attachedTo = null; this.log(`${this.face(a).name} is unattached.`); });
  }
  attachmentsOf(iid) {
    const out = [];
    for (const p of this.players) for (const c of p.zones.battlefield) if (c.attachedTo === iid) out.push(c);
    return out;
  }

  // ------------------------------------------------------------ targets & planning

  describeTargets(targets) {
    const names = [];
    for (const ids of Object.values(targets || {})) for (const id of ids || []) {
      const r = this._resolveId(id);
      if (r) names.push(r.player ? r.player.name : this.face(r.inst).name);
    }
    return names.join(', ');
  }

  _resolveId(id) {
    const s = String(id);
    if (s[0] === 'p') { const pl = this.players[+s.slice(1)]; return pl && !pl.lost ? { player: pl } : null; }
    const L = this.locate(+s.slice(1));
    return L ? { inst: L.inst, zone: L.zone } : null;
  }

  _srcOf(item) {
    if (!item.ability) return item;
    const L = item.source != null ? this.locate(item.source) : null;
    return L && L.zone === 'battlefield' ? L.inst : null;
  }

  /** Candidate targets for a spec: [{id, label, kind, iid?, pid?}] */
  candidates(spec, ctrlPid, srcIid = null, excludeStack = null) {
    const out = [];
    const legalPerm = c => {
      if (this.kw(c, 'Shroud')) return false;
      if (c.controller !== ctrlPid && this.kw(c, 'Hexproof')) return false;
      return true;
    };
    const addPlayers = (oppOnly) => {
      for (const p of this.players) if (!p.lost && (!oppOnly || p.id !== ctrlPid)) out.push({ id: 'p' + p.id, label: p.name + (p.id === ctrlPid ? ' (you)' : ''), kind: 'player', pid: p.id });
    };
    if (spec.tgt === 'player') addPlayers(spec.opp);
    else if (spec.tgt === 'any') {
      for (const p of this.players) for (const c of p.zones.battlefield) {
        const ok = (!spec.noCreature && this.isCreature(c)) || (!spec.noPw && this.isType(c, 'Planeswalker')) || this.isType(c, 'Battle');
        if (ok && legalPerm(c) && (!spec.opp || c.controller !== ctrlPid)) out.push({ id: 'c' + c.iid, label: this.face(c).name, kind: 'card', iid: c.iid, pid: c.controller });
      }
      addPlayers(spec.opp);
    } else if (spec.tgt === 'perm') {
      for (const p of this.players) for (const c of p.zones.battlefield)
        if (this.matches(c, spec.filter, ctrlPid, srcIid) && legalPerm(c)) out.push({ id: 'c' + c.iid, label: this.face(c).name, kind: 'card', iid: c.iid, pid: c.controller });
    } else if (spec.tgt === 'stack') {
      for (const it of this.s.stack) if (it.iid !== excludeStack) out.push({ id: 's' + it.iid, label: it.ability ? it.label : this.face(it).name, kind: 'stack', iid: it.iid, pid: it.controller });
    } else if (spec.tgt === 'gy') {
      for (const p of this.players) {
        if (spec.gy === 'you' && p.id !== ctrlPid) continue;
        for (const c of p.zones.graveyard) if (FX.matchFilter(this.face(c).type_line, { ctrlIsMe: true, colors: this.face(c).colors }, spec.filter)) out.push({ id: 'g' + c.iid, label: this.face(c).name, kind: 'gy', iid: c.iid, pid: p.id });
      }
    }
    return out;
  }

  /** Every place in a step that needs targets: [{slot, spec}] */
  static targetSlots(st) {
    const out = [];
    const add = (slot, t) => { if (t && t.tgt) out.push({ slot, spec: t }); };
    add('t', st.t);
    if (st.to) st.to.forEach((t, i) => add('to' + i, t));
    if (st.who && st.who.tgt) add('who', st.who);
    add('a', st.a); add('b', st.b);
    if (st.k === 'aura') add('t', st.t);
    return out;
  }

  /**
   * What happens when `item` (a stack item, or a card about to be cast with `opts.half`/`opts.modes`) resolves.
   * Returns { name, modal, steps: [{...step, key, desc}], manual: [text], permanent, targetSlots: [{key, spec, desc}] }
   */
  planOf(item, opts = {}) {
    const f = opts.half || this.face(item);
    const name = item.ability ? (item.srcName || this.face(item).name) : f.name;
    const modes = opts.modes || (item.choices && item.choices.modes) || null;
    const plan = { name, modal: null, steps: [], manual: [], permanent: false, targetSlots: [] };
    const isPermSpell = !item.ability && /\b(Artifact|Creature|Enchantment|Planeswalker|Land|Battle|Kindred|Tribal)\b/.test(f.type_line) && !/\b(Instant|Sorcery)\b/.test(f.type_line) && !(item.castAs && item.castAs.adventure === false && /Instant|Sorcery/.test(item.castAs.type_line));
    if (isPermSpell) {
      plan.permanent = true;
      const en = this.pack(item).costs.enchant;
      if (en && en.filter && /\bAura\b/.test(f.type_line)) plan.steps.push({ k: 'aura', key: 'aura', t: { tgt: 'perm', filter: en.filter, min: 1, max: 1, desc: 'enchant ' + en.desc }, desc: 'attach to ' + en.desc });
    } else {
      const text = item.ability ? item.text : FX.spellEffectText(f, f.name);
      const parsed = FX.parseEffects(text, { name: item.ability ? name : f.name });
      plan.manual = parsed.manual;
      parsed.steps.forEach((st, i) => plan.steps.push({ ...st, key: 's' + i, desc: FX.describeStep(st) }));
      if (parsed.modal) {
        plan.modal = parsed.modal;
        for (const mi of modes || []) {
          const mp = FX.parseEffects(parsed.modal.modes[mi], { normalized: true });
          mp.steps.forEach((st, i) => plan.steps.push({ ...st, key: `m${mi}.${i}`, desc: FX.describeStep(st), mode: mi }));
          plan.manual.push(...mp.manual);
        }
      }
    }
    for (const st of plan.steps) for (const { slot, spec } of Game.targetSlots(st)) plan.targetSlots.push({ key: `${st.key}.${slot}`, spec, desc: spec.desc || st.desc, optional: !!st.optional });
    return plan;
  }

  /** Choices still needed when the top of the stack resolves (for the UI). */
  resolutionNeeds(iid) {
    const L = this.locate(iid);
    if (!L || L.zone !== 'stack') return [];
    const item = L.inst;
    const plan = this.planOf(item);
    const ctrl = item.controller;
    const needs = [];
    const chosen = (item.choices && item.choices.targets) || {};
    for (const ts of plan.targetSlots) {
      if (chosen[ts.key]) continue;
      needs.push({ key: ts.key, kind: 'target', spec: ts.spec, desc: ts.desc, candidates: this.candidates(ts.spec, ctrl, item.source, item.iid) });
    }
    for (const st of plan.steps) {
      if (st.optional) needs.push({ key: st.key, kind: 'optional', desc: st.text || st.desc });
      if (st.cond && st.cond.unknown) needs.push({ key: st.key, kind: 'condition', desc: `If ${st.cond.unknown}` });
      const pl = this.players[ctrl];
      if (st.k === 'search') needs.push({ key: st.key, kind: 'search', step: st, min: st.min, max: st.dest === 'split' ? 2 : st.max,
        candidates: pl.zones.library.filter(c => FX.matchFilter(this.face(c).type_line, { ctrlIsMe: true, colors: this.face(c).colors }, st.filter)).map(c => ({ id: 'l' + c.iid, iid: c.iid, label: this.face(c).name })) });
      if (st.k === 'fromHand') needs.push({ key: st.key, kind: 'fromHand', min: 0, max: 1,
        candidates: pl.zones.hand.filter(c => FX.matchFilter(this.face(c).type_line, { ctrlIsMe: true, colors: this.face(c).colors }, st.filter)).map(c => ({ id: 'h' + c.iid, iid: c.iid, label: this.face(c).name })) });
      if (st.k === 'discard' && st.who && st.who.players === 'you' && st.n !== 'hand' && !st.random) needs.push({ key: st.key, kind: 'discard', min: st.n, max: st.n,
        candidates: pl.zones.hand.map(c => ({ id: 'h' + c.iid, iid: c.iid, label: this.face(c).name })) });
      if (st.k === 'mana' && st.any) needs.push({ key: st.key, kind: 'color', n: st.any });
    }
    return needs;
  }

  // ------------------------------------------------------------ resolving

  /**
   * choices: { targets: {slotKey: [id]}, skip: [stepKey], picks: {stepKey: [iid]}, colors: {stepKey: [c]}, conditions: {stepKey: bool}, manual: bool }
   * manual: true just moves the card (old behaviour) and leaves the effect to the players.
   */
  resolveTop(choices = {}) {
    this.act(() => {
      const item = this.s.stack[this.s.stack.length - 1];
      if (!item) throw new Error('The stack is empty.');
      const plan = this.planOf(item);
      const f = this.face(item);
      const pl = this.players[item.controller];
      const targets = { ...((item.choices && item.choices.targets) || {}), ...(choices.targets || {}) };
      if (plan.permanent) {
        if (item.castAs && item.castAs.adventure) {
          this._move(item, 'exile', { silent: true });
          this.log(`${f.name} resolves; the card goes on an adventure (exiled — you may cast the creature later).`);
          return;
        }
        const aura = plan.steps.find(s => s.k === 'aura');
        let host = null;
        if (aura) {
          host = this._target(targets['aura.t'], aura.t, item);
          if (!host && !choices.manual) {
            this._move(item, 'graveyard', { silent: true });
            this.log(`${f.name} has no legal object to enchant and goes to the graveyard.`);
            return;
          }
        }
        this._move(item, 'battlefield', { toPlayer: pl.id, keepFace: true, silent: true });
        this.log(`${f.name} resolves and enters the battlefield under ${pl.name}'s control.`);
        if (host) this._attach(item, host.inst);
        return;
      }
      const label = item.ability ? item.label : f.name;
      if (choices.manual) {
        this._finishItem(item);
        this.log(`Resolved by hand: ${label}${item.ability ? ' — ' + item.text : ''} (carry out the effect)`);
        return;
      }
      // fizzle: every target it had is gone
      const slots = plan.targetSlots.filter(s => !s.optional && s.spec.min > 0);
      if (slots.length && slots.every(s => !(targets[s.key] || []).some(id => this._target([id], s.spec, item)))) {
        this._finishItem(item);
        this.log(`${label} doesn't resolve: its targets are no longer legal.`);
        return;
      }
      this.log(`${label} resolves${item.x ? ` (X=${item.x})` : ''}.`);
      this._runSteps(item, plan, { ...choices, targets });
      if (plan.manual.length) this.log(`⚙ Do by hand: ${plan.manual.join(' ')}`);
      this._finishItem(item);
    });
  }

  _finishItem(item) {
    if (!this.s.stack.includes(item)) return;
    if (item.ability) { this.s.stack.splice(this.s.stack.indexOf(item), 1); return; }
    if (item.flashback) { this._move(item, 'exile', { silent: true }); this.log(`${this.face(item).name} is exiled (flashback).`); return; }
    this._move(item, 'graveyard', { silent: true });
  }

  /** Resolve a chosen target id against a spec; returns {inst}|{player} or null if no longer legal. */
  _target(ids, spec, item) {
    const id = (ids || [])[0];
    if (id == null) return null;
    const r = this._resolveId(id);
    if (!r) return null;
    const ctrl = item.controller;
    if (r.player) return spec.tgt === 'player' || spec.tgt === 'any' ? r : null;
    if (spec.tgt === 'stack') return r.zone === 'stack' ? r : null;
    if (spec.tgt === 'gy') return r.zone === 'graveyard' ? r : null;
    if (r.zone !== 'battlefield') return null;
    if (this.kw(r.inst, 'Shroud') || (r.inst.controller !== ctrl && this.kw(r.inst, 'Hexproof'))) return null;
    if (spec.tgt === 'perm' && !this.matches(r.inst, spec.filter, ctrl, item.source)) return null;
    return r;
  }
  _targets(ids, spec, item) { return (ids || []).map(id => this._target([id], spec, item)).filter(Boolean); }

  /** Objects (permanents) a step's "t" refers to. */
  _objects(st, slot, spec, item, targets, ctx) {
    if (!spec) return [];
    if (spec.ref === 'self') { const s = this._srcOf(item); return s ? [s] : []; }
    if (spec.ref === 'it') return ctx.it.map(i => this.locate(i)).filter(L => L && L.zone === 'battlefield').map(L => L.inst);
    if (spec.ref === 'tokens') return ctx.tokens.filter(t => this.onBattlefield(t));
    if (spec.group === 'perm') return this.players.flatMap(p => p.zones.battlefield).filter(c => this.matches(c, spec.filter, item.controller, item.source));
    if (spec.tgt) return this._targets(targets[`${st.key}.${slot}`], spec, item).map(r => r.inst || r);
    return [];
  }

  _players(who, st, slot, item, targets, ctx) {
    const ctrl = item.controller;
    if (!who) return [this.players[ctrl]];
    if (who.players === 'you') return [this.players[ctrl]];
    if (who.players === 'opps') return this.alive().filter(p => p.id !== ctrl);
    if (who.players === 'all') return this.alive();
    if (who.players === 'ref') return ctx.refPlayer != null ? [this.players[ctx.refPlayer]] : [];
    if (who.players === 'defender') return item.ctx && item.ctx.defender != null ? [this.players[item.ctx.defender]] : [];
    if (who.tgt) return this._targets(targets[`${st.key}.${slot}`], who, item).filter(r => r.player).map(r => r.player);
    return [];
  }

  _effectDamage(src, target, n) {
    if (n <= 0) return;
    const name = src ? this.face(src).name : 'An effect';
    if (target.player) {
      const p = target.player;
      if (p.lost) return;
      if (src && this.kw(src, 'Infect')) p.poison += n; else p.life -= n;
      if (src && this.kw(src, 'Lifelink')) this.players[src.controller].life += n;
      this.log(`${name} deals ${n} damage to ${p.name}.`);
      if (src) this._events.push({ t: 'dmgPlayer', src: src.iid, pid: p.id, combat: false });
      return;
    }
    const c = target.inst || target;
    if (this.isType(c, 'Planeswalker') && !this.isCreature(c)) c.counters.loyalty = Math.max(0, (c.counters.loyalty || 0) - n);
    else if (this.isType(c, 'Battle') && !this.isCreature(c)) c.counters.defense = Math.max(0, (c.counters.defense || 0) - n);
    else if (src && (this.kw(src, 'Infect') || this.kw(src, 'Wither'))) c.counters['-1/-1'] = (c.counters['-1/-1'] || 0) + n;
    else c.damage += n;
    if (src && this.kw(src, 'Deathtouch')) c.deathtouched = true;
    if (src && this.kw(src, 'Lifelink')) this.players[src.controller].life += n;
    this.log(`${name} deals ${n} damage to ${this.face(c).name}.`);
  }

  _runSteps(item, plan, ch) {
    const ctrl = item.controller;
    const pl = this.players[ctrl];
    const src = this._srcOf(item);
    const srcAny = src || item; // the spell itself, or the ability's source (even if it left)
    const ctx = { it: item.ctx && item.ctx.it != null ? [item.ctx.it] : [], tokens: [], refPlayer: item.ctx ? item.ctx.refPlayer ?? null : null, lastRan: true };
    const T = ch.targets || {};
    for (const st of plan.steps) {
      if (st.cond) {
        if (st.cond.kicked && !item.kicked) { ctx.lastRan = false; continue; }
        if (st.cond.ifYouDo && !ctx.lastRan) continue;
        if (st.cond.control) { const ok = this._condition(st.cond.control, ctrl, src); if (ok === false) { this.log(`(${st.cond.control.replace(/^you /, 'not: you ')} — skipped)`); ctx.lastRan = false; continue; } }
        if (st.cond.unknown && ch.conditions && ch.conditions[st.key] === false) { ctx.lastRan = false; continue; }
      }
      if (st.optional && (ch.skip || []).includes(st.key)) { ctx.lastRan = false; continue; }
      const X = st.xExpr ? this.count(st.xExpr, ctrl, src || null, ctx.it[0] != null ? (this.locate(ctx.it[0]) || {}).inst : null) : (item.x || 0);
      const per = st.per ? this.count(st.per, ctrl, src || null, ctx.it[0] != null ? (this.locate(ctx.it[0]) || {}).inst : null) : 1;
      const N = (st.n === 'X' ? X : (st.n ?? 1)) * per;
      const pv = v => { const s = String(v); const sign = s[0] === '-' ? -1 : 1; const b = s.replace(/^[+-]/, ''); return sign * (b === 'X' ? X : parseInt(b, 10) || 0); };
      ctx.lastRan = true;
      switch (st.k) {
        case 'draw': for (const p of this._players(st.who, st, 'who', item, T, ctx)) { const d = this.drawN(p, N); this.log(`${p.name} draws ${plural(d, 'card')}.`); } break;
        case 'gain': for (const p of this._players(st.who, st, 'who', item, T, ctx)) { p.life += N; this.log(`${p.name} gains ${N} life → ${p.life}.`); } break;
        case 'lose': for (const p of this._players(st.who, st, 'who', item, T, ctx)) { p.life -= N; this.log(`${p.name} loses ${N} life → ${p.life}.`); } break;
        case 'damage':
          st.to.forEach((r, i) => {
            if (r.players) for (const p of this._players(r, st, 'to' + i, item, T, ctx)) this._effectDamage(src, { player: p }, N);
            else if (r.tgt === 'any' || r.tgt === 'player') for (const t of this._targets(T[`${st.key}.to${i}`], r, item)) this._effectDamage(src, t, N);
            else for (const c of this._objects(st, 'to' + i, r, item, T, ctx)) this._effectDamage(src, c, N);
          });
          break;
        case 'destroy': {
          const objs = this._objects(st, 't', st.t, item, T, ctx);
          for (const c of objs) {
            ctx.refPlayer = c.controller;
            if (this.kw(c, 'Indestructible')) { this.log(`${this.face(c).name} is indestructible.`); continue; }
            this.log(`${this.face(c).name} is destroyed.`);
            this._move(c, 'graveyard', { silent: true });
          }
          break;
        }
        case 'exile': {
          const objs = st.t.tgt === 'gy' ? this._targets(T[`${st.key}.t`], st.t, item).map(r => r.inst) : st.t.tgt === 'stack' ? this._targets(T[`${st.key}.t`], st.t, item).map(r => r.inst) : this._objects(st, 't', st.t, item, T, ctx);
          for (const c of objs) { ctx.refPlayer = c.controller; this.log(`${this.face(c).name} is exiled${st.until ? ` (until ${st.until} — return it by hand)` : ''}.`); this._move(c, 'exile', { silent: true }); }
          break;
        }
        case 'bounce': for (const c of this._objects(st, 't', st.t, item, T, ctx)) { ctx.refPlayer = c.controller; this.log(`${this.face(c).name} returns to its owner's hand.`); this._move(c, 'hand', { silent: true }); } break;
        case 'regrow': {
          const picks = this._targets(T[`${st.key}.t`], st.t, item).map(r => r.inst);
          for (const c of picks) { this.log(`${this.face(c).name} returns from the graveyard to ${st.dest === 'hand' ? 'hand' : 'the battlefield'}.`); this._move(c, st.dest === 'hand' ? 'hand' : 'battlefield', { silent: true, toPlayer: ctrl, tapped: st.tapped }); }
          break;
        }
        case 'tap': case 'untap': for (const c of this._objects(st, 't', st.t, item, T, ctx)) { c.tapped = st.k === 'tap'; this.log(`${this.face(c).name} is ${st.k}ped.`); } break;
        case 'control':
          for (const c of this._objects(st, 't', st.t, item, T, ctx)) {
            const L = this.locate(c.iid);
            const prev = c.controller;
            L.arr.splice(L.idx, 1);
            c.controller = ctrl; c.sick = true; c.attacking = null; c.blocking = null;
            if (st.eot) c.eotControl = prev;
            pl.zones.battlefield.push(c);
            this.log(`${pl.name} gains control of ${this.face(c).name}${st.eot ? ' until end of turn' : ''}.`);
          }
          break;
        case 'counters': {
          const objs = this._objects(st, 't', st.t, item, T, ctx);
          for (const c of objs) { c.counters[st.ctype] = (c.counters[st.ctype] || 0) + N; this.log(`${this.face(c).name} gets ${N} ${st.ctype} counter${N === 1 ? '' : 's'}.`); }
          break;
        }
        case 'pump': {
          const objs = this._objects(st, 't', st.t, item, T, ctx);
          const dp = pv(st.dp), dt = pv(st.dt);
          for (const c of objs) { c.eot.p += dp; c.eot.t += dt; c.eot.kw.push(...st.kws); }
          if (objs.length) this.log(`${objs.length > 3 ? plural(objs.length, 'permanent') : objs.map(c => this.face(c).name).join(', ')} ${dp || dt ? `get${objs.length === 1 ? 's' : ''} ${dp >= 0 ? '+' : ''}${dp}/${dt >= 0 ? '+' : ''}${dt}` : ''}${st.kws.length ? `${dp || dt ? ' and' : ''} gain${objs.length === 1 ? 's' : ''} ${st.kws.join(', ')}` : ''} until end of turn${st.note ? ` (${st.note})` : ''}.`);
          break;
        }
        case 'token': {
          let n = st.count === 'X' ? X : st.count === 'EXPR' ? this.count(st.countExpr, ctrl, src || null) : st.count;
          if (st.count !== 'EXPR' && st.countExpr) n *= this.count(st.countExpr, ctrl, src || null);
          this.db[st.key] = st.token;
          const who = st.who && st.who.players === 'ref' ? (ctx.refPlayer != null ? [this.players[ctx.refPlayer]] : []) : this._players(st.who, st, 'who', item, T, ctx);
          ctx.tokens = [];
          for (const p of who) {
            for (let i = 0; i < n; i++) {
              const t = this.newInst(st.key, p.id);
              t.token = true;
              this._enterBf(t, p.id, st.tapped);
              ctx.tokens.push(t);
            }
            this.log(`${p.name} creates ${n} ${st.token.name}${st.token.power != null ? ` ${st.token.power}/${st.token.toughness}` : ''} token${n === 1 ? '' : 's'}${st.kws.length ? ` with ${st.kws.join(', ')}` : ''}${st.note ? ` (${st.note})` : ''}.`);
          }
          break;
        }
        case 'mill': for (const p of this._players(st.who, st, 'who', item, T, ctx)) this._mill(p, N); break;
        case 'look': this.log(`${pl.name} ${st.mode === 'look' ? 'looks at' : st.mode + 's'} the top ${N} card${N === 1 ? '' : 's'} of their library.`); break;
        case 'shuffle': shuffle(pl.zones.library); this.log(`${pl.name} shuffles their library.`); break;
        case 'search': {
          const lib = pl.zones.library;
          const ok = c => FX.matchFilter(this.face(c).type_line, { ctrlIsMe: true, colors: this.face(c).colors }, st.filter);
          const max = st.dest === 'split' ? 2 : st.max;
          let picks = ((ch.picks || {})[st.key] || []).map(Number).map(id => lib.find(c => c.iid === id)).filter(c => c && ok(c)).slice(0, max);
          if (!(ch.picks || {})[st.key]) picks = lib.filter(ok).slice(-max); // no choice given: take matching cards from the top
          if (!picks.length) { this.log(`${pl.name} searches their library and finds nothing.`); shuffle(lib); break; }
          if (st.dest === 'split') {
            const [first, ...rest] = picks;
            this._move(first, 'battlefield', { toPlayer: ctrl, tapped: true, silent: true });
            for (const c of rest) this._move(c, 'hand', { silent: true });
            this.log(`${pl.name} searches and puts ${this.face(first).name} onto the battlefield tapped${rest.length ? ` and ${rest.map(c => this.face(c).name).join(', ')} into their hand` : ''}.`);
          } else {
            for (const c of picks) {
              if (st.dest === 'battlefield') this._move(c, 'battlefield', { toPlayer: ctrl, tapped: st.tapped, silent: true });
              else if (st.dest === 'hand') this._move(c, 'hand', { silent: true });
              else if (st.dest === 'graveyard') this._move(c, 'graveyard', { silent: true });
            }
            if (st.dest !== 'top') this.log(`${pl.name} searches and puts ${picks.map(c => this.face(c).name).join(', ')} ${st.dest === 'battlefield' ? `onto the battlefield${st.tapped ? ' tapped' : ''}` : st.dest === 'hand' ? 'into their hand' : 'into their graveyard'}.`);
          }
          shuffle(lib);
          if (st.dest === 'top') {
            for (const c of picks) { lib.splice(lib.indexOf(c), 1); lib.push(c); }
            this.log(`${pl.name} searches, shuffles, and puts a card on top of their library.`);
          }
          break;
        }
        case 'fromHand': {
          const id = ((ch.picks || {})[st.key] || [])[0];
          const c = id != null ? pl.zones.hand.find(h => h.iid === +id) : null;
          if (c && FX.matchFilter(this.face(c).type_line, { ctrlIsMe: true, colors: this.face(c).colors }, st.filter)) {
            this._move(c, 'battlefield', { toPlayer: ctrl, tapped: st.tapped, silent: true });
            this.log(`${pl.name} puts ${this.face(c).name} from their hand onto the battlefield.`);
          } else ctx.lastRan = false;
          break;
        }
        case 'counter':
          for (const r of this._targets(T[`${st.key}.t`], st.t, item)) {
            const it = r.inst;
            this.log(`${it.ability ? it.label : this.face(it).name} is countered${st.unless ? ` (unless ${st.unless} — handle by hand)` : ''}.`);
            if (it.ability) this.s.stack.splice(this.s.stack.indexOf(it), 1);
            else this._move(it, it.flashback ? 'exile' : 'graveyard', { silent: true });
          }
          break;
        case 'mana': {
          const add = { ...st.add };
          const cols = ((ch.colors || {})[st.key]) || [];
          for (let i = 0; i < st.any; i++) { const c = cols[i] || cols[0] || 'C'; add[c] = (add[c] || 0) + 1; }
          for (const k in add) pl.pool[k] = (pl.pool[k] || 0) + add[k];
          this.log(`${pl.name} adds ${Object.entries(add).map(([k, v]) => `{${k}}`.repeat(v)).join('')}.`);
          break;
        }
        case 'sacSelf': {
          const c = st.ref === 'it' && ctx.it.length ? (this.locate(ctx.it[0]) || {}).inst : src;
          if (c && this.onBattlefield(c)) { this.log(`${this.face(c).name} is sacrificed.`); this._move(c, 'graveyard', { silent: true }); }
          break;
        }
        case 'discard': {
          for (const p of this._players(st.who, st, 'who', item, T, ctx)) {
            let cards;
            if (st.n === 'hand') cards = [...p.zones.hand];
            else if (st.random) cards = shuffle([...p.zones.hand]).slice(0, N);
            else if (p.id === ctrl) cards = ((ch.picks || {})[st.key] || []).map(Number).map(id => p.zones.hand.find(h => h.iid === id)).filter(Boolean).slice(0, N);
            else { this.log(`⚙ ${p.name} discards ${plural(N, 'card')} of their choice (do it by hand).`); continue; }
            for (const c of cards) this._move(c, 'graveyard', { silent: true });
            this.log(`${p.name} discards ${cards.map(c => this.face(c).name).join(', ') || 'nothing'}.`);
          }
          break;
        }
        case 'reveal': {
          const lib = pl.zones.library;
          const top = lib.slice(-N).reverse();
          const take = top.filter(c => FX.matchFilter(this.face(c).type_line, { ctrlIsMe: true, colors: this.face(c).colors }, st.take));
          const rest = top.filter(c => !take.includes(c));
          for (const c of take) this._move(c, 'hand', { silent: true });
          for (const c of rest) this._move(c, 'library', { pos: 'bottom', silent: true });
          this.log(`${pl.name} reveals ${top.map(c => this.face(c).name).join(', ') || 'nothing'}; puts ${take.map(c => this.face(c).name).join(', ') || 'nothing'} into their hand and the rest on the bottom.`);
          break;
        }
        case 'fight': {
          const a = this._objects(st, 'a', st.a, item, T, ctx)[0], b = this._objects(st, 'b', st.b, item, T, ctx)[0];
          if (a && b) { const pa = this.pt(a).p, pb = this.pt(b).p; this._effectDamage(a, b, pa); this._effectDamage(b, a, pb); this.log(`${this.face(a).name} fights ${this.face(b).name}.`); }
          break;
        }
        case 'attach': {
          const att = src || null;
          const host = this._objects(st, 't', st.t, item, T, ctx)[0];
          if (att && host && this.isCreature(host)) this._attach(att, host);
          break;
        }
        default: break;
      }
    }
  }

  counterSpell(iid) {
    this.act(() => {
      const L = this.need(iid);
      if (L.zone !== 'stack') throw new Error('Not on the stack.');
      const name = L.inst.ability ? L.inst.label : this.face(L.inst).name;
      if (L.inst.ability) this.s.stack.splice(L.idx, 1);
      else this._move(L.inst, L.inst.flashback ? 'exile' : 'graveyard', { silent: true });
      this.log(`${name} is countered.`);
    });
  }

  // ------------------------------------------------------------ triggered abilities

  _pushTrigger(src, trig, ctx, snap = null) {
    const ctrl = snap ? snap.controller : src.controller;
    const key = snap ? snap.key : src.key;
    const face = snap ? snap.face : src.face;
    const name = this.face({ key, face, castAs: null }).name;
    const iid = snap ? snap.iid : src.iid;
    if (trig.once) {
      const holder = src || null;
      if (holder) {
        holder.trigTurns = holder.trigTurns || {};
        if (holder.trigTurns[trig.line] === this.s.turn) return;
        holder.trigTurns[trig.line] = this.s.turn;
      }
    }
    // intervening "if" (rule 603.4): check when it triggers
    const parsed = FX.parseEffects(trig.effect, { normalized: true });
    const first = parsed.steps[0];
    if (first && first.cond && first.cond.control && this._condition(first.cond.control, ctrl, src) === false) return;
    if (!parsed.steps.length && !parsed.manual.length && !parsed.modal) return;
    this._newTriggers.push({
      iid: this.s.nextId++, ability: true, trigger: true, key, face, source: iid, controller: ctrl, owner: ctrl,
      label: `${name} — trigger`, text: trig.effect, srcName: name, x: 0, counters: {}, eot: blankEot(), mod: { p: 0, t: 0 }, castAs: null,
      choices: { modes: null, targets: {} }, ctx: ctx || {},
    });
  }

  _flushTriggers() {
    const events = this._events;
    this._events = [];
    if (!events.length || !this.opt('autoTriggers') || this.s.stage !== 'play') return 0;
    this._newTriggers = [];
    const bf = () => this.players.flatMap(p => p.zones.battlefield);
    for (const ev of events) {
      if (ev.t === 'enter') {
        const L = this.locate(ev.iid);
        const entered = L && L.inst;
        if (!entered) continue;
        if (L.zone === 'battlefield') for (const tr of this.pack(entered).triggers) if (tr.ev === 'etb') this._pushTrigger(entered, tr, { it: entered.iid });
        for (const c of bf()) for (const tr of this.pack(c).triggers) {
          if (tr.ev !== 'enters') continue;
          if (tr.filter.other && c.iid === entered.iid) continue;
          if (!this.matches(entered, tr.filter, c.controller, c.iid)) continue;
          if (tr.oneOrMore) { const k = `${c.iid}:${tr.line}`; this._oneOrMore = this._oneOrMore || new Set(); if (this._oneOrMore.has(k)) continue; this._oneOrMore.add(k); }
          this._pushTrigger(c, tr, { it: entered.iid, refPlayer: entered.controller });
        }
      } else if (ev.t === 'die') {
        const snap = ev.snap;
        const ghost = { key: snap.key, face: snap.face, castAs: null };
        for (const tr of this.pack(ghost).triggers) if (tr.ev === 'dies' || (tr.ev === 'etb' && tr.also === 'dies')) this._pushTrigger(null, tr, { it: snap.iid }, snap);
        for (const aid of snap.attached) {
          const L = this.locate(aid);
          if (L && L.zone === 'battlefield') for (const tr of this.pack(L.inst).triggers) if (tr.ev === 'hostDies') this._pushTrigger(L.inst, tr, {});
        }
        for (const c of bf()) for (const tr of this.pack(c).triggers) {
          if (tr.ev !== 'otherDies') continue;
          if (tr.filter.other && c.iid === snap.iid) continue;
          const ok = FX.matchFilter(this.face(ghost).type_line, { ctrlIsMe: snap.controller === c.controller, isSelf: false, token: snap.token, colors: this.face(ghost).colors }, tr.filter);
          if (ok) this._pushTrigger(c, tr, { refPlayer: snap.controller });
        }
      } else if (ev.t === 'attack') {
        const L = this.locate(ev.iid);
        if (!L) continue;
        const a = L.inst;
        for (const tr of this.pack(a).triggers) if (tr.ev === 'attacks' || (tr.ev === 'etb' && tr.also === 'attacks')) this._pushTrigger(a, tr, { it: a.iid, defender: ev.defender });
        for (const c of bf()) for (const tr of this.pack(c).triggers) {
          if (tr.ev === 'attacksAny' && !(tr.filter.other && c.iid === a.iid) && this.matches(a, tr.filter, c.controller, c.iid)) this._pushTrigger(c, tr, { it: a.iid, defender: ev.defender });
          if (tr.ev === 'attackOnce' && c.controller === a.controller) {
            const k = `${this.s.turn}`;
            c.attackOnce = c.attackOnce || {};
            if (c.attackOnce[tr.line] === k) continue;
            c.attackOnce[tr.line] = k;
            this._pushTrigger(c, tr, { defender: ev.defender });
          }
        }
      } else if (ev.t === 'cast') {
        for (const c of this.players[ev.pid].zones.battlefield) for (const tr of this.pack(c).triggers) {
          if (tr.ev !== 'cast') continue;
          if (tr.first && this.players[ev.pid].spellsCast !== 1) continue;
          const ok = tr.filter.any || FX.matchFilter(ev.typeLine, { ctrlIsMe: true, colors: ev.colors }, tr.filter);
          if (ok) this._pushTrigger(c, tr, { it: ev.iid });
        }
      } else if (ev.t === 'step') {
        for (const c of bf()) for (const tr of this.pack(c).triggers) {
          if (tr.ev !== 'step' || tr.step !== ev.step) continue;
          if (tr.whose === 'you' && c.controller !== this.s.active) continue;
          if (tr.whose === 'opp' && c.controller === this.s.active) continue;
          this._pushTrigger(c, tr, { refPlayer: this.s.active });
        }
      } else if (ev.t === 'dmgPlayer') {
        const L = this.locate(ev.src);
        if (!L || L.zone !== 'battlefield') continue;
        for (const tr of this.pack(L.inst).triggers) if (tr.ev === 'dmgPlayer' && (!tr.combat || ev.combat)) this._pushTrigger(L.inst, tr, { refPlayer: ev.pid, defender: ev.pid });
      }
    }
    this._oneOrMore = null;
    // APNAP: the active player's triggers go on the stack first (so they resolve last)
    const n = this.players.length;
    const order = p => (p - this.s.active + n) % n;
    const fresh = this._newTriggers.sort((a, b) => order(a.controller) - order(b.controller));
    this._newTriggers = [];
    for (const t of fresh) {
      this.s.stack.push(t);
      this.log(`⚡ ${t.srcName} triggers: ${t.text}`);
    }
    return fresh.length;
  }

  // ------------------------------------------------------------ misc permanent actions

  toggleTap(iid) {
    this.act(() => { const { inst } = this.need(iid); inst.tapped = !inst.tapped; this.log(`${this.face(inst).name} ${inst.tapped ? 'tapped' : 'untapped'}.`); });
  }
  untapAll(pid) {
    this.act(() => { for (const c of this.players[pid].zones.battlefield) c.tapped = false; this.log(`${this.players[pid].name} untaps all permanents.`); });
  }
  addCounter(iid, type, n) {
    this.act(() => {
      const { inst } = this.need(iid);
      const v = (inst.counters[type] || 0) + n;
      if (v <= 0 && type !== 'loyalty' && type !== 'defense') delete inst.counters[type];
      else inst.counters[type] = Math.max(0, v);
      this.log(`${this.face(inst).name}: ${n > 0 ? '+' : ''}${n} ${type} counter${Math.abs(n) === 1 ? '' : 's'}.`);
    });
  }
  setDamage(iid, n) {
    this.act(() => { const { inst } = this.need(iid); inst.damage = Math.max(0, n); this.log(`${this.face(inst).name} has ${inst.damage} damage marked.`); });
  }
  modifyPT(iid, p, t, untilEot = true) {
    this.act(() => {
      const { inst } = this.need(iid);
      const tgt = untilEot ? inst.eot : inst.mod;
      tgt.p += p; tgt.t += t;
      this.log(`${this.face(inst).name} gets ${p >= 0 ? '+' : ''}${p}/${t >= 0 ? '+' : ''}${t}${untilEot ? ' until end of turn' : ''}.`);
    });
  }
  grantKeyword(iid, kw) {
    this.act(() => { const { inst } = this.need(iid); inst.eot.kw.push(kw); this.log(`${this.face(inst).name} gains ${kw} until end of turn.`); });
  }
  transform(iid) {
    this.act(() => {
      const { inst } = this.need(iid);
      const d = this.db[inst.key];
      if (!d.faces || d.faces.length < 2) throw new Error('This card has only one face.');
      inst.face = (inst.face + 1) % d.faces.length;
      this.log(`${d.name} turned to ${d.faces[inst.face].name}.`);
    });
  }
  setNote(iid, note) { this.act(() => { this.need(iid).inst.note = note; }); }
  changeControl(iid, pid) {
    this.act(() => {
      const L = this.need(iid);
      if (L.zone !== 'battlefield') throw new Error('Only permanents can change control.');
      L.arr.splice(L.idx, 1);
      L.inst.controller = pid;
      L.inst.sick = true;
      L.inst.attacking = null; L.inst.blocking = null;
      this.players[pid].zones.battlefield.push(L.inst);
      this.log(`${this.players[pid].name} gains control of ${this.face(L.inst).name}.`);
    });
  }
  createToken(pid, key, n = 1, tapped = false, data = null) {
    this.act(() => {
      if (data) this.db[key] = data;
      if (!this.db[key]) throw new Error('Unknown token.');
      for (let i = 0; i < n; i++) {
        const t = this.newInst(key, pid);
        t.token = true;
        this._enterBf(t, pid, tapped);
      }
      this.log(`${this.players[pid].name} creates ${n} ${this.db[key].name} token${n > 1 ? 's' : ''}.`);
    });
  }
  copyAsToken(iid) {
    this.act(() => {
      const { inst } = this.need(iid);
      const t = this.newInst(inst.key, inst.controller);
      t.token = true; t.face = inst.face;
      this._enterBf(t, inst.controller);
      this.log(`${this.players[inst.controller].name} creates a token copy of ${this.face(inst).name}.`);
    });
  }
  addCardToZone(pid, key, zone, data = null) {
    this.act(() => {
      if (data) this.db[key] = data;
      if (!this.db[key]) throw new Error('Unknown card.');
      const c = this.newInst(key, pid);
      if (zone === 'battlefield') this._enterBf(c, pid);
      else this.players[pid].zones[zone].push(c);
      this.log(`${this.players[pid].name} puts ${this.db[key].name} into ${zone} (added card).`);
    });
  }

  life(pid, delta) {
    this.act(() => { const p = this.players[pid]; p.life += delta; this.log(`${p.name}: ${delta > 0 ? '+' : ''}${delta} life → ${p.life}.`); });
  }
  setLife(pid, v) { this.act(() => { const p = this.players[pid]; p.life = v; this.log(`${p.name}'s life set to ${v}.`); }); }
  poison(pid, delta) {
    this.act(() => { const p = this.players[pid]; p.poison = Math.max(0, p.poison + delta); this.log(`${p.name} has ${p.poison} poison counters.`); });
  }
  commanderDamage(pid, srcIid, delta, alsoLife = true) {
    this.act(() => {
      const p = this.players[pid];
      p.cmdrDmg[srcIid] = Math.max(0, (p.cmdrDmg[srcIid] || 0) + delta);
      if (alsoLife) p.life -= delta;
      this.log(`${p.name}: ${delta > 0 ? '+' : ''}${delta} commander damage from ${this.s.cmdrNames[srcIid]} (total ${p.cmdrDmg[srcIid]}).`);
    });
  }
  concede(pid) { this.act(() => this._lose(this.players[pid], 'conceded')); }
  setSetting(k, v) { this.act(() => { this.s.settings[k] = v; }); }

  // ------------------------------------------------------------ combat

  declareAttack(iid, defender, { force = false } = {}) {
    this.act(() => {
      const { inst, zone } = this.need(iid);
      const name = this.face(inst).name;
      if (inst.attacking != null) { // toggle off
        inst.attacking = null;
        if (inst.tappedByAttack) inst.tapped = false;
        inst.tappedByAttack = false;
        this.log(`${name} removed from attack.`);
        return;
      }
      if (zone !== 'battlefield' || !this.isCreature(inst)) throw new Error('Only creatures on the battlefield can attack.');
      if (!force) {
        if (PHASES[this.s.phase] !== 'Declare Attackers') throw new RuleError('Attackers are declared during the Declare Attackers step.');
        if (inst.controller !== this.s.active) throw new RuleError('Only the active player attacks.');
        if (inst.tapped) throw new RuleError(`${name} is tapped.`);
        if (inst.sick && !this.kw(inst, 'Haste')) throw new RuleError(`${name} has summoning sickness (no haste).`);
        if (this.kw(inst, 'Defender')) throw new RuleError(`${name} has defender.`);
        if (defender === inst.controller || this.players[defender].lost) throw new RuleError('Invalid player to attack.');
      }
      inst.attacking = defender;
      if (!this.kw(inst, 'Vigilance') && !inst.tapped) { inst.tapped = true; inst.tappedByAttack = true; }
      this.log(`${name} attacks ${this.players[defender].name}.`);
      this._events.push({ t: 'attack', iid: inst.iid, defender });
    });
  }

  declareBlock(iid, attackerIid, { force = false } = {}) {
    this.act(() => {
      const { inst } = this.need(iid);
      const name = this.face(inst).name;
      if (inst.blocking != null && (attackerIid == null || inst.blocking === attackerIid)) {
        inst.blocking = null; this.log(`${name} no longer blocks.`); return;
      }
      const atk = this.need(attackerIid).inst;
      if (!force) {
        if (PHASES[this.s.phase] !== 'Declare Blockers') throw new RuleError('Blockers are declared during the Declare Blockers step.');
        if (!this.isCreature(inst)) throw new RuleError('Only creatures can block.');
        if (inst.tapped) throw new RuleError(`${name} is tapped and can't block.`);
        if (this.kw(inst, "Can't block")) throw new RuleError(`${name} can't block.`);
        if (atk.attacking !== inst.controller) throw new RuleError('That creature is not attacking you.');
        if (this.kw(atk, 'Flying') && !this.kw(inst, 'Flying') && !this.kw(inst, 'Reach')) throw new RuleError(`${this.face(atk).name} has flying; blockers need flying or reach.`);
        for (const [walk, land] of [['Forestwalk', 'Forest'], ['Islandwalk', 'Island'], ['Swampwalk', 'Swamp'], ['Mountainwalk', 'Mountain'], ['Plainswalk', 'Plains']])
          if (this.kw(atk, walk) && this.players[inst.controller].zones.battlefield.some(c => this.isType(c, land)))
            throw new RuleError(`${this.face(atk).name} has ${walk.toLowerCase()} and you control a ${land}, so it can't be blocked.`);
        if (/can't be blocked(?! by| except)/i.test(this.face(atk).oracle_text || '')) {
          if (/^This creature can't be blocked\.?$|^[^\n]*can't be blocked\.$/m.test(this.face(atk).oracle_text) && !/Equipped|Enchanted|creatures you control/i.test(this.face(atk).oracle_text))
            throw new RuleError(`${this.face(atk).name} can't be blocked.`);
        }
      }
      inst.blocking = atk.iid;
      this.log(`${name} blocks ${this.face(atk).name}.`);
      const blockers = this.players.flatMap(p => p.zones.battlefield).filter(b => b.blocking === atk.iid);
      if (this.kw(atk, 'Menace') && blockers.length === 1) this.log(`⚠ ${this.face(atk).name} has menace — it needs two or more blockers.`);
    });
  }

  _damageCreature(src, tgt, n) {
    if (n <= 0) return;
    if (this.kw(src, 'Infect') || this.kw(src, 'Wither')) tgt.counters['-1/-1'] = (tgt.counters['-1/-1'] || 0) + n;
    else tgt.damage += n;
    if (this.kw(src, 'Deathtouch')) tgt.deathtouched = true;
    if (this.kw(src, 'Lifelink')) this.players[src.controller].life += n;
  }

  _damagePlayer(src, pl, n) {
    if (n <= 0 || pl.lost) return;
    if (this.kw(src, 'Infect')) pl.poison += n; else pl.life -= n;
    if (src.isCommander) pl.cmdrDmg[src.iid] = (pl.cmdrDmg[src.iid] || 0) + n;
    const tox = String(this.face(src).oracle_text || '').match(/^Toxic (\d+)/m);
    if (tox) pl.poison += parseInt(tox[1], 10);
    if (this.kw(src, 'Lifelink')) this.players[src.controller].life += n;
    this.log(`${this.face(src).name} deals ${n} combat damage to ${pl.name}${src.isCommander ? ` (commander damage: ${pl.cmdrDmg[src.iid]})` : ''}.`);
    this._events.push({ t: 'dmgPlayer', src: src.iid, pid: pl.id, combat: true });
  }

  combatDamage() {
    const bf = () => this.players.flatMap(p => p.zones.battlefield);
    const onBf = c => { const L = this.locate(c.iid); return L && L.zone === 'battlefield'; };
    const attackers = bf().filter(c => c.attacking != null);
    if (!attackers.length) { this.log('No combat damage (no attackers).'); return; }
    const blockersOf = a => bf().filter(b => b.blocking === a.iid);
    for (const a of attackers) a.wasBlocked = blockersOf(a).length > 0;
    const fs = c => this.kw(c, 'First strike') || this.kw(c, 'Double strike');
    const ds = c => this.kw(c, 'Double strike');
    const combatants = [...attackers, ...bf().filter(b => b.blocking != null)];
    const passes = combatants.some(fs) ? ['first', 'regular'] : ['regular'];
    for (const pass of passes) {
      const deals = c => (pass === 'first' ? fs(c) : (!fs(c) || ds(c)));
      const events = [];
      for (const a of attackers) {
        if (!onBf(a)) continue;
        const blockers = blockersOf(a).filter(onBf);
        if (deals(a)) {
          let dmg = this.pt(a).p;
          if (dmg > 0) {
            const trample = this.kw(a, 'Trample');
            if (!a.wasBlocked) events.push({ src: a, player: a.attacking, n: dmg });
            else if (blockers.length) {
              const dt = this.kw(a, 'Deathtouch');
              blockers.forEach((b, i) => {
                const last = i === blockers.length - 1;
                const lethal = dt ? 1 : Math.max(0, this.pt(b).t - b.damage);
                const give = last && !trample ? dmg : Math.min(dmg, lethal);
                dmg -= give;
                if (give > 0) events.push({ src: a, target: b, n: give });
              });
              if (trample && dmg > 0) events.push({ src: a, player: a.attacking, n: dmg });
            } else if (trample) events.push({ src: a, player: a.attacking, n: dmg });
          }
        }
        for (const b of blockers) if (deals(b)) { const n = this.pt(b).p; if (n > 0) events.push({ src: b, target: a, n }); }
      }
      for (const e of events) {
        if (e.target) {
          this._damageCreature(e.src, e.target, e.n);
          this.log(`${this.face(e.src).name} deals ${e.n} damage to ${this.face(e.target).name}.`);
        } else this._damagePlayer(e.src, this.players[e.player], e.n);
      }
      this.sba();
    }
  }

  // ------------------------------------------------------------ state-based actions

  _lose(pl, why) {
    if (pl.lost) return;
    pl.lost = true;
    this.log(`☠ ${pl.name} loses the game (${why}).`);
    // 800.4a: a player who leaves takes everything they own with them; borrowed permanents go back.
    const borrowed = pl.zones.battlefield.filter(c => c.owner !== pl.id && !c.token);
    for (const p of this.players) p.zones.battlefield = p.zones.battlefield.filter(c => c.owner !== pl.id);
    pl.zones.battlefield = [];
    for (const c of borrowed) { c.controller = c.owner; c.attacking = null; c.blocking = null; this.players[c.owner].zones.battlefield.push(c); }
    this.s.stack = this.s.stack.filter(c => c.owner !== pl.id);
    if (this.s.pending && this.s.pending.pid === pl.id) this.s.pending = null;
    const alive = this.alive();
    if (alive.length === 1 && this.players.length > 1) {
      this.s.winner = alive[0].id;
      this.s.score = this.s.score || {};
      this.s.score[alive[0].id] = (this.s.score[alive[0].id] || 0) + 1;
      this.log(`🏆 ${alive[0].name} wins the game! Score: ${this.scoreLine()}.`);
    } else if (this.s.active === pl.id && alive.length) {
      this._cleanup();
      this._beginTurn(this._nextAlive(pl.id));
    }
  }

  sba() {
    if (this.s.stage !== 'play') return;
    for (let guard = 0; guard < 40; guard++) {
      let changed = false;
      for (const pl of this.players) {
        if (pl.lost) continue;
        let why = null;
        if (pl.life <= 0) why = 'life total 0 or less';
        else if (pl.poison >= 10) why = '10 or more poison counters';
        else if (pl.drewEmpty) why = 'drew from an empty library';
        else for (const [src, d] of Object.entries(pl.cmdrDmg)) if (d >= 21) why = `21+ combat damage from ${this.s.cmdrNames[src]}`;
        if (why && this.players.length > 1) { this._lose(pl, why); changed = true; }
      }
      for (const pl of this.players) {
        for (const c of [...pl.zones.battlefield]) {
          const cn = c.counters;
          if (cn['+1/+1'] && cn['-1/-1']) {
            const m = Math.min(cn['+1/+1'], cn['-1/-1']);
            cn['+1/+1'] -= m; cn['-1/-1'] -= m;
            if (!cn['+1/+1']) delete cn['+1/+1'];
            if (!cn['-1/-1']) delete cn['-1/-1'];
            changed = true;
          }
          const name = this.face(c).name;
          // attachments whose host left
          if (c.attachedTo != null) {
            const H = this.locate(c.attachedTo);
            if (!H || H.zone !== 'battlefield') {
              if (this.isType(c, 'Aura')) { this._move(c, 'graveyard', { silent: true }); this.log(`${name} goes to the graveyard (what it enchanted is gone).`); changed = true; continue; }
              c.attachedTo = null; changed = true;
            } else if (this.isType(c, 'Equipment') && !this.isCreature(H.inst)) { c.attachedTo = null; changed = true; }
          }
          if (this.isCreature(c)) {
            const { t } = this.pt(c);
            if (t <= 0) { this._move(c, 'graveyard', { silent: true }); this.log(`${name} dies (toughness 0 or less).`); changed = true; continue; }
            if (!this.kw(c, 'Indestructible') && (c.damage >= t || (c.deathtouched && c.damage > 0))) {
              this._move(c, 'graveyard', { silent: true });
              this.log(`${name} is destroyed (${c.deathtouched ? 'deathtouch' : 'lethal damage'}).${c.isCommander && this.s.settings.cmdrToCommandZone ? ' Commander → command zone.' : ''}`);
              changed = true; continue;
            }
          }
          if (this.isType(c, 'Planeswalker') && cn.loyalty !== undefined && cn.loyalty <= 0) {
            this._move(c, 'graveyard', { silent: true }); this.log(`${name} is put into the graveyard (0 loyalty).`); changed = true; continue;
          }
          if (this.isType(c, 'Battle') && cn.defense !== undefined && cn.defense <= 0) {
            this._move(c, 'graveyard', { silent: true }); this.log(`${name} is defeated (0 defense).`); changed = true; continue;
          }
        }
        // Legend rule (704.5j): keep the newest automatically; undo to choose differently.
        const legends = {};
        for (const c of pl.zones.battlefield) {
          if (!this.isType(c, 'Legendary')) continue;
          const n = this.face(c).name;
          (legends[n] = legends[n] || []).push(c);
        }
        for (const [n, list] of Object.entries(legends)) {
          if (list.length < 2) continue;
          list.sort((a, b) => a.iid - b.iid);
          for (const c of list.slice(0, -1)) this._move(c, 'graveyard', { silent: true });
          this.log(`Legend rule: kept the newest ${n}; the other went to the graveyard (undo to choose differently).`);
          changed = true;
        }
      }
      if (!changed) break;
    }
  }
}
