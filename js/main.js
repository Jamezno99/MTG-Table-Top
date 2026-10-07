// main.js — UI: setup & online lobby, board rendering, menus and dialogs.
import { fetchCards, searchCards } from './scryfall.js?v=20261006-6';
import { parseDecklist, validateDeck, resolveTrailing, FORMATS, manaOptions, SAMPLE_DECKS, COLORS } from './rules.js?v=20261006-6';
import { Game, PHASES, RuleError } from './game.js?v=20261006-6';
import { Host, Guest, makeCode, inviteLink } from './net.js?v=20261006-6';

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const symUrl = s => `https://svgs.scryfall.io/card-symbols/${encodeURIComponent(s.replace(/\//g, '').toUpperCase())}.svg`;
const symbols = t => esc(t).replace(/\{([^}]+)\}/g, (m, s) => `<img class="sym" alt="{${s}}" title="{${s}}" src="${symUrl(s)}">`).replace(/\n/g, '<br>');
const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};
const isTouch = () => matchMedia('(hover: none)').matches;
const isPhone = () => matchMedia('(max-width: 700px)').matches;

let game = null;
let viewer = 0;          // whose hand is shown
let lastActive = null;
let autoViewer = true;
let handHidden = false;
let online = null;       // null | { role: 'host'|'guest', seat, host?, guest?, code, status }
let mode = 'local';      // setup mode
let lobby = null;        // setup-time online objects: { host } or { guest }

const mySeat = () => (online ? online.seat : viewer);

// ================================================================ dialogs

function openModal(html, { wide = false, onClose } = {}) {
  closeMenu();
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
  $('#modal-root').append(back);
  let closed = false;
  const close = () => { if (closed) return; closed = true; back.remove(); onClose && onClose(); };
  back.addEventListener('mousedown', e => { if (e.target === back) close(); });
  back.addEventListener('click', e => { if (e.target.closest('[data-close]')) close(); });
  back.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  return { el: back.firstElementChild, close };
}

function choose(title, options) {
  return new Promise(res => {
    const m = openModal(`<h3>${esc(title)}</h3><div class="choices">${options.map((o, i) =>
      `<button class="btn" data-i="${i}">${o.html || esc(o.label)}</button>`).join('')}</div>
      <div class="right"><button class="btn ghost" data-close>Cancel</button></div>`, { onClose: () => res(null) });
    m.el.addEventListener('click', e => { const b = e.target.closest('[data-i]'); if (b) { res(options[+b.dataset.i].value); m.close(); } });
  });
}

function ask(title, def = '', type = 'number', hint = '') {
  return new Promise(res => {
    const m = openModal(`<h3>${esc(title)}</h3>${hint ? `<p class="muted">${esc(hint)}</p>` : ''}<form>
      <input class="inp" type="${type}" ${type === 'number' ? 'inputmode="numeric"' : ''} value="${esc(def)}">
      <div class="right"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">OK</button></div></form>`,
      { onClose: () => res(null) });
    const inp = m.el.querySelector('input');
    inp.focus(); inp.select();
    m.el.querySelector('form').addEventListener('submit', e => {
      e.preventDefault();
      res(type === 'number' ? (parseInt(inp.value, 10) || 0) : inp.value.trim());
      m.close();
    });
  });
}
const askNumber = (t, d = 1, h = '') => ask(t, d, 'number', h);
const askText = (t, d = '', h = '') => ask(t, d, 'text', h);

function confirmDlg(msg, yes = 'OK', no = 'Cancel') {
  return new Promise(res => {
    const m = openModal(`<pre>${esc(msg)}</pre><div class="right"><button class="btn ghost" data-close>${esc(no)}</button><button class="btn primary" data-yes>${esc(yes)}</button></div>`,
      { onClose: () => res(false) });
    m.el.querySelector('[data-yes]').addEventListener('click', () => { res(true); m.close(); });
    m.el.querySelector('[data-yes]').focus();
  });
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 4000);
}

/** Runs an engine action (local or over the network); on a rules violation, offers to do it anyway. */
async function run(fn) {
  try { await fn(false); }
  catch (e) {
    if (e instanceof RuleError || e.name === 'RuleError') {
      if (await confirmDlg(`⚖  Rules check\n\n${e.message}`, 'Do it anyway', 'Cancel')) {
        try { await fn(true); } catch (e2) { toast(e2.message); }
      }
    } else { console.error(e); toast(e.message); }
  }
  render();
}

/** Turn-advancing buttons: online, only the active player normally presses them. */
function advance(kind) {
  run(async force => {
    if (online && game.s.stage === 'play' && game.s.active !== mySeat() && !force)
      throw new RuleError(`It's ${game.players[game.s.active].name}'s turn. Advance it for them anyway (e.g. they disconnected)?`);
    await game[kind]({ force });
  });
}

// ================================================================ menu (popover on desktop, bottom sheet on phones)

function openMenu(items, x, y, cardInst = null) {
  const m = $('#menu');
  const head = cardInst && (isTouch() || isPhone()) ? cardThumb(cardInst) : '';
  m.innerHTML = head + items.map((it, i) => it === '-' ? '<hr>' : it.header ? (head && i === 0 ? '' : `<div class="mh">${esc(it.header)}</div>`)
    : `<button data-i="${i}" ${it.disabled ? 'disabled' : ''}>${esc(it.label)}</button>`).join('')
    + (isPhone() ? '<button class="cancel" data-cancel>Cancel</button>' : '');
  m.hidden = false;
  m.classList.toggle('sheet', isPhone());
  if (!isPhone()) {
    const r = m.getBoundingClientRect();
    m.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
    m.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
  } else { m.style.left = ''; m.style.top = ''; }
  m.onclick = e => {
    if (e.target.closest('[data-cancel]')) return closeMenu();
    if (e.target.closest('[data-view]')) { closeMenu(); return viewCard(cardInst); }
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    closeMenu();
    items[+b.dataset.i].fn();
  };
}
function closeMenu() { const m = $('#menu'); if (m) m.hidden = true; }

function cardThumb(inst) {
  const f = game.face(inst);
  const img = f.image && f.image.normal;
  return `<div class="mthumb">${img ? `<img src="${img}" alt="">` : ''}<div><b>${esc(inst.ability ? inst.label : f.name)}</b>
    <div class="muted">${esc(f.type_line || '')}</div><button class="small" data-view>🔍 Read card</button></div></div>`;
}

function viewCard(inst) {
  const f = game.face(inst);
  const d = game.db[inst.key] || {};
  const img = f.image && f.image.normal;
  openModal(`<div class="cardview">${img ? `<img src="${img}" alt="${esc(f.name)}">` : ''}
    <div><h3>${esc(f.name)} ${symbols(f.mana_cost || '')}</h3><div class="ptype">${esc(f.type_line || '')}</div>
    <p>${inst.ability ? esc(inst.text) : symbols(f.oracle_text || '')}</p>
    ${f.power != null ? `<p><b>${esc(f.power)}/${esc(f.toughness)}</b></p>` : f.loyalty ? `<p>Loyalty ${esc(f.loyalty)}</p>` : ''}
    ${d.scryfall_uri ? `<a href="${d.scryfall_uri}" target="_blank" rel="noopener">Rulings on Scryfall ↗</a>` : ''}</div></div>
    <div class="right"><button class="btn primary" data-close>Close</button></div>`, { wide: true });
}

// ================================================================ setup screen

const deckText = {};

function renderSetup() {
  const fmt = $('#format');
  fmt.innerHTML = Object.entries(FORMATS).map(([k, f]) => `<option value="${k}">${esc(f.name)}</option>`).join('');
  fmt.value = store.get('mtgsim-format') || 'commander';
  $('#resume').hidden = !Game.hasSave();
  const join = new URLSearchParams(location.search).get('join');
  if (join) { $('#roomcode').value = join.toUpperCase(); setMode('join'); }
  else setMode(mode);
}

