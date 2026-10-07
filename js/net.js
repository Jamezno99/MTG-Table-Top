// net.js — peer-to-peer online play with PeerJS (WebRTC).
//
// The host's browser runs the real game (it is the referee). Guests send the
// actions they want to take; the host runs them through the same engine and
// sends every player a copy of the table. Each copy has the other players'
// hands and all library orders hidden.
//
// Cost: $0. PeerJS's free public server only introduces the browsers to each
// other; the game data then flows directly between players.

import { Game, RuleError } from './game.js?v=20261006-6';

const PREFIX = 'mtgtab-';

// Bump this whenever the messages between host and guests change, so an old
// APK and a newer website (or vice versa) say "please update" instead of breaking.
export const PROTOCOL = 1;
const VERSION_MSG = (yours, host) => `Version mismatch: you have version ${yours ?? 'unknown'} and the host has version ${host ?? 'unknown'}. `
  + 'Whoever is behind should update (download the newest APK, or refresh the website), then try again.';
const PEERJS_URL = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';

// Optional: if some players can't connect (strict school/work networks), add a
// TURN relay here, e.g. from a free tier at metered.ca:
//   { urls: 'turn:YOUR-TURN-HOST:443', username: '…', credential: '…' }
const EXTRA_ICE_SERVERS = [];

function peerOptions() {
  const opts = { debug: 1 };
  // For local testing against your own PeerJS server: ?peerserver=localhost:9000
  const custom = new URLSearchParams(location.search).get('peerserver');
  if (custom) {
    const [host, port] = custom.split(':');
    Object.assign(opts, { host, port: +port || 9000, path: '/', secure: location.protocol === 'https:' });
  }
  if (EXTRA_ICE_SERVERS.length) {
    opts.config = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, ...EXTRA_ICE_SERVERS] };
  }
  return opts;
}

let peerLib = null;
function loadPeerLib() {
  if (window.Peer) return Promise.resolve();
  if (!peerLib) {
    peerLib = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = PEERJS_URL;
      s.onload = res;
      s.onerror = () => { peerLib = null; rej(new Error('Could not load the networking library. Check your internet connection.')); };
      document.head.append(s);
    });
  }
  return peerLib;
}

export function makeCode() {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const r = new Uint32Array(6);
  crypto.getRandomValues(r);
  return [...r].map(x => a[x % a.length]).join('');
}

export function inviteLink(code) {
  // The Android app sets window.MTG_WEB_APP_URL to the GitHub Pages site, so
  // invite links work for everyone (app users can also just type the code).
  const u = new URL(window.MTG_WEB_APP_URL || location.href);
  u.search = '';
  u.hash = '';
  u.searchParams.set('join', code);
  const ps = new URLSearchParams(location.search).get('peerserver');
  if (ps) u.searchParams.set('peerserver', ps);
  return u.toString();
}

function peerErrorText(e) {
  switch (e && e.type) {
    case 'peer-unavailable': return 'Room not found. Check the code, and make sure the host still has the game open.';
    case 'unavailable-id': return 'That room code is still in use. Wait a few seconds and try again.';
    case 'network': case 'server-error': case 'socket-error': return 'Could not reach the matchmaking server. Check your internet connection.';
    case 'browser-incompatible': return 'This browser does not support online play (WebRTC).';
    default: return (e && e.message) || 'Connection error.';
  }
}

/** Hide what this seat shouldn't see: opponents' hands and every library's order. */
function redact(game, seat) {
  const s = JSON.parse(JSON.stringify(game.s));
  for (const p of s.players) {
    const hide = (c, i) => ({ iid: -(p.id * 100000 + i + 1), key: '__hidden', hidden: true, owner: p.id, controller: p.id,
      counters: {}, eot: { p: 0, t: 0, kw: [] }, mod: { p: 0, t: 0 } });
    if (p.id !== seat) p.zones.hand = p.zones.hand.map(hide);
    p.zones.library = p.id === seat
      ? p.zones.library.sort((a, b) => (game.db[a.key]?.name || '').localeCompare(game.db[b.key]?.name || ''))
      : p.zones.library.map(hide);
  }
  s.log = s.log.slice(-250);
  return s;
}

