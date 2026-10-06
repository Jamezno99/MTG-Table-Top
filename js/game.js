// game.js — the game engine: zones, turn structure, stack, mana, combat,
// state-based actions and Commander rules. No DOM; driven by main.js.

import { parseCost, payCost, colorNeeds, manaOptions, hasKeyword, FORMATS, RuleError } from './rules.js';
export { RuleError };

export const PHASES = ['Untap', 'Upkeep', 'Draw', 'Main 1', 'Beginning of Combat', 'Declare Attackers',
  'Declare Blockers', 'Combat Damage', 'End of Combat', 'Main 2', 'End', 'Cleanup'];
export const ZONES = ['library', 'hand', 'battlefield', 'graveyard', 'exile', 'command'];
const SAVE_KEY = 'mtgsim-save-v1';

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

export class Game {
  constructor(db = {}, s = null) {
    this.db = db;         // key -> slim card data (cards + tokens)
    this.s = s;           // serialisable game state
    this.undoStack = [];
    this.onChange = () => {};
  }

  // ------------------------------------------------------------ setup

  /** players: [{ name, main: [{key, qty}], commanders: [key] }] */
  static create({ format, players, db }) {
    const g = new Game(db);
    const f = FORMATS[format] || FORMATS.freeform;
    g.s = {
      format, turn: 0, active: 0, phase: 0, stage: 'mulligan', stack: [], log: [], nextId: 1,
      winner: null, firstPlayer: 0, cmdrNames: {}, settings: { cmdrToCommandZone: true },
      players: players.map((p, i) => ({
        id: i, name: p.name, life: f.life, poison: 0, cmdrDmg: {}, pool: emptyPool(), landsPlayed: 0,
        cmdrCasts: {}, lost: false, drewEmpty: false, mulligans: 0, kept: false, toBottom: 0,
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
    g.s.firstPlayer = rnd(players.length);
    g.s.active = g.s.firstPlayer;
    g.log(`Format: ${f.name}. Starting life ${f.life}.`);
    g.log(`${g.s.players[g.s.firstPlayer].name} was chosen at random to go first.`);
    g.log(`Mulligans: London mulligan${g.freeMulligan() ? ', first mulligan is free' : ''}.`);
    g.save();
    return g;
  }

  static load() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      const { db, s } = JSON.parse(raw);
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

  isType(inst, t) { return new RegExp('\\b' + t + '\\b').test(this.face(inst).type_line || ''); }
  isCreature(inst) { return this.isType(inst, 'Creature'); }

  kw(inst, k) {
    if ((inst.eot && inst.eot.kw || []).some(x => x.toLowerCase() === k.toLowerCase())) return true;
    return hasKeyword(this.face(inst).oracle_text, k);
  }

  pt(inst) {
    const f = this.face(inst);
    const n = v => { const x = parseInt(v, 10); return isNaN(x) ? 0 : x; };
    const c = inst.counters || {};
    const plus = (c['+1/+1'] || 0) - (c['-1/-1'] || 0);
    return {
      p: n(f.power) + plus + inst.mod.p + inst.eot.p,
      t: n(f.toughness) + plus + inst.mod.t + inst.eot.t,
    };
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

  abilities(inst) {
    const f = this.face(inst);
    const out = [];
    String(f.oracle_text || '').split('\n').forEach((line, i) => {
      const clean = line.replace(/\([^)]*\)/g, '').trim();
      const kwm = clean.match(/^(Equip|Cycling|Ninjutsu|Unearth|Embalm|Eternalize|Reconfigure|Outlast|Level up|Scavenge|Fortify|Transmute|Forecast)\b[^{:]*((?:\{[^}]+\})+)\s*$/);
      if (kwm) { out.push({ i, kind: 'activated', cost: kwm[2], text: `${kwm[1]} ability` }); return; }
      const m = clean.match(/^([^:"]+?):\s*(.+)$/);
      if (!m) return;
      const cost = m[1].trim();
      if (/^\{T\}: Add /.test(clean)) return; // mana ability: use "Tap for mana"
      const loyal = cost.match(/^([+−-]?)(\d+|X)$/);
      if (loyal) {
        const sign = loyal[1] === '+' ? 1 : loyal[1] ? -1 : 0;
        out.push({ i, kind: 'loyalty', cost, text: m[2], sign, amount: loyal[2] === 'X' ? null : parseInt(loyal[2], 10) });
        return;
      }
      if (!/\{[^}]+\}|Sacrifice|Discard|Pay |Exile|Tap |Remove|Return|Put |Crew/i.test(cost)) return;
      out.push({ i, kind: 'activated', cost, text: m[2] });
    });
    return out;
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
    try { fn(); }
    catch (e) { this.s = JSON.parse(snap); throw e; }
    this.undoStack.push(snap);
    if (this.undoStack.length > 80) this.undoStack.shift();
    this.sba();
    this.save();
    this.onChange();
  }
  undo() {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.s = JSON.parse(prev);
    this.save();
    this.onChange();
    return true;
  }

  // ------------------------------------------------------------ zone movement

  _reset(inst) {
    Object.assign(inst, {
      tapped: false, counters: {}, damage: 0, deathtouched: false, attacking: null, blocking: null,
      eot: blankEot(), mod: { p: 0, t: 0 }, sick: false, note: '', castAs: null, x: 0, controller: inst.owner,
    });
  }

  _enterBf(inst, pid, tapped = false) {
    inst.controller = pid;
    inst.tapped = tapped;
    inst.sick = true;
    const f = this.face(inst);
    const loy = parseInt(f.loyalty, 10);
    if (this.isType(inst, 'Planeswalker') && !isNaN(loy) && inst.counters.loyalty === undefined) inst.counters.loyalty = loy;
    const def = parseInt(f.defense, 10);
    if (this.isType(inst, 'Battle') && !isNaN(def) && inst.counters.defense === undefined) inst.counters.defense = def;
    this.s.players[pid].zones.battlefield.push(inst);
  }

  /** Low-level move; must be called inside act(). */
  _move(inst, zone, { toPlayer = null, pos = 'top', tapped = false, keepFace = false, silent = false, why = '' } = {}) {
    const L = this.need(inst.iid);
    const from = L.zone;
    L.arr.splice(L.idx, 1);
    const name = this.face(inst).name;
    if (inst.ability) return; // abilities on the stack simply disappear
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
    if (dest === 'battlefield') this._enterBf(inst, ctrl, tapped);
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
  mill(pid, n = 1) {
    this.act(() => {
      const pl = this.players[pid];
      const names = [];
      for (let i = 0; i < n && pl.zones.library.length; i++) {
        const c = pl.zones.library[pl.zones.library.length - 1];
        names.push(this.face(c).name);
        this._move(c, 'graveyard', { silent: true });
      }
      this.log(`${pl.name} mills ${names.length}: ${names.join(', ') || 'nothing'}.`);
    });
  }
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

  // turn structure
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
    this._emptyPools();
    const pl = this.players[pid];
    pl.landsPlayed = 0;
    for (const c of pl.zones.battlefield) { c.tapped = false; c.sick = false; }
    this.log(`━━ Turn ${s.turn}: ${pl.name} ━━  (untap step: permanents untapped)`);
    s.phase = 1;
  }

  nextStep({ force = false } = {}) {
    this.act(() => {
      const s = this.s;
      if (s.stage !== 'play') throw new Error('Finish mulligans first.');
      if (s.winner != null) throw new Error('The game is over.');
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
    } else if (ph === 'Combat Damage') this.combatDamage();
    else if (ph === 'End of Combat') {
      for (const p of this.players) for (const c of p.zones.battlefield) { c.attacking = null; c.blocking = null; delete c.wasBlocked; }
    } else if (ph === 'Cleanup') {
      if (pl.zones.hand.length > 7) this.log(`${pl.name} must discard ${pl.zones.hand.length - 7} card(s) (hand size 7).`);
      else { this._cleanup(); }
    }
  }

  _cleanup() {
    for (const p of this.players) for (const c of p.zones.battlefield) { c.damage = 0; c.deathtouched = false; c.eot = blankEot(); }
  }

  endTurn({ force = false } = {}) {
    this.act(() => {
      const s = this.s;
      if (s.stage !== 'play') throw new Error('Finish mulligans first.');
      if (s.stack.length && !force) throw new RuleError('There are spells/abilities on the stack.');
      this._emptyPools();
      for (const p of this.players) for (const c of p.zones.battlefield) { c.attacking = null; c.blocking = null; }
      const pl = this.players[s.active];
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
      for (const p of this.players) for (const c of p.zones.battlefield) { c.attacking = null; c.blocking = null; }
      this._emptyPools();
      s.phase = i;
      this.log('Combat skipped → Main 2.');
    });
  }

  // lands & spells
  playLand(iid, { force = false } = {}) {
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
      this._move(inst, 'battlefield', { toPlayer: pl.id, keepFace: true, silent: true });
      inst.sick = false;
      this.log(`${pl.name} plays ${f.name}.`);
    });
  }

  manaSources(pl, exclude) {
    return pl.zones.battlefield
      .filter(c => !c.tapped && c.iid !== exclude && !(this.isCreature(c) && c.sick && !this.kw(c, 'Haste')))
      .map(c => ({ c, opts: manaOptions(this.face(c)) }))
      .filter(x => x.opts.length)
      .sort((a, b) => (this.isCreature(a.c) - this.isCreature(b.c)) || (a.opts.length - b.opts.length));
  }

  /** Pays from the pool, auto-tapping simple mana sources if needed. Returns {pool, lifeLoss} or null. */
  autoPay(pl, cost, x = 0, exclude = null) {
    let pool = { ...pl.pool };
    const tapped = [];
    const used = new Set();
    const srcs = this.manaSources(pl, exclude);
    const apply = r => {
      for (const c of tapped) c.tapped = true;
      if (tapped.length) this.log(`Auto-tapped ${tapped.map(c => this.face(c).name).join(', ')} for mana.`);
      return r;
    };
    for (let guard = 0; guard < 300; guard++) {
      const r = payCost(pool, cost, x, false);
      if (r) return apply(r);
      const avail = srcs.filter(s => !used.has(s.c.iid));
      if (!avail.length) break;
      const need = colorNeeds(pool, cost);
      let pick = null, add = null;
      outer: for (const col of need) {
        for (const s of avail) { const o = s.opts.find(o => o[col]); if (o) { pick = s; add = o; break outer; } }
        for (const s of avail) if (s.opts.some(o => o.any)) { pick = s; add = { [col]: 1 }; break outer; }
      }
      if (!pick) {
        if (need.length) break;
        pick = avail[0];
        add = pick.opts.find(o => !o.any) || { C: 1 };
      }
      used.add(pick.c.iid);
      tapped.push(pick.c);
      for (const k in add) if (k !== 'any') pool[k] = (pool[k] || 0) + add[k];
    }
    const r = payCost(pool, cost, x, true);
    return r ? apply(r) : null;
  }

  /** half: optional {name, mana_cost, type_line, oracle_text, adventure} for split/adventure cards. */
  cast(iid, { force = false, x = 0, ignoreCost = false, half = null } = {}) {
    this.act(() => {
      let L = this.need(iid);
      const inst = L.inst;
      const pl = this.players[inst.owner];
      const f = half || this.face(inst);
      if (/\bLand\b/.test(f.type_line) && !/\/\//.test(f.type_line)) throw new Error('That is a land — use "Play land".');
      if (L.zone === 'battlefield' || L.zone === 'stack') throw new Error(`It's already on the ${L.zone}.`);
      if (!force) {
        const err = this.timingError(pl, inst, f.type_line);
        if (err) throw new RuleError(err);
        if (L.zone !== 'hand' && !(L.zone === 'command' && inst.isCommander))
          throw new RuleError(`Casting from your ${L.zone} requires an effect that allows it (flashback, etc.).`);
      }
      const costStr = f.mana_cost || '';
      const cost = parseCost(costStr);
      const fromCommand = L.zone === 'command' && inst.isCommander;
      const tax = fromCommand ? this.commanderTax(inst) : 0;
      cost.generic += tax;
      let paidNote = '';
      if (!ignoreCost) {
        const r = this.autoPay(pl, cost, x, iid);
        if (r) { pl.pool = r.pool; if (r.lifeLoss) { pl.life -= r.lifeLoss; paidNote = ` (paid ${r.lifeLoss} life)`; } }
        else if (!force) throw new RuleError(`Not enough mana to pay ${costStr || '{0}'}${tax ? ` + {${tax}} commander tax` : ''}.`);
        else paidNote = ' (cost not paid — override)';
      } else paidNote = ' without paying its mana cost';
      if (fromCommand) pl.cmdrCasts[inst.iid] = (pl.cmdrCasts[inst.iid] || 0) + 1;
      L = this.need(iid);
      L.arr.splice(L.idx, 1);
      inst.castAs = half ? { name: half.name, mana_cost: half.mana_cost, type_line: half.type_line, oracle_text: half.oracle_text, adventure: !!half.adventure } : null;
      inst.x = x;
      inst.controller = pl.id;
      this.s.stack.push(inst);
      this.log(`${pl.name} casts ${f.name}${x ? ` (X=${x})` : ''}${tax ? ` (commander tax {${tax}})` : ''}${paidNote}.`);
    });
  }

  activate(iid, lineIdx, { force = false, x = 0 } = {}) {
    this.act(() => {
      const L = this.need(iid);
      const inst = L.inst;
      const ab = this.abilities(inst).find(a => a.i === lineIdx);
      if (!ab) throw new Error('Ability not found.');
      const pl = this.players[inst.controller];
      const name = this.face(inst).name;
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
        if (/\{T\}/.test(ab.cost)) {
          if (L.zone !== 'battlefield') throw new Error('Must be on the battlefield to use a {T} ability.');
          if (inst.tapped && !force) throw new RuleError(`${name} is already tapped.`);
          if (this.isCreature(inst) && inst.sick && !this.kw(inst, 'Haste') && !force)
            throw new RuleError(`${name} has summoning sickness: it can't use {T} abilities this turn.`);
          inst.tapped = true;
        }
        if (/\{Q\}/.test(ab.cost)) inst.tapped = false;
        const manaPart = (ab.cost.match(/\{[^}]+\}/g) || []).filter(t => !/^\{(T|Q|E)\}$/.test(t)).join('');
        if (manaPart) {
          const r = this.autoPay(pl, parseCost(manaPart), x, iid);
          if (r) { pl.pool = r.pool; pl.life -= r.lifeLoss; }
          else if (!force) throw new RuleError(`Not enough mana to pay ${manaPart}.`);
        }
      }
      this.s.stack.push({
        iid: this.s.nextId++, ability: true, key: inst.key, face: inst.face, source: inst.iid, controller: pl.id, owner: pl.id,
        label: `${name}: ${ab.cost}`, text: ab.text, x, counters: {}, eot: blankEot(), mod: { p: 0, t: 0 }, castAs: null,
      });
      this.log(`${pl.name} activates ${name} [${ab.cost}]: ${ab.text}`);
    });
  }

  resolveTop() {
    this.act(() => {
      const item = this.s.stack[this.s.stack.length - 1];
      if (!item) throw new Error('The stack is empty.');
      if (item.ability) {
        this.s.stack.pop();
        this.log(`Resolved: ${item.label} — ${item.text}  (carry out the effect)`);
        return;
      }
      const f = this.face(item);
      const pl = this.players[item.controller];
      const permanent = /\b(Artifact|Creature|Enchantment|Planeswalker|Land|Battle|Kindred|Tribal)\b/.test(f.type_line) && !/\b(Instant|Sorcery)\b/.test(f.type_line);
      if (item.castAs && item.castAs.adventure) {
        this._move(item, 'exile', { silent: true });
        this.log(`${f.name} resolves; the card goes on an adventure (exiled — you may cast the creature later).`);
      } else if (permanent) {
        this._move(item, 'battlefield', { toPlayer: pl.id, keepFace: true, silent: true });
        this.log(`${f.name} resolves and enters the battlefield under ${pl.name}'s control.`);
      } else {
        this._move(item, 'graveyard', { silent: true });
        this.log(`${f.name} resolves${item.x ? ` (X=${item.x})` : ''} — carry out its effect; card → graveyard.`);
      }
    });
  }

  counterSpell(iid) {
    this.act(() => {
      const L = this.need(iid);
      if (L.zone !== 'stack') throw new Error('Not on the stack.');
      const name = L.inst.ability ? L.inst.label : this.face(L.inst).name;
      this._move(L.inst, 'graveyard', { silent: true });
      this.log(`${name} is countered.`);
    });
  }

  // mana & permanents
  tapForMana(iid, option, color = null, { force = false } = {}) {
    this.act(() => {
      const { inst, zone } = this.need(iid);
      if (zone !== 'battlefield') throw new Error('Not on the battlefield.');
      const name = this.face(inst).name;
      if (inst.tapped && !force) throw new RuleError(`${name} is already tapped.`);
      if (this.isCreature(inst) && inst.sick && !this.kw(inst, 'Haste') && !force)
        throw new RuleError(`${name} has summoning sickness and can't tap for mana this turn.`);
      inst.tapped = true;
      const pl = this.players[inst.controller];
      const add = option.any ? { [color || 'C']: option.any } : option;
      for (const k in add) pl.pool[k] = (pl.pool[k] || 0) + add[k];
      this.log(`${pl.name} taps ${name} for ${Object.entries(add).map(([k, v]) => `{${k}}`.repeat(v)).join('')}.`);
    });
  }
  addMana(pid, color, n = 1) {
    this.act(() => { const pl = this.players[pid]; pl.pool[color] = Math.max(0, (pl.pool[color] || 0) + n); });
  }
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
  createToken(pid, key, n = 1, tapped = false) {
    this.act(() => {
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
  addCardToZone(pid, key, zone) {
    this.act(() => {
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
        if (atk.attacking !== inst.controller) throw new RuleError('That creature is not attacking you.');
        if (this.kw(atk, 'Flying') && !this.kw(inst, 'Flying') && !this.kw(inst, 'Reach')) throw new RuleError(`${this.face(atk).name} has flying; blockers need flying or reach.`);
        if (/can't be blocked(?! by| except)/i.test(this.face(atk).oracle_text || '') && !/can't be blocked/i.test('')) {
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
    const alive = this.alive();
    if (alive.length === 1 && this.players.length > 1) {
      this.s.winner = alive[0].id;
      this.log(`🏆 ${alive[0].name} wins the game!`);
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