function setMode(m) {
  if (lobby) return; // locked once a room exists
  mode = m;
  document.querySelectorAll('.modes [data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
  document.querySelectorAll('[data-show]').forEach(el => { el.hidden = !el.dataset.show.split(' ').includes(m); });
  $('#start').textContent = m === 'local' ? 'Check decks & start' : m === 'host' ? 'Create room' : 'Join room';
  $('#lobby').hidden = true;
  $('#report').innerHTML = '';
  renderDeckBoxes();
}

function renderDeckBoxes() {
  saveDeckInputs();
  const n = mode === 'local' ? +$('#playercount').value : 1;
  const boxes = [];
  for (let i = 0; i < n; i++) {
    const saved = deckText[i] ?? store.get('mtgsim-deck-' + i) ?? '';
    const name = store.get('mtgsim-name-' + i) || `Player ${i + 1}`;
    boxes.push(`<div class="deckbox" data-p="${i}">
      <label>${mode === 'local' ? 'Name' : 'Your name'} <input class="pname-in" value="${esc(name)}" maxlength="24"></label>
      <textarea placeholder="Commander&#10;1 Atraxa, Praetors' Voice&#10;&#10;Deck&#10;1 Sol Ring&#10;1 Command Tower&#10;…">${esc(saved)}</textarea>
      <div class="samples">Sample: ${Object.keys(SAMPLE_DECKS).map(k => `<button class="small" data-sample="${esc(k)}">${esc(k)}</button>`).join('')}</div>
    </div>`);
  }
  $('#decks').innerHTML = boxes.join('');
}

function saveDeckInputs() {
  document.querySelectorAll('.deckbox').forEach(box => {
    const i = +box.dataset.p;
    deckText[i] = box.querySelector('textarea').value;
    store.set('mtgsim-deck-' + i, deckText[i]);
    store.set('mtgsim-name-' + i, box.querySelector('.pname-in').value);
  });
}

function bindSetup() {
  document.querySelectorAll('.modes [data-mode]').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('#playercount').addEventListener('change', renderDeckBoxes);
  $('#format').addEventListener('change', () => {
    store.set('mtgsim-format', $('#format').value);
    if (lobby && lobby.host) { lobby.hostReport = null; for (const g of lobby.host.guests) g.report = null; refreshHostLobby(); }
  });
  $('#decks').addEventListener('click', e => {
    const b = e.target.closest('[data-sample]');
    if (!b) return;
    b.closest('.deckbox').querySelector('textarea').value = SAMPLE_DECKS[b.dataset.sample];
    if (mode !== 'join') $('#format').value = 'commander';
    deckChanged();
  });
  $('#decks').addEventListener('change', e => { if (e.target.matches('textarea')) deckChanged(); });
  $('#start').addEventListener('click', () => {
    if (mode === 'local') startLocal();
    else if (mode === 'host') lobby ? startHosted() : createRoom();
    else lobby ? lobby.guest.sendDeck(currentDeck().text) || toast('Deck sent to the host.') : joinRoom();
  });
  $('#resume').addEventListener('click', resumeSaved);
  $('#lobby').addEventListener('click', e => {
    const c = e.target.closest('[data-copy]');
    if (c) copyText(c.dataset.copy);
  });
}

function deckChanged() {
  saveDeckInputs();
  if (lobby && lobby.host) { lobby.hostReport = null; refreshHostLobby(); }
}

function currentDeck() {
  const box = $('.deckbox');
  return { name: box.querySelector('.pname-in').value.trim() || 'Player', text: box.querySelector('textarea').value };
}

function copyText(t) {
  (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject())
    .then(() => toast('Copied!'))
    .catch(() => askText('Copy this:', t));
}

async function checkDeck(text, format) {
  const parsed = parseDecklist(text);
  if (!parsed.main.length && !parsed.commanders.length) return { parsed, errors: ['No decklist yet.'], warnings: [], identity: [] };
  const names = [...parsed.main, ...parsed.commanders, ...parsed.side].map(e => e.name);
  const lookup = await fetchCards(names, msg => { $('#progress').textContent = msg; });
  $('#progress').textContent = '';
  resolveTrailing(parsed, lookup, format);
  const result = validateDeck(parsed, lookup, format);
  if (parsed.detected) result.warnings.unshift(parsed.detected + ' (from the last line after a blank line).');
  return { parsed, lookup, ...result };
}

function reportHTML(name, r, format) {
  const id = r.identity && r.identity.length ? ` · ${r.identity.map(c => `<img class="sym" src="${symUrl(c)}" alt="${c}">`).join('')}` : '';
  return `<div class="pblock"><b>${esc(name)}</b>: ${r.errors.length
    ? `<span class="err">${r.errors.length} problem${r.errors.length > 1 ? 's' : ''}</span><ul>${r.errors.slice(0, 12).map(x => `<li>${esc(x)}</li>`).join('')}${r.errors.length > 12 ? `<li>…and ${r.errors.length - 12} more</li>` : ''}</ul>`
    : `<span class="ok">deck is legal in ${esc(FORMATS[format].name)}</span>${id}`}
    ${r.warnings && r.warnings.length ? `<ul class="muted">${r.warnings.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</div>`;
}

function buildPlayers(entries, format) {
  // entries: [{ name, parsed, lookup }]
  const db = {};
  const toEntries = (list, lookup) => list.map(e => { const c = lookup(e.name); if (!c) return null; db[c.name] = c; return { key: c.name, qty: e.qty }; }).filter(Boolean);
  const cmdrFormat = format === 'commander' || format === 'freeform';
  const players = entries.map(d => {
    const main = toEntries(d.parsed.main, d.lookup);
    const cmdrs = toEntries(d.parsed.commanders, d.lookup);
    return { name: d.name, main: cmdrFormat ? main : [...main, ...cmdrs], commanders: cmdrFormat ? cmdrs.map(e => e.key) : [] };
  });
  return { players, db };
}

// ---------------- local game

async function startLocal() {
  saveDeckInputs();
  const format = $('#format').value;
  const boxes = [...document.querySelectorAll('.deckbox')];
  const btn = $('#start');
  btn.disabled = true;
  const entries = [];
  try {
    for (const box of boxes) {
      const name = box.querySelector('.pname-in').value.trim() || `Player ${+box.dataset.p + 1}`;
      entries.push({ name, ...(await checkDeck(box.querySelector('textarea').value, format)) });
    }
  } catch (e) { toast('Could not reach Scryfall: ' + e.message); return; }
  finally { btn.disabled = false; }
  $('#report').innerHTML = entries.map(e => reportHTML(e.name, e, format)).join('');
  if (entries.some(e => !e.lookup)) return toast('Every player needs a decklist.');
  if (entries.some(e => e.errors.length) && !await confirmDlg('Some decks are not legal (see the report).\n\nStart anyway? Cards that could not be found will be left out.', 'Start anyway', 'Fix decks')) return;
  const { players, db } = buildPlayers(entries, format);
  startGame(Game.create({ format, players, db }));
}

// ---------------- hosting

async function createRoom() {
  saveDeckInputs();
  const me = currentDeck();
  const code = makeCode();
  const host = new Host(code, { onLobby: () => refreshHostLobby(), onStatus: msg => { toast(msg); render(); } });
  host.hostName = me.name;
  $('#start').disabled = true;
  $('#progress').textContent = 'Opening room…';
  try { await host.open(); }
  catch (e) { toast(e.message); $('#start').disabled = false; $('#progress').textContent = ''; return; }
  $('#progress').textContent = '';
  $('#start').disabled = false;
  $('#start').textContent = 'Start game';
  lobby = { host, code, hostReport: null };
  document.querySelectorAll('.modes button').forEach(b => { b.disabled = true; });
  refreshHostLobby();
}

let lobbyBusy = false;
async function refreshHostLobby() {
  if (!lobby || !lobby.host || lobby.host.game) return;
  const { host, code } = lobby;
  const format = $('#format').value;
  const me = currentDeck();
  host.hostName = me.name;
  if (!lobbyBusy) {
    lobbyBusy = true;
    try {
      if (!lobby.hostReport) lobby.hostReport = { name: me.name, ...(await checkDeck(me.text, format)) };
      for (const g of host.guests) if (!g.report) g.report = { name: g.name, ...(await checkDeck(g.deckText, format)) };
    } catch (e) { toast('Could not check decks: ' + e.message); }
    lobbyBusy = false;
  }
  const people = [{ name: me.name, r: lobby.hostReport, host: true }, ...host.guests.map(g => ({ name: g.name, r: g.report, connected: g.connected }))];
  const link = inviteLink(code);
  $('#lobby').hidden = false;
  $('#lobby').innerHTML = `<div class="roombox">
      <div><span class="muted">Room code</span><div class="code">${code}</div></div>
      <div class="invite"><span class="muted">Send this link to your friends (works on phones too):</span>
        <div class="linkrow"><input readonly value="${esc(link)}"><button class="btn small" data-copy="${esc(link)}">Copy link</button></div></div>
    </div>
    <h3 style="margin-top:12px">Players (${people.length}/4)</h3>
    <ul class="plist">${people.map(p => `<li><b>${esc(p.name)}</b>${p.host ? ' <span class="tag">Host</span>' : ''}
      ${!p.r ? '<span class="muted">checking deck…</span>' : p.r.errors.length ? `<span class="err">${p.r.errors.length} deck problem${p.r.errors.length > 1 ? 's' : ''}</span>` : '<span class="ok">deck legal ✓</span>'}</li>`).join('')}</ul>
    ${host.guests.length ? '' : '<p class="muted">Waiting for players to join…</p>'}`;
  $('#report').innerHTML = people.filter(p => p.r).map(p => reportHTML(p.name, p.r, format)).join('');
  host.broadcastLobby({
    code, format: FORMATS[format].name,
    players: people.map(p => ({ name: p.name, host: !!p.host, status: !p.r ? 'checking' : p.r.errors.length ? `${p.r.errors.length} problems` : 'legal' })),
    yourErrors: Object.fromEntries(host.guests.filter(g => g.report).map(g => [g.name, g.report.errors.slice(0, 15)])),
  });
}

async function startHosted() {
  const { host } = lobby;
  if (!host.guests.length) return toast('Wait for at least one friend to join.');
  if (lobbyBusy) return toast('Still checking decks — try again in a moment.');
  const format = $('#format').value;
  const me = currentDeck();
  try {
    if (!lobby.hostReport) lobby.hostReport = { name: me.name, ...(await checkDeck(me.text, format)) };
    for (const g of host.guests) if (!g.report) g.report = { name: g.name, ...(await checkDeck(g.deckText, format)) };
  } catch (e) { return toast(e.message); }
  const entries = [lobby.hostReport, ...host.guests.map(g => g.report)];
  if (entries.some(e => !e.lookup)) return toast('Every player needs a decklist.');
  if (entries.some(e => e.errors.length) && !await confirmDlg('Some decks are not legal (see the report).\n\nStart anyway?', 'Start anyway', 'Wait')) return;
  const { players, db } = buildPlayers(entries, format);
  const g = Game.create({ format, players, db });
  g.s.online = { code: lobby.code };
  g.save();
  host.start(g);
  startGame(g, { role: 'host', seat: 0, host, code: lobby.code });
}

async function resumeSaved() {
  const g = Game.load();
  if (!g) return toast('No saved game found.');
  if (g.s.online && g.s.online.code) {
    const ok = await confirmDlg(`This was an online game (room ${g.s.online.code}).\n\nHost it again? Your friends rejoin with the same link and the same names they used.`, 'Host again', 'Play offline');
    if (ok) {
      const host = new Host(g.s.online.code, { onLobby: () => {}, onStatus: msg => { toast(msg); render(); } });
      host.hostName = g.players[0].name;
      try { await host.open(); }
      catch (e) {
        await new Promise(r => setTimeout(r, 3000));
        try { await host.open(); } catch (e2) { return toast(e2.message); }
      }
      host.resume(g);
      return startGame(g, { role: 'host', seat: 0, host, code: g.s.online.code });
    }
  }
  startGame(g);
}

// ---------------- joining

async function joinRoom() {
  saveDeckInputs();
  const code = $('#roomcode').value.trim().toUpperCase();
  if (code.length < 4) return toast('Enter the room code from the host.');
  const me = currentDeck();
  const guest = new Guest({
    onLobby: showGuestLobby,
    onStart: seat => {
      if (online) { online.seat = seat; online.status = 'connected'; render(); return; } // reconnect
      startGame(guest.game, { role: 'guest', seat, guest, code: guest.code });
    },
    onError: msg => toast(msg),
    onClose: () => {
      if (online) { online.status = 'lost'; toast('Lost connection to the host. Tap Reconnect.'); render(); }
      else { toast('Disconnected from the room.'); lobby = null; setModeUnlocked(); }
    },
  });
  $('#start').disabled = true;
  $('#progress').textContent = 'Connecting…';
  try { await guest.connect(code, me.name, me.text); }
  catch (e) { toast(e.message); guest.close(); $('#start').disabled = false; $('#progress').textContent = ''; return; }
  $('#progress').textContent = '';
  $('#start').disabled = false;
  $('#start').textContent = 'Send updated deck';
  lobby = { guest, code };
  document.querySelectorAll('.modes button').forEach(b => { b.disabled = true; });
  $('#lobby').hidden = false;
  $('#lobby').innerHTML = '<p>Connected! Waiting for the host…</p>';
}

function setModeUnlocked() {
  document.querySelectorAll('.modes button').forEach(b => { b.disabled = false; });
  setMode(mode);
}

function showGuestLobby(msg) {
  const mine = (msg.yourErrors || {})[msg.you] || [];
  $('#lobby').hidden = false;
  $('#lobby').innerHTML = `<div class="roombox"><div><span class="muted">Room</span><div class="code">${esc(msg.code)}</div></div>
    <div><span class="muted">Format</span><div><b>${esc(msg.format)}</b></div></div></div>
    <h3 style="margin-top:12px">Players</h3>
    <ul class="plist">${msg.players.map(p => `<li><b>${esc(p.name)}</b>${p.host ? ' <span class="tag">Host</span>' : ''}${p.name === msg.you ? ' <span class="muted">(you)</span>' : ''}
      <span class="${p.status === 'legal' ? 'ok' : p.status === 'checking' ? 'muted' : 'err'}">${p.status === 'legal' ? 'deck legal ✓' : esc(p.status)}</span></li>`).join('')}</ul>
    ${mine.length ? `<div class="pblock"><span class="err">Your deck:</span><ul>${mine.map(x => `<li>${esc(x)}</li>`).join('')}</ul><p class="muted">Fix it above and tap “Send updated deck”.</p></div>` : ''}
    <p class="muted">The host starts the game when everyone is ready.</p>`;
}

// ---------------- entering the game

function startGame(g, net = null) {
  resetAnimations();
  game = g;
  online = net ? { status: 'connected', ...net } : null;
  game.onChange = render;
  viewer = online ? online.seat : (game.s && game.s.stage === 'mulligan' ? 0 : (game.s ? game.s.active : 0));
  autoViewer = !online;
  handHidden = false;
  lastActive = game.s ? game.s.active : null;
  lobby = null;
  $('#setup').hidden = true;
  $('#game').hidden = false;
  $('#chatform').hidden = !online;
  document.body.classList.add('ingame');
  render();
}

function leaveGame() {
  const w = $('#winner'); if (w) w.remove();
  dismissedMatch = null;
  if (online && online.host) online.host.close();
  if (online && online.guest) online.guest.close();
  online = null;
  game = null;
  $('#game').hidden = true;
  $('#setup').hidden = false;
  document.body.classList.remove('ingame');
  document.querySelectorAll('.modes button').forEach(b => { b.disabled = false; });
  history.replaceState(null, '', location.pathname + (new URLSearchParams(location.search).get('peerserver') ? `?peerserver=${new URLSearchParams(location.search).get('peerserver')}` : ''));
  renderSetup();
}

// ================================================================ rendering

function cardHTML(inst, { size = '', bf = false, hidden = false } = {}) {
  if (hidden || inst.hidden) return `<div class="card back ${size}"></div>`;
  const f = game.face(inst);
  const cls = ['card', size];
  if (inst.tapped) cls.push('tapped');
  const isCr = game.isCreature(inst);
  if (bf && isCr && inst.sick && !game.kw(inst, 'Haste')) cls.push('sick');
  if (inst.attacking != null) cls.push('attacking');
  if (inst.blocking != null) cls.push('blocking');
  if (inst.isCommander) cls.push('cmdr');
  const src = f.image && (size.includes('hand') || size.includes('big') ? f.image.normal : f.image.small);
  const body = src
    ? `<img src="${src}" alt="${esc(f.name)}" loading="lazy" draggable="false">`
    : `<div class="textcard"><b>${esc(f.name)}</b><span>${symbols(f.mana_cost || '')}</span><i>${esc(f.type_line || '')}</i><small>${esc((f.oracle_text || '').slice(0, 160))}</small>${f.power != null ? `<b>${esc(f.power)}/${esc(f.toughness)}</b>` : ''}</div>`;
  let badges = '';
  if (bf) {
    if (isCr) {
      const { p, t } = game.pt(inst);
      const base = (parseInt(f.power, 10) || 0) + (parseInt(f.toughness, 10) || 0);
      badges += `<span class="badge pt ${p + t > base ? 'up' : p + t < base ? 'down' : ''}">${p}/${t}</span>`;
    }
    if (inst.damage) badges += `<span class="badge dmg">${inst.damage} dmg</span>`;
    const cn = Object.entries(inst.counters || {}).filter(([k]) => k !== 'loyalty' && k !== 'defense');
    if (cn.length) badges += `<span class="badge cnt">${cn.map(([k, v]) => `${v}× ${esc(k)}`).join(' · ')}</span>`;
    if (inst.counters && inst.counters.loyalty !== undefined) badges += `<span class="badge loy">◆ ${inst.counters.loyalty}</span>`;
    else if (inst.counters && inst.counters.defense !== undefined) badges += `<span class="badge loy">⛨ ${inst.counters.defense}</span>`;
    else if (inst.token) badges += `<span class="badge tok">TOKEN</span>`;
    if (inst.note) badges += `<span class="badge note">${esc(inst.note)}</span>`;
    if (inst.eot && inst.eot.kw.length) badges += `<span class="badge note">${esc(inst.eot.kw.join(', '))}</span>`;
  }
  return `<div class="${cls.join(' ')}" data-iid="${inst.iid}">${body}${badges}</div>`;
}

function renderTop() {
  const s = game.s;
  const act = game.players[s.active];
  const myTurn = !online || s.active === mySeat();
  const over = s.winner != null;
  const matchChip = (s.match || 1) > 1 ? ` <span class="chip hide-sm" title="${esc(game.scoreLine())}">Game ${s.match}</span>` : '';
  $('#turninfo').innerHTML = over ? `🏆 ${esc(game.players[s.winner].name)} won${matchChip}`
    : s.stage === 'mulligan' ? `Mulligans${matchChip}`
    : `Turn ${s.turn} · <span style="color:var(--gold-2)">${online && s.active === mySeat() ? 'Your turn' : esc(act.name)}</span> <span class="phase-now">${PHASES[s.phase]}</span>${matchChip}`;
  $('#phases').innerHTML = s.stage === 'play' && !over ? PHASES.map((p, i) =>
    `<span class="phase ${i === s.phase ? 'on' : i < s.phase ? 'done' : ''}">${p}</span>`).join('') : '';
  const viewOpts = game.players.map(p => `<option value="${p.id}" ${p.id === viewer ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  let net = '';
  if (online) {
    const link = inviteLink(online.code);
    if (online.role === 'host') {
      const n = online.host.connectedCount();
      net = `<button class="btn small chip-net hide-sm" data-copy="${esc(link)}" title="Copy invite link">Room ${online.code} · 👥 ${n}/${online.host.guests.length}</button>`;
    } else net = online.status === 'lost'
      ? `<button class="btn small warn" data-top="reconnect">⚠ Reconnect</button>`
      : `<span class="chip hide-sm">Room ${esc(online.code)} · connected</span>`;
  }
  const meOut = online && game.players[mySeat()] && game.players[mySeat()].lost;
  $('#topactions').innerHTML = `${net}
    ${over ? `<button class="btn primary" data-top="rematch">🔁 Rematch</button>` : ''}
    ${s.stage === 'play' && !over ? `<button class="btn ${myTurn ? 'primary' : ''}" data-top="next" title="Space">Next ▸</button>
    <button class="btn hide-sm" data-top="skipcombat">Skip combat</button>
    <button class="btn" data-top="endturn">End turn</button>` : ''}
    <button class="btn" data-top="undo" title="Ctrl+Z" ${game.canUndo() ? '' : 'disabled'}>↶<span class="hide-sm"> Undo</span></button>
    ${!over && !meOut && game.players.length > 1 ? `<button class="btn ghost hide-sm" data-top="forfeit" title="Forfeit this game">🏳 Forfeit</button>` : ''}
    ${online ? '' : `<select data-top="viewer" title="Whose hand is shown">${viewOpts}</select>`}
    <button class="btn" data-top="more" aria-label="More">☰</button>`;
}

// ---------------- playmats

const COLOR_HEX = { W: '#efe0a8', U: '#4b93dc', B: '#a08abf', R: '#e2603e', G: '#4fb06d' };

function accentColors(pl) {
  const setup = game.s.setup && game.s.setup.players[pl.id];
  const keys = setup ? setup.commanders : pl.zones.command.map(c => c.key);
  const ids = new Set();
  for (const k of keys) for (const c of ((game.db[k] || {}).color_identity || [])) ids.add(c);
  const cols = ['W', 'U', 'B', 'R', 'G'].filter(c => ids.has(c)).map(c => COLOR_HEX[c]);
  return cols.length ? cols : ['#c9a45c'];
}

function ringOf(cols) {
  if (cols.length === 1) return cols[0];
  const step = 360 / cols.length;
  return `conic-gradient(from -90deg, ${cols.map((c, i) => `${c} ${i * step}deg ${(i + 1) * step}deg`).join(', ')})`;
}

function pileHTML(pl, z, label, icon) {
  const arr = pl.zones[z];
  const n = arr.length;
  let face = '';
  if (z === 'library') face = n ? '<div class="pileback"></div>' : '';
  else if (n) {
    const f = game.face(arr[n - 1]);
    face = f.image ? `<img src="${f.image.small}" alt="${esc(f.name)}" loading="lazy">` : `<div class="textcard"><b>${esc(f.name)}</b></div>`;
  }
  return `<button class="pile ${z} ${n ? '' : 'none'}" data-act="${z === 'library' ? 'libmenu' : 'zone'}" data-z="${z}" title="${label}: ${n}">
    <span class="slot ${z === 'library' && n > 1 ? 'stacked' : ''}">${face}</span>
    <span class="plbl">${icon} ${label}</span><span class="pcount">${n}</span></button>`;
}

const MANA_KEYS = ['W', 'U', 'B', 'R', 'G', 'C'];
const MANA_NAMES = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green', C: 'Colorless' };

/** Mana tracker: floating pool (by type) + what untapped sources can still make. */
function manaHTML(pl) {
  const pool = pl.pool;
  const total = MANA_KEYS.reduce((n, k) => n + (pool[k] || 0), 0);
  const av = game.s.stage === 'play' ? game.availableMana(pl.id) : { total: 0, per: {} };
  const pips = MANA_KEYS.map(k => `<button class="mp ${k} ${pool[k] ? 'has' : ''}" data-act="mana" data-c="${k}"
      title="${MANA_NAMES[k]}: ${pool[k] || 0} in pool. Tap to add or remove." aria-label="${MANA_NAMES[k]} mana: ${pool[k] || 0}">
      <span class="ms">${k}</span><span class="mc">${pool[k] || 0}</span></button>`).join('');
  const can = MANA_KEYS.filter(k => av.per[k]).map(k => `<span class="mini ${k}" title="${MANA_NAMES[k]}">${k}</span>${av.per[k]}`).join(' ');
  return `<div class="mana ${total ? 'live' : ''}">
    <div class="mhead"><span class="mlbl">Mana pool</span><span class="mtot" title="Total floating mana">${total}</span>
      ${total ? '<button class="mclear" data-act="manaclear" title="Empty the pool">Clear</button>' : ''}</div>
    <div class="pips">${pips}</div>
    <div class="avail" title="Extra mana these untapped lands and mana sources could still make">${av.total
      ? `Untapped: <b>${av.total}</b> more <span class="can">${can}</span>`
      : '<span class="muted">No untapped mana sources</span>'}</div>
  </div>`;
}

function matHTML(pl, opp) {
  const s = game.s;
  const isActive = s.stage === 'play' && s.winner == null && s.active === pl.id;
  const bf = pl.zones.battlefield;
  const front = bf.filter(c => game.isCreature(c) || game.isType(c, 'Battle'));
  const rest = bf.filter(c => !front.includes(c));
  const lands = rest.filter(c => game.isType(c, 'Land'));
  const perms = rest.filter(c => !lands.includes(c));
  const cols = accentColors(pl);
  const me = pl.id === mySeat();
  const cmdr = Object.entries(pl.cmdrDmg).filter(([, d]) => d > 0)
    .map(([iid, d]) => `<span class="chip cmdr ${d >= 15 ? 'danger' : ''}" data-act="cmdrdmg" data-src="${iid}" title="Commander damage from ${esc(s.cmdrNames[iid])} (21 = loss)">⚔ ${esc(s.cmdrNames[iid])} ${d}</span>`).join('');
  const wins = (s.score || {})[pl.id] || 0;
  const frontRow = `<div class="row front" data-label="Creatures">${front.map(c => cardHTML(c, { bf: true })).join('')}</div>`;
  const backRow = `<div class="row back" data-label="Lands &amp; permanents">${perms.map(c => cardHTML(c, { bf: true })).join('')}${perms.length && lands.length ? '<span class="gap"></span>' : ''}${lands.map(c => cardHTML(c, { bf: true })).join('')}</div>`;
  return `<section class="mat ${opp ? 'opp' : 'mine'} ${isActive ? 'active' : ''} ${pl.lost ? 'lost' : ''}" data-pid="${pl.id}" style="--accent:${cols[0]}">
    <div class="plate">
      <div class="medal ${pl.life <= 10 ? 'low' : ''}" style="--ring:${ringOf(cols)}">
        <button class="lbtn minus" data-act="life" data-d="-1" aria-label="Lose 1 life">−</button>
        <span class="in" data-act="setlife" title="Set life total"><span class="lifeval">${pl.life}</span><span class="lifelbl">life</span></span>
        <button class="lbtn plus" data-act="life" data-d="1" aria-label="Gain 1 life">+</button>
      </div>
      <div class="pinfo">
        <div class="pname">${esc(pl.name)}${online && me ? ' <span class="you">you</span>' : ''}</div>
        <div class="tags">${isActive ? '<span class="tag">Active</span>' : ''}${pl.lost ? '<span class="tag out">Out</span>' : ''}${wins ? `<span class="tag wins" title="Games won this match">★ ${wins}</span>` : ''}</div>
        <div class="stats">
          <span class="chip" title="Cards in hand">✋ ${pl.zones.hand.length}</span>
          ${pl.poison ? `<span class="chip poison ${pl.poison >= 7 ? 'danger' : ''}" data-act="poison" title="Poison counters (10 = loss). Tap to remove one.">☣ ${pl.poison}</span>` : ''}
          ${cmdr}
        </div>
        <button class="small actions" data-act="pmenu">⋯ Actions</button>
      </div>
      ${manaHTML(pl)}
    </div>
    <div class="field">${opp ? backRow + frontRow : frontRow + backRow}</div>
    <div class="piles">
      <div class="pile command ${pl.zones.command.length ? '' : 'none'}" title="Command zone"><span class="slot cmd">${pl.zones.command.map(c => cardHTML(c, { bf: true })).join('')}</span><span class="plbl">♛ Command</span></div>
      ${pileHTML(pl, 'library', 'Library', '📚')}
      ${pileHTML(pl, 'graveyard', 'Graveyard', '🪦')}
      ${pileHTML(pl, 'exile', 'Exile', '⊘')}
    </div>
    ${pl.lost ? '<div class="outveil">Out of the game</div>' : ''}
  </section>`;
}

// ---------------- turn tracker (the band across the middle of the table)

const PHASE_GROUPS = [
  { name: 'Beginning', icon: '☀', steps: [0, 1, 2] },
  { name: 'Main 1', icon: '✦', steps: [3] },
  { name: 'Combat', icon: '⚔', steps: [4, 5, 6, 7, 8] },
  { name: 'Main 2', icon: '✦', steps: [9] },
  { name: 'End', icon: '☾', steps: [10, 11] },
];
const STEP_SHORT = ['Untap', 'Upkeep', 'Draw', 'Main', 'Begin', 'Attackers', 'Blockers', 'Damage', 'End', 'Main', 'End step', 'Cleanup'];
const STEP_HINT = {
  'Untap': 'Permanents untap.',
  'Upkeep': '"At the beginning of your upkeep" abilities happen now.',
  'Draw': 'The active player has drawn for the turn.',
  'Main 1': 'Play a land and cast creatures, sorceries, artifacts and enchantments.',
  'Beginning of Combat': 'Last chance for effects before attackers are chosen.',
  'Declare Attackers': 'Tap your creatures → ⚔ Attack, then press Next.',
  'Declare Blockers': 'Defending players tap their creatures → 🛡 Block, then Next.',
  'Combat Damage': 'Combat damage was dealt automatically. Check the log.',
  'End of Combat': '"End of combat" abilities happen now.',
  'Main 2': 'Play a land if you haven\'t yet, and cast more spells.',
  'End': '"At the beginning of the end step" abilities happen now.',
  'Cleanup': 'Discard down to 7 cards. Damage wears off.',
};

function trackerHTML() {
  const s = game.s;
  const bf = game.players.flatMap(p => p.zones.battlefield);
  const byDef = {};
  for (const c of bf) if (c.attacking != null) byDef[c.attacking] = (byDef[c.attacking] || 0) + 1;
  const chips = Object.entries(byDef).map(([d, n]) => `<span class="atk">⚔ ${n} attacking ${esc(game.players[d].name)}</span>`).join('')
    + (s.stack.length ? `<span class="stk">⧉ ${s.stack.length} on the stack</span>` : '');
  if (s.winner != null) return `<div class="tracker done"><div class="who">🏆 <b>${esc(game.players[s.winner].name)}</b> wins game ${s.match || 1}</div></div>`;
  if (s.stage === 'mulligan') return `<div class="tracker"><div class="who">🃏 <b>Mulligans</b>${(s.match || 1) > 1 ? ` · Game ${s.match}` : ''}</div><div class="hint">Each player keeps or mulligans their opening hand.</div></div>`;
  const act = game.players[s.active];
  const accent = accentColors(act)[0];
  const mine = online ? s.active === mySeat() : true;
  const step = PHASES[s.phase];
  const groups = PHASE_GROUPS.map(g => {
    const state = g.steps.includes(s.phase) ? 'on' : g.steps[g.steps.length - 1] < s.phase ? 'past' : 'next';
    return `<button class="grp ${state}" data-jump="${g.steps[0]}" ${state !== 'next' ? 'disabled' : ''} title="${state === 'next' ? `Skip ahead to ${g.name}` : g.name}">
      <span class="gi">${g.icon}</span><span class="gn">${g.name}</span></button>`;
  }).join('<span class="sep"></span>');
  const cur = PHASE_GROUPS.find(g => g.steps.includes(s.phase));
  const subs = cur.steps.length > 1 ? `<div class="subs">${cur.steps.map(i =>
    `<button class="sub ${i === s.phase ? 'on' : i < s.phase ? 'past' : 'next'}" data-jump="${i}" ${i <= s.phase ? 'disabled' : ''}>${STEP_SHORT[i]}</button>`).join('')}</div>` : '';
  const who = online && mine ? 'Your turn' : `${esc(act.name)}'s turn`;
  const hint = !mine && online ? `You can cast instants and use abilities. ${STEP_HINT[step]}` : STEP_HINT[step];
  return `<div class="tracker ${mine ? 'mine' : ''}" style="--accent:${accent}">
    <div class="who"><span class="dot"></span><b>${who}</b><span class="tn">Turn ${s.turn}</span>${chips}</div>
    <div class="groups">${groups}</div>
    ${subs}
    <div class="hint"><b>${esc(step)}</b> — ${esc(hint)}</div>
  </div>`;
}

/** Advance step by step until the given step (running every step's rules on the way). */
function jumpTo(target) {
  const turn = game.s.turn;
  run(async force => {
    if (online && game.s.active !== mySeat() && !force)
      throw new RuleError(`It's ${game.players[game.s.active].name}'s turn. Advance it for them anyway?`);
    for (let guard = 0; guard < 12 && game.s.turn === turn && game.s.phase < target && game.s.winner == null; guard++) {
      await game.nextStep({ force });
    }
  });
}

function renderBoard() {
  const opps = game.players.filter(p => p.id !== viewer);
  const me = game.players[viewer];
  $('#board').innerHTML = (opps.length ? `<div class="opps n${opps.length}">${opps.map(p => matHTML(p, true)).join('')}</div>` : '')
    + trackerHTML() + matHTML(me, false);
  renderWinner();
}

// ---------------- winner screen, forfeit, rematch

let dismissedMatch = null;

function renderWinner() {
  let el = $('#winner');
  const s = game.s;
  if (s.winner == null || dismissedMatch === s.match) { if (el) el.remove(); return; }
  if (!el) { el = document.createElement('div'); el.id = 'winner'; document.body.append(el); }
  const w = game.players[s.winner];
  const meWon = online ? s.winner === mySeat() : true;
  const scores = game.players.map(p => `<li class="${p.id === s.winner ? 'w' : ''}"><span>${esc(p.name)}</span><b>${(s.score || {})[p.id] || 0}</b></li>`).join('');
  el.innerHTML = `<div class="wcard" role="dialog" aria-label="Game over">
    <div class="trophy">🏆</div>
    <h2>${online ? (meWon ? 'Victory!' : `${esc(w.name)} wins`) : `${esc(w.name)} wins!`}</h2>
    <p class="muted">Game ${s.match || 1} of this match</p>
    <ul class="score">${scores}</ul>
    <div class="wbtns">
      <button class="btn primary" data-win="rematch">🔁 Rematch</button>
      <button class="btn" data-win="board">View board</button>
      <button class="btn ghost" data-win="leave">${online ? 'Leave' : 'New game'}</button>
    </div>
    <p class="muted small">${game.players.length === 2 ? 'Same decks. The loser goes first.' : 'Same decks. Random first player.'}</p>
  </div>`;
  el.onclick = e => {
    const b = e.target.closest('[data-win]');
    if (!b) return;
    if (b.dataset.win === 'rematch') rematch(true);
    if (b.dataset.win === 'board') { dismissedMatch = s.match; renderWinner(); }
    if (b.dataset.win === 'leave') leaveConfirm();
  };
}

async function rematch(skipConfirm = false) {
  if (!skipConfirm && !await confirmDlg('Start a rematch with the same players and decks?', 'Rematch')) return;
  run(() => game.rematch(mySeat()));
}

async function forfeit() {
  let pid = mySeat();
  const alive = game.players.filter(p => !p.lost);
  if (!online && alive.length > 1) {
    pid = alive.length === 1 ? alive[0].id : await choose('Who forfeits this game?', alive.map(p => ({ label: p.name, value: p.id })));
    if (pid == null) return;
  }
  const two = alive.length === 2;
  if (await confirmDlg(`${game.players[pid].name} forfeits this game?${two ? '\n\nThe other player wins. You can rematch right after.' : ''}`, '🏳 Forfeit')) run(() => game.concede(pid));
}

async function leaveConfirm() {
  const msg = online && online.role === 'host'
    ? 'Leave the game? You are the host — the game stops for everyone. (It stays saved; “Resume saved game” lets you host it again.)'
    : online ? 'Leave the game? You can rejoin later with the same link and name.' : 'Leave this game and set up a new one? (It stays saved until you start another.)';
  if (await confirmDlg(msg, 'Leave')) { const w = $('#winner'); if (w) w.remove(); leaveGame(); }
}

function renderHand() {
  const s = game.s;
  const pl = game.players[viewer];
  let notice = '';
  let controls = '';
  if (s.stage === 'mulligan') {
    if (!pl.kept) {
      controls = `<button class="btn" data-hand="mull">Mulligan</button><button class="btn primary" data-hand="keep">Keep ${pl.zones.hand.length}</button>`;
      notice = `<span class="notice">${pl.mulligans} mulligan${pl.mulligans === 1 ? '' : 's'} so far. Keep or mulligan?</span>`;
    } else if (pl.toBottom) notice = `<span class="notice">Tap ${pl.toBottom} card${pl.toBottom > 1 ? 's' : ''} to put on the bottom of your library.</span>`;
    else {
      const waiting = game.players.filter(p => !p.kept || p.toBottom).map(p => p.name);
      notice = `<span class="notice">Waiting for ${esc(waiting.join(', '))}${online ? '' : ' — switch “viewing” to them'}.</span>`;
    }
  } else if (PHASES[s.phase] === 'Cleanup' && s.active === pl.id && pl.zones.hand.length > 7) {
    notice = `<span class="notice">Discard ${pl.zones.hand.length - 7}: tap a card → To graveyard.</span>`;
  } else if (PHASES[s.phase] === 'Declare Blockers' && s.active !== viewer && game.players.flatMap(p => p.zones.battlefield).some(c => c.attacking === viewer)) {
    notice = '<span class="notice">You are being attacked: tap your untapped creatures → Block.</span>';
  }
  const hidden = handHidden;
  const bar = s.stage === 'play' && s.winner == null && !pl.lost ? `<div class="actionbar" role="toolbar" aria-label="Quick actions">
      <button class="qa primary" data-quick="draw" title="Draw a card (D)"><span class="qi">🂠</span>Draw</button>
      <button class="qa" data-quick="drawx" title="Draw several cards"><span class="qi">🂠+</span>Draw X</button>
      <button class="qa" data-quick="scry" title="Look at the top cards of your library"><span class="qi">👁</span>Scry</button>
      <button class="qa" data-quick="search" title="Search your library"><span class="qi">🔍</span>Search</button>
      <button class="qa" data-quick="shuffle" title="Shuffle your library"><span class="qi">🔀</span>Shuffle</button>
      <button class="qa" data-quick="mill" title="Mill cards"><span class="qi">🪦</span>Mill</button>
      <button class="qa" data-quick="token" title="Create a token"><span class="qi">⧉</span>Token</button>
      <button class="qa" data-quick="untap" title="Untap all your permanents"><span class="qi">⟳</span>Untap all</button>
      <button class="qa" data-quick="more" title="All player actions"><span class="qi">⋯</span>More</button>
    </div>` : '';
  $('#handbar').innerHTML = `<div class="panel">
    ${bar}
    <div class="handhead"><h3 style="margin:0">${online ? 'Your hand' : esc(pl.name) + "'s hand"} (${pl.zones.hand.length})</h3>
      ${controls}${notice}<span class="spacer"></span>
      ${online ? '' : `<button class="small" data-hand="hide">${hidden ? 'Show hand' : 'Hide hand'}</button>`}</div>
    <div class="hand">${pl.zones.hand.map(c => cardHTML(c, { size: 'hand ' + (s.stage === 'mulligan' && pl.toBottom ? 'selectable' : ''), hidden })).join('') || '<span class="empty">Empty hand</span>'}</div>
  </div>`;
}

function renderSide() {
  const st = game.s.stack;
  $('#stackpanel').classList.toggle('has-items', st.length > 0);
  $('#stackpanel').innerHTML = `<h3>The stack (${st.length})</h3>` + (st.length ? [...st].reverse().map((it, i) => {
    const f = game.face(it);
    const label = it.ability ? it.label : f.name;
    return `<div class="stackitem">${cardHTML(it)}<div class="stxt"><b>${esc(label)}</b>${it.x ? ` (X=${it.x})` : ''}<br>
      <span class="muted">${esc(game.players[it.controller].name)}${it.ability ? ' · ' + esc(it.text) : ''}</span>
      <div class="sbtns">${i === 0 ? `<button class="small" data-stack="resolve">Resolve</button>` : ''}<button class="small" data-stack="counter" data-iid2="${it.iid}">Counter</button></div></div></div>`;
  }).join('') : '<p class="muted" style="margin:0">Empty. Spells you cast wait here so others can respond.</p>');
  const log = $('#log');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.innerHTML = game.s.log.slice(-250).map(l => `<li class="${l.msg.startsWith('━━') ? 'turn' : l.msg.startsWith('💬') ? 'chat' : ''}">${symbols(l.msg)}</li>`).join('');
  if (atBottom || !log.dataset.init) { log.scrollTop = log.scrollHeight; log.dataset.init = '1'; }
}

// Several things can ask for a redraw during one action (the engine's change
// event, then the action wrapper). Coalesce them into a single redraw so the
// change-driven animations see each change exactly once.
let renderQueued = false;
function render() {
  if (renderQueued) return;
  renderQueued = true;
  queueMicrotask(() => { renderQueued = false; renderNow(); });
}

function renderNow() {
  if (!game || !game.s) return;
  if (autoViewer && game.s.stage === 'play' && game.s.active !== lastActive) {
    viewer = game.s.active;
    if (game.players.filter(p => !p.lost).length > 1) handHidden = true; // pass-and-play privacy
  }
  lastActive = game.s.active;
  renderTop(); renderBoard(); renderHand(); renderSide();
  animateChanges();
}

// ================================================================ animations
// After every render, compare with the previous state and animate only what
// changed: new cards, taps, life, piles, mana, phase and turn.

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
let anim = { ready: false };

function resetAnimations() { anim = { ready: false }; liveFx = []; }

function zoneKeyOf(el) {
  if (el.closest('.modal, #menu')) return null;
  if (el.closest('#handbar')) return 'hand';
  if (el.closest('.stackitem')) return 'stack';
  const mat = el.closest('.mat');
  if (!mat) return null;
  return `p${mat.dataset.pid}:${el.closest('.cmd') ? 'cmd' : 'bf'}`;
}

// Effects started in the last moment are re-applied if the screen is redrawn
// again right away (actions can trigger two redraws back to back).
const REAPPLY_MS = 200;
let liveFx = [];

function applyFx(fx) {
  for (const el of document.querySelectorAll(fx.sel)) {
    if (el.closest('.modal, #menu')) continue;
    if (fx.cls && !el.classList.contains(fx.cls)) el.classList.add(fx.cls);
    if (fx.float && !el.querySelector('.lifefx')) {
      const f = document.createElement('span');
      f.className = `lifefx ${fx.float.dir}`;
      f.textContent = fx.float.text;
      el.append(f);
    }
  }
}

function animateChanges() {
  if (!game || !game.s) return;
  const s = game.s;
  const now = Date.now();
  liveFx = liveFx.filter(f => f.until > now);
  const zones = new Map(), tapped = new Map();
  const cards = document.querySelectorAll('#game [data-iid]');
  for (const el of cards) {
    const key = zoneKeyOf(el);
    if (!key) continue;
    zones.set(el.dataset.iid, key);
    tapped.set(el.dataset.iid, el.classList.contains('tapped'));
  }
  const lives = {}, piles = {}, pools = {};
  for (const p of game.players) {
    lives[p.id] = p.life;
    piles[p.id] = { graveyard: p.zones.graveyard.length, exile: p.zones.exile.length, library: p.zones.library.length };
    pools[p.id] = { ...p.pool };
  }
  const turnKey = `${s.match || 1}:${s.turn}:${s.active}`;
  const fresh = [];
  const add = (sel, cls, float) => fresh.push({ sel, cls, float, until: now + REAPPLY_MS });

  if (anim.ready && !reducedMotion()) {
    for (const [id, key] of zones) {
      const sel = `#game [data-iid="${id}"]`;
      if (anim.zones.get(id) !== key) add(sel, key === 'hand' ? 'a-hand' : key === 'stack' ? 'a-stack' : key.endsWith('cmd') ? 'a-cmd' : 'a-bf');
      else if (anim.tapped.get(id) !== tapped.get(id)) add(sel, tapped.get(id) ? 'a-tap' : 'a-untap');
    }
    for (const p of game.players) {
      const mat = `.mat[data-pid="${p.id}"]`;
      const d = p.life - (anim.lives[p.id] ?? p.life);
      if (d) add(`${mat} .medal`, d < 0 ? 'a-hurt' : 'a-heal', { dir: d < 0 ? 'down' : 'up', text: (d > 0 ? '+' : '−') + Math.abs(d) });
      const prev = anim.piles[p.id] || {};
      for (const z of ['graveyard', 'exile']) if (piles[p.id][z] > (prev[z] ?? piles[p.id][z])) add(`${mat} .pile.${z}`, 'a-bump');
      if (piles[p.id].library < (prev.library ?? piles[p.id].library)) add(`${mat} .pile.library`, 'a-draw');
      const pp = anim.pools[p.id] || {};
      for (const k of Object.keys(pools[p.id])) if ((pools[p.id][k] || 0) > (pp[k] || 0)) add(`${mat} .mp.${k}`, 'a-pop');
    }
    if (anim.phase !== s.phase || anim.stage !== s.stage) {
      add('.tracker .grp.on', 'a-pop');
      add('.tracker .sub.on', 'a-pop');
      add('.tracker .hint', 'a-fade');
    }
    if (s.stage === 'play' && s.winner == null && anim.turnKey !== turnKey) turnBanner();
  }
  liveFx.push(...fresh);
  for (const fx of liveFx) applyFx(fx);
  anim = { ready: true, zones, tapped, lives, piles, pools, phase: s.phase, stage: s.stage, turnKey };
}

function turnBanner() {
  const s = game.s;
  const act = game.players[s.active];
  const mine = online ? s.active === mySeat() : false;
  document.getElementById('turnbanner')?.remove();
  const b = document.createElement('div');
  b.id = 'turnbanner';
  b.style.setProperty('--accent', accentColors(act)[0]);
  b.innerHTML = `<div class="tb-inner"><span class="tb-turn">Turn ${s.turn}</span><span class="tb-name">${mine ? 'Your turn' : esc(act.name)}</span></div>`;
  document.body.append(b);
  setTimeout(() => b.remove(), 1700);
}

// ---------------- boot screen

function hideBoot() {
  const b = document.getElementById('boot');
  if (!b) return;
  const minShow = reducedMotion() ? 200 : 4400;
  const wait = Math.max(0, minShow - (Date.now() - (window.__bootStart || Date.now())));
  const go = () => { if (!b.isConnected) return; b.classList.add('out'); setTimeout(() => b.remove(), 650); };
  b.addEventListener('click', go, { once: true });
  setTimeout(go, wait);
}

function showPreview(inst) {
  if (inst.hidden) return;
  const f = game.face(inst);
  const d = game.db[inst.key] || {};
  const img = f.image && f.image.normal;
  const fmt = FORMATS[game.s.format];
  const legal = d.legalities && fmt.legality ? d.legalities[fmt.legality] : null;
  const pt = f.power != null ? `<p><b>${esc(f.power)}/${esc(f.toughness)}</b></p>` : f.loyalty ? `<p>Loyalty ${esc(f.loyalty)}</p>` : '';
  $('#preview').innerHTML = `${img ? `<img class="big" src="${img}" alt="${esc(f.name)}">` : ''}
    <div class="ptext"><b>${esc(inst.ability ? inst.label : f.name)}</b> ${symbols(f.mana_cost || '')}
    <div class="ptype">${esc(f.type_line || '')}</div>
    ${inst.ability ? `<p><i>${esc(inst.text)}</i></p>` : `<p>${symbols(f.oracle_text || '')}</p>`}${pt}
    ${legal && legal !== 'legal' ? `<p style="color:var(--red)">${esc(legal.replace('_', ' '))} in ${esc(fmt.name)}</p>` : ''}
    ${d.scryfall_uri ? `<a href="${d.scryfall_uri}" target="_blank" rel="noopener">Rulings &amp; details on Scryfall ↗</a>` : ''}</div>`;
}

// ================================================================ card actions

function zoneTargets(inst, zone) {
  const opts = [['hand', 'To hand'], ['battlefield', 'To battlefield'], ['graveyard', 'To graveyard'], ['exile', 'To exile'],
    ['libTop', 'To top of library'], ['libBottom', 'To bottom of library']];
  if (inst.isCommander) opts.push(['command', 'To command zone']);
  return opts.filter(([z]) => z !== zone).map(([z, label]) => ({ label, fn: () => moveTo(inst, z) }));
}

function moveTo(inst, z) {
  if (z === 'libTop') return run(() => game.move(inst.iid, 'library', { pos: 'top' }));
  if (z === 'libBottom') return run(() => game.move(inst.iid, 'library', { pos: 'bottom' }));
  if (z === 'battlefield') return run(() => game.move(inst.iid, 'battlefield', { toPlayer: inst.owner }));
  run(() => game.move(inst.iid, z));
}

async function castFlow(inst, { ignoreCost = false } = {}) {
  const d = game.db[inst.key];
  let half = null;
  if (d.faces && d.faces.length > 1 && !d.faces[0].image && ['split', 'adventure', 'flip', 'omen'].includes(d.layout)) {
    const pick = await choose(`Cast which part of ${d.name}?`, d.faces.map((f, i) => ({
      html: `${esc(f.name)} ${symbols(f.mana_cost || '')} <span class="muted">${esc(f.type_line)}</span>`, value: i })));
    if (pick == null) return;
    if (pick > 0 || d.layout === 'split') half = { ...d.faces[pick], adventure: d.layout === 'adventure' && pick === 1 };
  }
  const f = half || game.face(inst);
  let x = 0;
  if (/\{X\}/.test(f.mana_cost || '')) { x = await askNumber('Choose a value for X', 1); if (x == null) return; }
  run(force => game.cast(inst.iid, { force, x, half, ignoreCost }));
}

async function tapForMana(inst) {
  const opts = manaOptions(game.face(inst));
  if (!opts.length) return toast('No simple mana ability found — add mana from the player ⋯ menu.');
  let o = opts[0];
  if (opts.length > 1) {
    o = await choose('Add which mana?', opts.map(op => ({ html: op.any ? 'One mana of any color' : Object.entries(op).map(([k, v]) => `<img class="sym" src="${symUrl(k)}">`.repeat(v)).join(''), value: op })));
    if (!o) return;
  }
  let color = null;
  if (o.any) {
    color = await choose('Which color?', COLORS.map(c => ({ html: `<img class="sym" src="${symUrl(c)}"> ${c}`, value: c })));
    if (!color) return;
  }
  run(force => game.tapForMana(inst.iid, o, color, { force }));
}

async function activateFlow(inst) {
  const abs = game.abilities(inst);
  if (!abs.length) return toast("No activated abilities found in this card's text.");
  const ab = abs.length === 1 ? abs[0] : await choose('Activate which ability?', abs.map(a => ({ html: `<b>${symbols(a.cost)}</b>: ${symbols(a.text)}`, value: a })));
  if (!ab) return;
  let x = 0;
  if (/\{X\}|X$/.test(ab.cost)) { x = await askNumber('Choose a value for X', 1); if (x == null) return; }
  run(force => game.activate(inst.iid, ab.i, { force, x }));
}

const ptPrompt = async (title, untilEot, inst) => {
  const v = await askText(title, '+1/+1');
  const m = v && v.match(/^([+-]?\d+)\s*\/\s*([+-]?\d+)$/);
  if (m) run(() => game.modifyPT(inst.iid, +m[1], +m[2], untilEot)); else if (v) toast('Use a format like +2/+0');
};

function cardMenu(inst, ev) {
  if (inst.hidden) return;
  const L = game.locate(inst.iid);
  if (!L) return;
  const f = game.face(inst);
  const s = game.s;
  const items = [{ header: (inst.ability ? inst.label : f.name) + (inst.token ? ' (token)' : '') }];
  const isLand = /\bLand\b/.test(f.type_line || '');
  const phase = PHASES[s.phase];
  const open = () => openMenu(items, ev.clientX, ev.clientY, inst);

  if (L.zone === 'stack') {
    if (s.stack[s.stack.length - 1].iid === inst.iid) items.push({ label: '✔ Resolve', fn: () => run(() => game.resolveTop()) });
    items.push({ label: '✖ Counter', fn: () => run(() => game.counterSpell(inst.iid)) });
    return open();
  }

  if (L.zone === 'hand' && s.stage === 'mulligan') {
    const pl = game.players[inst.owner];
    if (pl.kept && pl.toBottom) return run(() => game.bottomFromHand(pl.id, inst.iid));
  }

  if (L.zone === 'battlefield') {
    items.push({ label: inst.tapped ? 'Untap' : 'Tap', fn: () => run(() => game.toggleTap(inst.iid)) });
    if (manaOptions(f).length) items.push({ label: '◉ Tap for mana', fn: () => tapForMana(inst) });
    if (game.abilities(inst).length) items.push({ label: '⚡ Activate ability…', fn: () => activateFlow(inst) });
    if (game.isCreature(inst)) {
      if (inst.attacking != null) items.push({ label: 'Remove from attack', fn: () => run(force => game.declareAttack(inst.iid, null, { force })) });
      else if (phase === 'Declare Attackers' && inst.controller === s.active) {
        for (const p of game.players) if (p.id !== inst.controller && !p.lost)
          items.push({ label: `⚔ Attack ${p.name}`, fn: () => run(force => game.declareAttack(inst.iid, p.id, { force })) });
      }
      if (inst.blocking != null) items.push({ label: 'Stop blocking', fn: () => run(() => game.declareBlock(inst.iid, null)) });
      else if (phase === 'Declare Blockers') {
        const atk = game.players.flatMap(p => p.zones.battlefield).filter(a => a.attacking === inst.controller);
        for (const a of atk) items.push({ label: `🛡 Block ${game.face(a).name}`, fn: () => run(force => game.declareBlock(inst.iid, a.iid, { force })) });
      }
    }
    items.push('-');
    items.push({ label: '+1/+1 counter', fn: () => run(() => game.addCounter(inst.iid, '+1/+1', 1)) });
    items.push({ label: '−1/−1 counter', fn: () => run(() => game.addCounter(inst.iid, '-1/-1', 1)) });
    if (inst.counters.loyalty !== undefined) {
      items.push({ label: 'Loyalty +1', fn: () => run(() => game.addCounter(inst.iid, 'loyalty', 1)) });
      items.push({ label: 'Loyalty −1', fn: () => run(() => game.addCounter(inst.iid, 'loyalty', -1)) });
    }
    if (inst.counters.defense !== undefined) items.push({ label: 'Defense −1', fn: () => run(() => game.addCounter(inst.iid, 'defense', -1)) });
    items.push({ label: 'Other counter…', fn: async () => {
      const type = await askText('Counter type', 'charge', 'e.g. charge, time, lore, shield, oil, stun');
      if (!type) return;
      const n = await askNumber(`How many ${type} counters? (negative to remove)`, 1);
      if (n) run(() => game.addCounter(inst.iid, type, n));
    } });
    if (game.isCreature(inst)) {
      items.push({ label: 'Deal damage…', fn: async () => { const n = await askNumber('Damage to mark', 1); if (n != null) run(() => game.setDamage(inst.iid, inst.damage + n)); } });
      items.push({ label: 'Pump until end of turn…', fn: () => ptPrompt('Modify P/T until end of turn', true, inst) });
      items.push({ label: 'Give keyword until end of turn…', fn: async () => {
        const k = await choose('Keyword', ['Flying', 'Trample', 'Haste', 'Vigilance', 'Lifelink', 'Deathtouch', 'First strike', 'Double strike', 'Indestructible', 'Reach', 'Menace', 'Hexproof'].map(x => ({ label: x, value: x })));
        if (k) run(() => game.grantKeyword(inst.iid, k));
      } });
    }
    items.push({ label: 'Permanent P/T change…', fn: () => ptPrompt('Modify P/T (until it leaves)', false, inst) });
    if (game.hasFaces(inst)) items.push({ label: '⟲ Transform / flip', fn: () => run(() => game.transform(inst.iid)) });
    items.push({ label: 'Note / label…', fn: async () => { const t = await askText('Label (e.g. "copying Bear", "attached to X")', inst.note); if (t != null) run(() => game.setNote(inst.iid, t)); } });
    items.push({ label: 'Create token copy', fn: () => run(() => game.copyAsToken(inst.iid)) });
    if (game.players.length > 1) items.push({ label: 'Give control to…', fn: async () => {
      const p = await choose('New controller', game.players.filter(p => p.id !== inst.controller && !p.lost).map(p => ({ label: p.name, value: p.id })));
      if (p != null) run(() => game.changeControl(inst.iid, p));
    } });
    items.push('-', { label: 'Destroy / sacrifice (→ graveyard)', fn: () => moveTo(inst, 'graveyard') }, ...zoneTargets(inst, 'battlefield').filter(i => i.label !== 'To graveyard'));
    return open();
  }

  // hand / command / graveyard / exile
  if (isLand) items.push({ label: '▶ Play land', fn: () => run(force => game.playLand(inst.iid, { force })) });
  if (!isLand || (game.db[inst.key].faces || []).length > 1) {
    const tax = L.zone === 'command' && inst.isCommander ? game.commanderTax(inst) : 0;
    items.push({ label: `▶ Cast${tax ? ` (+{${tax}} commander tax)` : ''}`, fn: () => castFlow(inst) });
    items.push({ label: 'Cast without paying mana cost', fn: () => castFlow(inst, { ignoreCost: true }) });
  }
  if (game.abilities(inst).some(a => a.kind === 'activated')) items.push({ label: '⚡ Activate ability (cycling, etc.)…', fn: () => activateFlow(inst) });
  if (game.hasFaces(inst)) items.push({ label: '⟲ Turn over (other face)', fn: () => run(() => game.transform(inst.iid)) });
  items.push({ label: 'Put onto battlefield tapped', fn: () => run(() => game.move(inst.iid, 'battlefield', { tapped: true, toPlayer: inst.owner })) });
  items.push('-', ...zoneTargets(inst, L.zone));
  open();
}

// ================================================================ zone viewer

async function zoneView(pid, zone, { topN = null } = {}) {
  if (zone === 'library' && online && pid !== mySeat()) return toast("You can't look through another player's library.");
  if (zone === 'library' && !online && handHidden && pid === viewer) handHidden = false;
  let top = null;
  const fetchTop = async quiet => { if (topN) top = await game.peekTop(pid, topN, quiet); };
  try { await fetchTop(false); } catch (e) { return toast(e.message); }
  const m = openModal('', { wide: true, onClose: () => { game.onChange = render; render(); } });
  const draw = () => {
    const pl = game.players[pid];
    let cards = pl.zones[zone];
    if (zone === 'library') cards = topN ? top : [...cards].sort((a, b) => game.face(a).name.localeCompare(game.face(b).name));
    else cards = [...cards].reverse();
    const title = zone === 'library' ? (topN ? `Top ${topN} of ${pl.name}'s library (top first)` : `${pl.name}'s library (sorted by name)`) : `${pl.name}'s ${zone}`;
    m.el.innerHTML = `<h3>${esc(title)} — ${cards.length} card${cards.length === 1 ? '' : 's'}</h3>
      <p class="muted">Tap a card for options. ${zone === 'library' && !topN ? 'Shuffle after searching.' : ''}</p>
      <div class="grid">${cards.map(c => cardHTML(c)).join('') || '<span class="empty">Empty</span>'}</div>
      <div class="right">${zone === 'library' ? '<button class="btn" data-z="shuffle">Shuffle library</button>' : ''}<button class="btn primary" data-close>Done</button></div>`;
  };
  game.onChange = () => { render(); fetchTop(true).then(draw, () => {}); };
  draw();
  m.el.addEventListener('click', e => {
    if (e.target.closest('[data-z="shuffle"]')) { run(() => game.shuffleLibrary(pid)); return; }
    const c = e.target.closest('[data-iid]');
    if (!c) return;
    const L = game.locate(c.dataset.iid);
    const inst = L ? L.inst : (top || []).find(x => x.iid === +c.dataset.iid);
    if (!inst || inst.hidden) return;
    const items = [{ header: game.face(inst).name }];
    if (zone !== 'hand') items.push({ label: 'To hand', fn: () => moveTo(inst, 'hand') });
    items.push({ label: 'To battlefield', fn: () => moveTo(inst, 'battlefield') });
    items.push({ label: 'To battlefield tapped', fn: () => run(() => game.move(inst.iid, 'battlefield', { toPlayer: inst.owner, tapped: true })) });
    if (zone !== 'library') items.push({ label: '▶ Cast from here', fn: () => castFlow(inst) });
    for (const t of zoneTargets(inst, zone)) if (!['To hand', 'To battlefield'].includes(t.label)) items.push(t);
    e.stopPropagation();
    openMenu(items, e.clientX, e.clientY, inst);
  });
}

// ================================================================ tokens / add card

function tokenDialog(pid, tokensOnly = true) {
  const m = openModal(`<h3>${tokensOnly ? 'Create token' : 'Add any card'}</h3>
    <form class="row" style="margin:6px 0"><input class="inp" style="flex:1;min-width:160px" placeholder="${tokensOnly ? 'e.g. goblin, treasure, elf warrior' : 'card name or Scryfall query'}">
    <label style="flex-direction:row;align-items:center">×<input type="number" inputmode="numeric" class="qty" value="1" min="1" style="width:60px"></label>
    ${tokensOnly ? '' : '<select class="dest"><option value="hand">to hand</option><option value="battlefield">to battlefield</option><option value="library">to library top</option></select>'}
    <button class="btn primary">Search</button></form>
    ${tokensOnly ? '<details><summary class="muted">Or make a custom token</summary><div class="row"><input class="cname" placeholder="Name" value="Spirit"><input class="cpt" placeholder="P/T" value="1/1" style="width:70px"><input class="ctype" placeholder="Type" value="Creature — Spirit"><button type="button" class="btn" data-custom>Create</button></div></details>' : ''}
    <div class="grid results"><span class="muted">Search Scryfall's full database.</span></div>
    <div class="right"><button class="btn" data-close>Close</button></div>`, { wide: true });
  const inp = m.el.querySelector('input.inp');
  if (!isTouch()) inp.focus();
  let results = [];
  m.el.querySelector('form').addEventListener('submit', async e => {
    e.preventDefault();
    inp.blur();
    const box = m.el.querySelector('.results');
    box.innerHTML = '<span class="muted">Searching…</span>';
    try { results = await searchCards(inp.value || (tokensOnly ? '' : 'Sol Ring'), tokensOnly); }
    catch (err) { box.innerHTML = `<span class="muted">${esc(err.message)}</span>`; return; }
    box.innerHTML = results.map((c, i) => `<div class="card" data-r="${i}" title="${esc(c.name)}">${c.image ? `<img src="${c.image.small}" alt="${esc(c.name)}">` : `<div class="textcard"><b>${esc(c.name)}</b><i>${esc(c.type_line)}</i></div>`}</div>`).join('') || '<span class="muted">No results.</span>';
  });
  m.el.addEventListener('click', e => {
    const r = e.target.closest('[data-r]');
    const n = Math.max(1, +m.el.querySelector('.qty').value || 1);
    if (r) {
      const c = results[+r.dataset.r];
      const key = tokensOnly ? `token:${c.name}:${c.id}` : c.name;
      if (tokensOnly) run(() => game.createToken(pid, key, n, false, c));
      else { const dest = m.el.querySelector('.dest').value; run(async () => { for (let i = 0; i < n; i++) await game.addCardToZone(pid, key, dest, c); }); }
      toast(`Added ${n}× ${c.name}`);
    }
    if (e.target.closest('[data-custom]')) {
      const name = m.el.querySelector('.cname').value || 'Token';
      const [p, t] = (m.el.querySelector('.cpt').value || '').split('/');
      const type = m.el.querySelector('.ctype').value || 'Creature';
      const key = `custom:${name}:${p}/${t}:${type}`;
      const data = { name, type_line: 'Token ' + type, power: p, toughness: t, oracle_text: '', mana_cost: '', faces: [], keywords: [], legalities: {} };
      run(() => game.createToken(pid, key, n, false, data));
    }
  });
}

// ================================================================ player menu

function playerMenu(pid, ev) {
  const pl = game.players[pid];
  const mine = !online || pid === mySeat();
  const items = [{ header: pl.name },
    { label: 'Draw a card', fn: () => run(() => game.draw(pid, 1)) },
    { label: 'Draw X cards…', fn: async () => { const n = await askNumber('Draw how many?', 2); if (n > 0) run(() => game.draw(pid, n)); } },
  ];
  if (mine) items.push(
    { label: 'Look at / scry top X…', fn: async () => { const n = await askNumber('Look at how many from the top?', 1); if (n > 0) zoneView(pid, 'library', { topN: n }); } },
    { label: 'Search library', fn: () => zoneView(pid, 'library') });
  items.push(
    { label: 'Mill X…', fn: async () => { const n = await askNumber('Mill how many?', 1); if (n > 0) run(() => game.mill(pid, n)); } },
    { label: 'Shuffle library', fn: () => run(() => game.shuffleLibrary(pid)) },
    '-',
    { label: 'Create token…', fn: () => tokenDialog(pid, true) },
    { label: 'Add any card (emblems, dungeons, conjure)…', fn: () => tokenDialog(pid, false) },
    { label: 'Add mana to pool…', fn: async () => {
      const c = await choose('Add which mana?', ['W', 'U', 'B', 'R', 'G', 'C'].map(k => ({ html: `<img class="sym" src="${symUrl(k)}"> ${k}`, value: k })));
      if (!c) return;
      const n = await askNumber('How much?', 1);
      if (n) run(() => game.addMana(pid, c, n));
    } },
    { label: 'Untap all their permanents', fn: () => run(() => game.untapAll(pid)) },
    '-',
    { label: 'Set life total…', fn: async () => { const n = await askNumber('Life total', pl.life); if (n != null) run(() => game.setLife(pid, n)); } },
    { label: 'Poison +1', fn: () => run(() => game.poison(pid, 1)) },
    { label: 'Poison −1', fn: () => run(() => game.poison(pid, -1)) },
    { label: 'Commander damage…', fn: () => cmdrDamageDialog(pid) });
  if (mine) items.push(
    { label: 'Reveal hand to the table', fn: () => run(() => game.revealHand(pid)) },
    '-',
    { label: '🏳 Forfeit this game', fn: async () => { if (await confirmDlg(`${pl.name} forfeits this game?`, '🏳 Forfeit')) run(() => game.concede(pid)); } });
  openMenu(items, ev.clientX, ev.clientY);
}

async function cmdrDamageDialog(pid) {
  const srcs = Object.entries(game.s.cmdrNames).filter(([iid]) => { const L = game.locate(iid); return L && L.inst.owner !== pid; });
  if (!srcs.length) return toast('No opposing commanders in this game.');
  const src = await choose('Commander damage from…', srcs.map(([iid, n]) => ({ label: `${n} (now ${game.players[pid].cmdrDmg[iid] || 0})`, value: iid })));
  if (!src) return;
  const n = await askNumber('Add how much commander damage? (also reduces life; negative to correct)', 1);
  if (n) run(() => game.commanderDamage(pid, src, n));
}

// ================================================================ help, settings, more

function help() {
  openModal(`<h3>How to play</h3><div style="line-height:1.55">
  <p><b>Tap/click any card</b> for its actions. On a computer, <b>double-click</b> a hand card to cast/play it, or a permanent to tap it for mana. On a phone, use “🔍 Read card” in the menu to read a card.</p>
  <p><b>Turn flow:</b> press <b>Next ▸</b> (Space). The engine untaps, draws, empties mana pools between steps, deals combat damage and cleans up damage at end of turn.</p>
  <p><b>Casting:</b> costs are paid automatically from your mana pool and untapped lands/mana rocks; commander tax is added. Spells go on the stack — press <b>Resolve</b> once everyone has passed, then carry out the card's effect with the menus.</p>
  <p><b>Combat:</b> in Declare Attackers tap creatures → Attack. Next → defenders tap creatures → Block. Next deals damage (first/double strike, trample, deathtouch, lifelink, infect, toxic, commander damage).</p>
  <p><b>Automatic rules:</b> summoning sickness, timing, one land per turn, legend rule, lethal damage, 0 toughness/loyalty, 0 life, 10 poison, 21 commander damage, empty-library draws, commander → command zone, hand size.</p>
  <p><b>Rules checks</b> can be overridden (“Do it anyway”) for cards that change the rules. <b>Undo</b> reverts the last action.</p>
  <p><b>Online:</b> the host's browser runs the game, so the host must keep the page open. If you drop, reopen the invite link and join with the same name.</p></div>
  <div class="right"><button class="btn primary" data-close>Got it</button></div>`, { wide: true });
}

function settings() {
  const s = game.s.settings;
  const m = openModal(`<h3>Settings</h3>
    <label class="check"><input type="checkbox" class="c1" ${s.cmdrToCommandZone ? 'checked' : ''}> Move commander to the command zone when it would go to graveyard or exile</label>
    ${online ? '' : `<label class="check"><input type="checkbox" class="c2" ${autoViewer ? 'checked' : ''}> Switch to the active player's hand each turn (pass-and-play)</label>`}
    <div class="right"><button class="btn primary" data-close>Done</button></div>`);
  m.el.querySelector('.c1').addEventListener('change', e => run(() => game.setSetting('cmdrToCommandZone', e.target.checked)));
  const c2 = m.el.querySelector('.c2');
  if (c2) c2.addEventListener('change', e => { autoViewer = e.target.checked; });
}

function moreMenu(ev) {
  const s = game.s;
  const items = [{ header: 'Menu' }];
  if (s.winner != null) items.push({ label: '🔁 Rematch', fn: () => rematch() }, { label: '🏆 Show results', fn: () => { dismissedMatch = null; renderWinner(); } });
  if (s.stage === 'play' && s.winner == null) items.push({ label: 'Skip combat', fn: () => advance('skipCombat') });
  if (s.winner == null && game.players.length > 1 && !(online && game.players[mySeat()].lost)) items.push({ label: '🏳 Forfeit this game', fn: forfeit });
  if (online) items.push({ label: '🔗 Copy invite link', fn: () => copyText(inviteLink(online.code)) });
  items.push({ label: '⚙ Settings', fn: settings }, { label: '? How to play', fn: help }, '-',
    { label: online ? 'Leave game' : 'New game', fn: leaveConfirm });
  openMenu(items, ev.clientX, ev.clientY);
}

// ================================================================ quick actions

async function quickAction(kind, pid, ev) {
  const pl = game.players[pid];
  switch (kind) {
    case 'draw': return run(() => game.draw(pid, 1));
    case 'drawx': { const n = await askNumber('Draw how many cards?', 2); if (n > 0) run(() => game.draw(pid, n)); return; }
    case 'scry': { const n = await askNumber('Look at how many cards from the top?', 1, 'Then tap each card to keep it on top, put it on the bottom, or move it elsewhere.'); if (n > 0) zoneView(pid, 'library', { topN: n }); return; }
    case 'search': return zoneView(pid, 'library');
    case 'shuffle': return run(() => game.shuffleLibrary(pid));
    case 'mill': { const n = await askNumber('Mill how many cards?', 1); if (n > 0) run(() => game.mill(pid, n)); return; }
    case 'token': return tokenDialog(pid, true);
    case 'untap': return run(() => game.untapAll(pid));
    case 'more': return playerMenu(pid, ev);
  }
  return pl;
}

function libraryMenu(pid, ev) {
  const pl = game.players[pid];
  const mine = !online || pid === mySeat();
  const n = pl.zones.library.length;
  const items = [{ header: `${pl.name}'s library · ${n} card${n === 1 ? '' : 's'}` },
    { label: '🂠 Draw a card', fn: () => run(() => game.draw(pid, 1)) },
    { label: '🂠 Draw X cards…', fn: () => quickAction('drawx', pid, ev) }];
  if (mine) items.push(
    { label: '👁 Scry / look at top X…', fn: () => quickAction('scry', pid, ev) },
    { label: '🔍 Search library', fn: () => zoneView(pid, 'library') });
  items.push(
    { label: '🔀 Shuffle', fn: () => run(() => game.shuffleLibrary(pid)) },
    { label: '🪦 Mill X…', fn: () => quickAction('mill', pid, ev) });
  openMenu(items, ev.clientX, ev.clientY);
}

// ================================================================ events

document.addEventListener('click', e => {
  if (e.target.closest('#menu')) return;
  closeMenu();
  const copy = e.target.closest('[data-copy]');
  if (copy && copy.closest('#topbar')) return copyText(copy.dataset.copy);
  if (!game || $('#game').hidden) return;

  const top = e.target.closest('[data-top]');
  if (top && top.tagName === 'BUTTON') {
    const a = top.dataset.top;
    if (a === 'next') advance('nextStep');
    if (a === 'endturn') advance('endTurn');
    if (a === 'skipcombat') advance('skipCombat');
    if (a === 'undo') run(() => game.undo());
    if (a === 'more') moreMenu(e);
    if (a === 'forfeit') forfeit();
    if (a === 'rematch') rematch();
    if (a === 'reconnect') online.guest.reconnect().then(() => { online.status = 'connected'; render(); }, err => toast(err.message));
    return;
  }

  const jump = e.target.closest('[data-jump]');
  if (jump && !jump.disabled) return jumpTo(+jump.dataset.jump);

  const quick = e.target.closest('[data-quick]');
  if (quick) return quickAction(quick.dataset.quick, viewer, e);

  const hand = e.target.closest('[data-hand]');
  if (hand) {
    const a = hand.dataset.hand;
    if (a === 'mull') run(() => game.mulligan(viewer));
    if (a === 'keep') run(() => game.keep(viewer));
    if (a === 'hide') { handHidden = !handHidden; render(); }
    return;
  }

  const st = e.target.closest('[data-stack]');
  if (st) {
    if (st.dataset.stack === 'resolve') run(() => game.resolveTop());
    else run(() => game.counterSpell(st.dataset.iid2));
    return;
  }

  const cardEl = e.target.closest('[data-iid]');
  if (cardEl && cardEl.closest('#game')) {
    const L = game.locate(cardEl.dataset.iid);
    if (L) { if (!isTouch()) showPreview(L.inst); cardMenu(L.inst, e); }
    return;
  }

  const actEl = e.target.closest('[data-act]');
  const panel = e.target.closest('[data-pid]');
  if (actEl && panel) {
    const pid = +panel.dataset.pid;
    const a = actEl.dataset.act;
    if (a === 'life') run(() => game.life(pid, +actEl.dataset.d));
    if (a === 'setlife') askNumber('Life total', game.players[pid].life).then(n => n != null && run(() => game.setLife(pid, n)));
    if (a === 'poison') run(() => game.poison(pid, -1));
    if (a === 'unmana') run(() => game.addMana(pid, actEl.dataset.c, -1));
    if (a === 'manaclear') run(() => game.clearPool(pid));
    if (a === 'mana') {
      const c = actEl.dataset.c;
      const have = game.players[pid].pool[c] || 0;
      const name = MANA_NAMES[c];
      openMenu([{ header: `${name} mana · ${have} in pool` },
        { label: `+1 ${name}`, fn: () => run(() => game.addMana(pid, c, 1)) },
        { label: `+2 ${name}`, fn: () => run(() => game.addMana(pid, c, 2)) },
        { label: `+3 ${name}`, fn: () => run(() => game.addMana(pid, c, 3)) },
        { label: `−1 ${name}`, disabled: !have, fn: () => run(() => game.addMana(pid, c, -1)) },
        { label: `Remove all ${name}`, disabled: !have, fn: () => run(() => game.addMana(pid, c, -have)) },
      ], e.clientX, e.clientY);
    }
    if (a === 'cmdrdmg') cmdrDamageDialog(pid);
    if (a === 'zone') zoneView(pid, actEl.dataset.z);
    if (a === 'libmenu') libraryMenu(pid, e);
    if (a === 'pmenu') playerMenu(pid, e);
  }
});

document.addEventListener('dblclick', e => {
  if (!game || isTouch()) return;
  const el = e.target.closest('#game [data-iid]');
  if (!el) return;
  closeMenu();
  const L = game.locate(el.dataset.iid);
  if (!L || L.inst.hidden) return;
  const inst = L.inst;
  const f = game.face(inst);
  if (L.zone === 'hand' || L.zone === 'command') {
    if (game.s.stage !== 'play') return;
    if (/\bLand\b/.test(f.type_line)) run(force => game.playLand(inst.iid, { force }));
    else castFlow(inst);
  } else if (L.zone === 'battlefield') {
    if (manaOptions(f).length && !inst.tapped) tapForMana(inst);
    else run(() => game.toggleTap(inst.iid));
  }
});

document.addEventListener('change', e => {
  if (e.target.matches('[data-top="viewer"]')) { viewer = +e.target.value; handHidden = false; render(); }
});

document.addEventListener('mouseover', e => {
  if (!game || !game.s || isTouch()) return;
  const el = e.target.closest('[data-iid]');
  if (!el) return;
  const L = game.locate(el.dataset.iid);
  if (L) showPreview(L.inst);
});

document.addEventListener('keydown', e => {
  if (!game || $('#game').hidden || e.target.closest('input, textarea, select') || $('#modal-root').children.length) return;
  if (e.code === 'Space') { e.preventDefault(); advance('nextStep'); }
  if (e.key === 'd' || e.key === 'D') { if (!e.ctrlKey && !e.metaKey && game.s.stage === 'play') quickAction('draw', viewer, e); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); run(() => game.undo()); }
  if (e.key === 'Escape') closeMenu();
});

$('#chatform').addEventListener('submit', e => {
  e.preventDefault();
  const inp = $('#chatinput');
  const t = inp.value.trim();
  if (!t || !game) return;
  inp.value = '';
  run(() => game.chat(mySeat(), t));
});

window.addEventListener('beforeunload', e => {
  if (online && online.role === 'host' && game) { e.preventDefault(); e.returnValue = ''; }
});

// Debug hook for automated tests: open the page with ?debug
if (new URLSearchParams(location.search).has('debug')) window.__mtg = () => ({ game, online, viewer, anim });

renderSetup();
bindSetup();
hideBoot();
window.__appReady = true;