// Actions a guest may only take for their own seat.
const OWN_SEAT_ONLY = new Set(['mulligan', 'keep', 'bottomFromHand', 'peekTop', 'concede', 'revealHand', 'chat', 'rematch']);

export const ACTIONS = ['draw', 'mill', 'shuffleLibrary', 'move', 'mulligan', 'keep', 'bottomFromHand', 'nextStep', 'endTurn',
  'skipCombat', 'playLand', 'cast', 'activate', 'resolveTop', 'counterSpell', 'tapForMana', 'addMana', 'clearPool', 'toggleTap', 'untapAll',
  'addCounter', 'setDamage', 'modifyPT', 'grantKeyword', 'transform', 'setNote', 'changeControl', 'createToken', 'copyAsToken',
  'addCardToZone', 'life', 'setLife', 'poison', 'commanderDamage', 'concede', 'setSetting', 'declareAttack', 'declareBlock',
  'undo', 'peekTop', 'revealHand', 'chat', 'rematch'];

// ------------------------------------------------------------------ host

export class Host {
  constructor(code, { onLobby = () => {}, onStatus = () => {} } = {}) {
    this.code = code;
    this.guests = [];          // { id, name, deckText, conn, connected, seat, report }
    this.game = null;
    this.sentKeys = new Set();
    this.onLobby = onLobby;    // lobby membership or a deck changed
    this.onStatus = onStatus;  // connection changes during a game
    this.nextGuestId = 1;
  }

  async open() {
    await loadPeerLib();
    return new Promise((res, rej) => {
      let opened = false;
      this.peer = new window.Peer(PREFIX + this.code, peerOptions());
      this.peer.on('open', () => { opened = true; res(); });
      this.peer.on('connection', conn => this._onConn(conn));
      this.peer.on('disconnected', () => { if (!this.closed) setTimeout(() => this.peer && !this.peer.destroyed && this.peer.reconnect(), 1500); });
      this.peer.on('error', e => {
        if (!opened) rej(new Error(peerErrorText(e)));
        else if (e.type !== 'peer-unavailable') this.onStatus(peerErrorText(e));
      });
    });
  }

  close() {
    this.closed = true;
    for (const g of this.guests) try { g.conn && g.conn.close(); } catch { /* ignore */ }
    if (this.peer) this.peer.destroy();
  }

  connectedCount() { return this.guests.filter(g => g.connected).length; }

  _send(conn, msg) { try { if (conn && conn.open) conn.send(msg); } catch (e) { console.warn('send failed', e); } }

  _onConn(conn) {
    conn.on('data', msg => this._onMsg(conn, msg));
    conn.on('close', () => {
      const g = this.guests.find(x => x.conn === conn);
      if (!g) return;
      g.connected = false;
      if (this.game) { this.game.chat(g.seat, '(disconnected)'); this.onStatus(`${g.name} disconnected. They can rejoin with the same name.`); }
      else { this.guests = this.guests.filter(x => x !== g); this.onLobby(); }
    });
  }

  _onMsg(conn, msg) {
    if (!msg || typeof msg !== 'object') return;
    let g = this.guests.find(x => x.conn === conn);

    if (msg.t === 'hello') {
      if (msg.v !== PROTOCOL) return this._send(conn, { t: 'error', msg: VERSION_MSG(msg.v, PROTOCOL), v: PROTOCOL });
      const name = String(msg.name || 'Guest').trim().slice(0, 24) || 'Guest';
      if (this.game) {
        // Rejoin: match an existing seat by name.
        const seat = this.game.players.findIndex(p => p.name.toLowerCase() === name.toLowerCase() && p.id !== 0);
        if (seat < 0) return this._send(conn, { t: 'error', msg: 'This game has already started. To rejoin, use exactly the name you played under.' });
        g = this.guests.find(x => x.seat === seat);
        if (!g) { g = { id: this.nextGuestId++, name, seat }; this.guests.push(g); }
        if (g.conn && g.conn !== conn) try { g.conn.close(); } catch { /* ignore */ }
        Object.assign(g, { conn, connected: true });
        this._send(conn, { t: 'start', seat, code: this.code, v: PROTOCOL });
        this._send(conn, { t: 'db', add: this.game.db, reset: true });
        this._sendState(g);
        this.game.chat(seat, '(reconnected)');
        this.onStatus(`${g.name} reconnected.`);
        return;
      }
      if (this.guests.length >= 3) return this._send(conn, { t: 'error', msg: 'This room is full (4 players max).' });
      let unique = name;
      for (let n = 2; [this.hostName, ...this.guests.map(x => x.name)].some(x => x && x.toLowerCase() === unique.toLowerCase()); n++) unique = `${name} ${n}`;
      g = { id: this.nextGuestId++, name: unique, deckText: String(msg.deck || ''), conn, connected: true, report: null };
      this.guests.push(g);
      this.onLobby(g);
      return;
    }
    if (!g) return;

    if (msg.t === 'deck' && !this.game) { g.deckText = String(msg.deck || ''); g.report = null; this.onLobby(g); return; }

    if (msg.t === 'act') {
      const reply = r => this._send(conn, { t: 'result', id: msg.id, ...r });
      if (!this.game) return reply({ ok: false, error: 'The game has not started.' });
      if (!ACTIONS.includes(msg.method)) return reply({ ok: false, error: 'Unknown action.' });
      const args = Array.isArray(msg.args) ? msg.args : [];
      if (OWN_SEAT_ONLY.has(msg.method) && +args[0] !== g.seat) return reply({ ok: false, error: 'You can only do that for yourself.' });
      if (msg.method === 'peekTop' && +args[0] !== g.seat) return reply({ ok: false, error: "You can't look at another player's library." });
      try {
        const value = this.game[msg.method](...args);
        reply({ ok: true, value: value === undefined ? null : value });
      } catch (e) {
        reply({ ok: false, error: e.message, rule: e instanceof RuleError });
      }
    }
  }

  /** Lobby info everyone sees while waiting. */
  broadcastLobby(info) {
    for (const g of this.guests) this._send(g.conn, { t: 'lobby', ...info, you: g.name, v: PROTOCOL });
  }

  start(game) {
    this.game = game;
    this.guests.forEach((g, i) => { g.seat = i + 1; });
    for (const g of this.guests) {
      this._send(g.conn, { t: 'start', seat: g.seat, code: this.code, v: PROTOCOL });
      this._send(g.conn, { t: 'db', add: game.db, reset: true });
    }
    Object.keys(game.db).forEach(k => this.sentKeys.add(k));
    game.onSync = () => this.syncAll();
    this.syncAll();
  }

  /** Resume hosting a saved game: guests rejoin by name. */
  resume(game) {
    this.game = game;
    Object.keys(game.db).forEach(k => this.sentKeys.add(k));
    game.onSync = () => this.syncAll();
  }

  _sendState(g) {
    this._send(g.conn, { t: 'state', s: redact(this.game, g.seat), undo: this.game.undoStack.length });
  }

  syncAll() {
    if (!this.game) return;
    const fresh = Object.keys(this.game.db).filter(k => !this.sentKeys.has(k));
    const add = {};
    for (const k of fresh) { add[k] = this.game.db[k]; this.sentKeys.add(k); }
    for (const g of this.guests) {
      if (!g.connected) continue;
      if (fresh.length) this._send(g.conn, { t: 'db', add });
      this._sendState(g);
    }
  }
}

// ------------------------------------------------------------------ guest

/** A Game whose state comes from the host and whose actions are sent to the host. */
export class RemoteGame extends Game {
  constructor(guest) {
    super({}, null);
    this.guest = guest;
    this.undoCount = 0;
  }
  canUndo() { return this.undoCount > 0; }
  save() { /* the host keeps the save */ }
}
for (const m of ACTIONS) RemoteGame.prototype[m] = function (...args) { return this.guest.request(m, args); };

export class Guest {
  constructor({ onLobby = () => {}, onStart = () => {}, onError = () => {}, onClose = () => {} } = {}) {
    Object.assign(this, { onLobby, onStart, onError, onClose });
    this.pending = new Map();
    this.seq = 0;
    this.game = new RemoteGame(this);
  }

  async connect(code, name, deckText) {
    await loadPeerLib();
    this.code = code.trim().toUpperCase();
    this.name = name;
    this.deckText = deckText;
    if (!this.peer || this.peer.destroyed) {
      await new Promise((res, rej) => {
        this.peer = new window.Peer(undefined, peerOptions());
        this.peer.on('open', res);
        this.peer.on('error', e => { rej(new Error(peerErrorText(e))); this.onError(peerErrorText(e)); });
      });
    }
    return new Promise((res, rej) => {
      const conn = this.peer.connect(PREFIX + this.code, { reliable: true });
      const timer = setTimeout(() => rej(new Error('Could not connect to the host (timed out). Check the code, or the host may be behind a strict network.')), 20000);
      conn.on('open', () => {
        clearTimeout(timer);
        this.conn = conn;
        this.connected = true;
        conn.send({ t: 'hello', name, deck: deckText, v: PROTOCOL });
        res();
      });
      conn.on('data', msg => this._onMsg(msg));
      conn.on('close', () => {
        if (this.conn !== conn) return;
        this.connected = false;
        for (const p of this.pending.values()) p.rej(new Error('Disconnected from the host.'));
        this.pending.clear();
        this.onClose();
      });
      conn.on('error', e => { clearTimeout(timer); rej(new Error(peerErrorText(e))); });
    });
  }

  reconnect() { return this.connect(this.code, this.name, this.deckText); }

  sendDeck(deckText) { this.deckText = deckText; if (this.conn && this.conn.open) this.conn.send({ t: 'deck', deck: deckText }); }

  close() { try { this.peer && this.peer.destroy(); } catch { /* ignore */ } }

  request(method, args) {
    return new Promise((res, rej) => {
      if (!this.conn || !this.conn.open) return rej(new Error('Not connected to the host.'));
      const id = ++this.seq;
      this.pending.set(id, { res, rej });
      this.conn.send({ t: 'act', id, method, args });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('The host did not respond.')); } }, 20000);
    });
  }

  _onMsg(msg) {
    if (!msg || typeof msg !== 'object') return;
    const game = this.game;
    if ((msg.t === 'start' || msg.t === 'lobby') && msg.v !== PROTOCOL) {
      this.onError(VERSION_MSG(PROTOCOL, msg.v));
      try { this.conn.close(); } catch { /* ignore */ }
      return;
    }
    switch (msg.t) {
      case 'lobby': this.onLobby(msg); break;
      case 'error': this.onError(msg.msg); break;
      case 'start': this.seat = msg.seat; this.code = msg.code || this.code; this.onStart(msg.seat); break;
      case 'db': if (msg.reset) game.db = {}; Object.assign(game.db, msg.add); break;
      case 'state': game.s = msg.s; game.undoCount = msg.undo; game.onChange(); break;
      case 'result': {
        const p = this.pending.get(msg.id);
        if (!p) break;
        this.pending.delete(msg.id);
        if (msg.ok) p.res(msg.value);
        else p.rej(msg.rule ? new RuleError(msg.error) : new Error(msg.error));
        break;
      }
    }
  }
}
