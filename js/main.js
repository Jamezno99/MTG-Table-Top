// main.js — UI: setup screen, board rendering, menus and dialogs.
import { fetchCards, searchCards } from './scryfall.js';
import { parseDecklist, validateDeck, FORMATS, manaOptions, SAMPLE_DECKS, COLORS } from './rules.js';
import { Game, PHASES, RuleError } from './game.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const symUrl = s => `https://svgs.scryfall.io/card-symbols/${encodeURIComponent(s.replace(/\//g, '').toUpperCase())}.svg`;
const symbols = t => esc(t).replace(/\{([^}]+)\}/g, (m, s) => `<img class="sym" alt="{${s}}" title="{${s}}" src="${symUrl(s)}">`).replace(/\n/g, '<br>');

let game = null;
let viewer = 0;          // whose hand is shown (pass-and-play)
let lastActive = null;
let autoViewer = true;
let handHidden = false;

// ================================================================ dialogs

function openModal(html, { wide = false, onClose } = {}) {
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
    const first = m.el.querySelector('[data-i]'); if (first) first.focus();
  });
}

function ask(title, def = '', type = 'number', hint = '') {
  return new Promise(res => {
    const m = openModal(`<h3>${esc(title)}</h3>${hint ? `<p class="muted">${esc(hint)}</p>` : ''}<form>
      <input class="inp" type="${type}" value="${esc(def)}">
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
  setTimeout(() => t.remove(), 3800);
}

/** Runs an engine action; on a rules violation, offers to do it anyway. */
async function run(fn) {
  try { fn(false); }
  catch (e) {
    if (e instanceof RuleError) {
      if (await confirmDlg(`⚖  Rules check\n\n${e.message}`, 'Do it anyway', 'Cancel')) {
        try { fn(true); } catch (e2) { toast(e2.message); }
      }
    } else { console.error(e); toast(e.message); }
  }
  render();
}

// ================================================================ menu

function openMenu(items, x, y) {
  const m = $('#menu');
  m.innerHTML = items.map((it, i) => it === '-' ? '<hr>' : it.header ? `<div class="mh">${esc(it.header)}</div>`
    : `<button data-i="${i}" ${it.disabled ? 'disabled' : ''}>${esc(it.label)}</button>`).join('');
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
  m.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
  m.onclick = e => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    closeMenu();
    items[+b.dataset.i].fn();
  };
}
function closeMenu() { $('#menu').hidden = true; }

// ================================================================ setup screen

const deckText = {};

function renderSetup() {
  const fmt = $('#format');
  fmt.innerHTML = Object.entries(FORMATS).map(([k, f]) => `<option value="${k}">${esc(f.name)}</option>`).join('');
  fmt.value = 'commander';
  $('#resume').hidden = !Game.hasSave();
  renderDeckBoxes();
}

function renderDeckBoxes() {
  const n = +$('#playercount').value;
  const boxes = [];
  for (let i = 0; i < n; i++) {
    const saved = deckText[i] ?? (() => { try { return localStorage.getItem('mtgsim-deck-' + i) || ''; } catch { return ''; } })();
    const name = (() => { try { return localStorage.getItem('mtgsim-name-' + i) || `Player ${i + 1}`; } catch { return `Player ${i + 1}`; } })();
    boxes.push(`<div class="deckbox" data-p="${i}">
      <label>Name <input class="pname-in" value="${esc(name)}"></label>
      <textarea placeholder="Commander&#10;1 Atraxa, Praetors' Voice&#10;&#10;Deck&#10;1 Sol Ring&#10;1 Command Tower&#10;…">${esc(saved)}</textarea>
      <div class="samples">Sample: ${Object.keys(SAMPLE_DECKS).map(k => `<button class="small" data-sample="${esc(k)}">${esc(k)}</button>`).join('')}</div>
    </div>`);
  }
  $('#decks').innerHTML = boxes.join('');
}

function bindSetup() {
  $('#playercount').addEventListener('change', () => { saveDeckInputs(); renderDeckBoxes(); });
  $('#decks').addEventListener('click', e => {
    const b = e.target.closest('[data-sample]');
    if (!b) return;
    const box = b.closest('.deckbox');
    box.querySelector('textarea').value = SAMPLE_DECKS[b.dataset.sample];
    $('#format').value = 'commander';
  });
  $('#start').addEventListener('click', startFromSetup);
  $('#resume').addEventListener('click', () => {
    const g = Game.load();
    if (!g) { toast('No saved game found.'); return; }
    startGame(g);
  });
}

function saveDeckInputs() {
  document.querySelectorAll('.deckbox').forEach(box => {
    const i = +box.dataset.p;
    deckText[i] = box.querySelector('textarea').value;
    try {
      localStorage.setItem('mtgsim-deck-' + i, deckText[i]);
      localStorage.setItem('mtgsim-name-' + i, box.querySelector('.pname-in').value);
    } catch { /* ignore */ }
  });
}

async function startFromSetup() {
  saveDeckInputs();
  const format = $('#format').value;
  const boxes = [...document.querySelectorAll('.deckbox')];
  const decks = boxes.map(box => ({
    name: box.querySelector('.pname-in').value.trim() || `Player ${+box.dataset.p + 1}`,
    parsed: parseDecklist(box.querySelector('textarea').value),
  }));
  if (decks.some(d => !d.parsed.main.length && !d.parsed.commanders.length)) { toast('Every player needs a decklist.'); return; }
  const names = decks.flatMap(d => [...d.parsed.main, ...d.parsed.commanders, ...d.parsed.side].map(e => e.name));
  const btn = $('#start');
  btn.disabled = true;
  let lookup;
  try { lookup = await fetchCards(names, msg => { $('#progress').textContent = msg; }); }
  catch (e) { toast('Could not reach Scryfall: ' + e.message); btn.disabled = false; $('#progress').textContent = ''; return; }
  btn.disabled = false;
  $('#progress').textContent = '';

  let anyErr = false;
  const report = decks.map(d => {
    const r = validateDeck(d.parsed, lookup, format);
    d.report = r;
    if (r.errors.length) anyErr = true;
    const id = r.identity && r.identity.length ? ` · color identity ${r.identity.map(c => `<img class="sym" src="${symUrl(c)}" alt="${c}">`).join('')}` : '';
    return `<div class="pblock"><b>${esc(d.name)}</b>: ${r.errors.length
      ? `<span class="err">${r.errors.length} problem${r.errors.length > 1 ? 's' : ''}</span><ul>${r.errors.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`
      : `<span class="ok">deck is legal in ${esc(FORMATS[format].name)}</span>${id}`}
      ${r.warnings.length ? `<ul class="muted">${r.warnings.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</div>`;
  }).join('');
  $('#report').innerHTML = report;
  if (anyErr && !await confirmDlg('Some decks are not legal (see the report).\n\nStart anyway? Cards that could not be found will be left out.', 'Start anyway', 'Fix decks')) return;

  const db = {};
  const toEntries = list => list.map(e => { const c = lookup(e.name); if (!c) return null; db[c.name] = c; return { key: c.name, qty: e.qty }; }).filter(Boolean);
  const players = decks.map(d => ({
    name: d.name,
    main: toEntries(d.parsed.main),
    commanders: format === 'commander' || format === 'freeform' ? toEntries(d.parsed.commanders).map(e => e.key) : [],
  }));
  if (format !== 'commander' && format !== 'freeform') {
    decks.forEach((d, i) => players[i].main.push(...toEntries(d.parsed.commanders)));
  }
  startGame(Game.create({ format, players, db }));
}

function startGame(g) {
  game = g;
  game.onChange = render;
  viewer = game.s.stage === 'mulligan' ? 0 : game.s.active;
  lastActive = game.s.active;
  $('#setup').hidden = true;
  $('#game').hidden = false;
  render();
}

// ================================================================ rendering

function cardHTML(inst, { size = '', bf = false, hidden = false } = {}) {
  if (hidden) return `<div class="card back ${size}"></div>`;
  const f = game.face(inst);
  const cls = ['card', size];
  if (inst.tapped) cls.push('tapped');
  const isCr = game.isCreature(inst);
  if (bf && isCr && inst.sick && !game.kw(inst, 'Haste')) cls.push('sick');
  if (inst.attacking != null) cls.push('attacking');
  if (inst.blocking != null) cls.push('blocking');
  if (inst.isCommander) cls.push('cmdr');
  const src = f.image && (size === 'hand' ? f.image.normal : f.image.small);
  const body = src
    ? `<img src="${src}" alt="${esc(f.name)}" loading="lazy" draggable="false">`
    : `<div class="textcard"><b>${esc(f.name)}</b><span>${symbols(f.mana_cost || '')}</span><i>${esc(f.type_line || '')}</i><small>${esc((f.oracle_text || '').slice(0, 160))}</small>${f.power != null ? `<b>${esc(f.power)}/${esc(f.toughness)}</b>` : ''}</div>`;
  let badges = '';
  if (bf || inst.ability) {
    if (isCr && !inst.ability) {
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
  $('#turninfo').innerHTML = s.stage === 'mulligan' ? 'Mulligans' : `Turn ${s.turn} · <span style="color:var(--gold-2)">${esc(act.name)}</span>`;
  $('#phases').innerHTML = s.stage === 'play' ? PHASES.map((p, i) =>
    `<span class="phase ${i === s.phase ? 'on' : i < s.phase ? 'done' : ''}">${p}</span>`).join('') : '';
  const viewOpts = game.players.map(p => `<option value="${p.id}" ${p.id === viewer ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  $('#topactions').innerHTML = `
    ${s.stage === 'play' && s.winner == null ? `<button class="btn primary" data-top="next" title="Space">Next step ▸</button>
    <button class="btn" data-top="skipcombat">Skip combat</button>
    <button class="btn" data-top="endturn">End turn</button>` : ''}
    <button class="btn" data-top="undo" title="Ctrl+Z" ${game.undoStack.length ? '' : 'disabled'}>↶ Undo</button>
    <select data-top="viewer" title="Whose hand is shown">${viewOpts}</select>
    <button class="btn" data-top="settings">⚙</button>
    <button class="btn" data-top="help">?</button>
    <button class="btn ghost" data-top="new">New game</button>`;
}

function playerHTML(pl) {
  const s = game.s;
  const isActive = s.stage === 'play' && s.active === pl.id;
  const bf = pl.zones.battlefield;
  const lands = bf.filter(c => game.isType(c, 'Land') && !game.isCreature(c));
  const others = bf.filter(c => !lands.includes(c));
  const cmdr = Object.entries(pl.cmdrDmg).filter(([, d]) => d > 0)
    .map(([iid, d]) => `<span class="chip cmdr" data-act="cmdrdmg" data-src="${iid}" title="Commander damage (21 = loss)">⚔ ${esc(s.cmdrNames[iid])}: ${d}</span>`).join('');
  const pool = ['W', 'U', 'B', 'R', 'G', 'C'].filter(k => pl.pool[k] > 0)
    .map(k => `<span class="m" data-act="unmana" data-c="${k}" title="Click to remove one"><img class="sym" src="${symUrl(k)}" alt="${k}">${pl.pool[k]}</span>`).join('');
  return `<section class="player ${isActive ? 'active' : ''} ${pl.lost ? 'lost' : ''} ${pl.id === viewer ? 'viewer' : ''}" data-pid="${pl.id}">
    <div class="phead">
      <span class="pname">${esc(pl.name)}</span>
      ${isActive ? '<span class="tag">Active</span>' : ''}${pl.lost ? '<span class="tag" style="background:var(--red)">Out</span>' : ''}
      <span class="life">
        <button class="small" data-act="life" data-d="-1">−</button>
        <span class="lifeval" data-act="setlife" title="Click to set life">${pl.life}</span>
        <button class="small" data-act="life" data-d="1">+</button>
      </span>
      ${pl.poison ? `<span class="chip poison" data-act="poison" title="Poison (10 = loss)">☣ ${pl.poison}</span>` : ''}
      ${cmdr}
      ${pool ? `<span class="pool" title="Mana pool (empties between steps)">${pool}</span>` : ''}
      <span class="zbtns">
        <button class="small" data-act="zone" data-z="library">Library ${pl.zones.library.length}</button>
        <span class="chip" title="Cards in hand">✋ ${pl.zones.hand.length}</span>
        <button class="small" data-act="zone" data-z="graveyard">Graveyard ${pl.zones.graveyard.length}</button>
        <button class="small" data-act="zone" data-z="exile">Exile ${pl.zones.exile.length}</button>
        <button class="small" data-act="pmenu">⋯ Actions</button>
      </span>
    </div>
    <div class="zones">
      <div class="cmdzone"><span class="lbl">Command</span>${pl.zones.command.map(c => cardHTML(c, { bf: true })).join('') || '<span class="muted" style="font-size:10px">—</span>'}</div>
      <div class="bf">
        <div class="bfrow">${others.map(c => cardHTML(c, { bf: true })).join('') || '<span class="empty">No creatures or other permanents</span>'}</div>
        <div class="bfrow lands">${lands.map(c => cardHTML(c, { bf: true })).join('') || '<span class="empty">No lands</span>'}</div>
      </div>
    </div>
  </section>`;
}

function renderBoard() {
  const order = [...game.players.filter(p => p.id !== viewer), game.players[viewer]];
  const win = game.s.winner != null ? `<div class="panel winner">🏆 ${esc(game.players[game.s.winner].name)} wins!</div>` : '';
  $('#board').innerHTML = win + order.map(playerHTML).join('');
}

function renderHand() {
  const s = game.s;
  const pl = game.players[viewer];
  let notice = '';
  let controls = '';
  if (s.stage === 'mulligan') {
    if (!pl.kept) {
      controls = `<button class="btn" data-hand="mull">Mulligan</button><button class="btn primary" data-hand="keep">Keep ${pl.zones.hand.length}</button>`;
      notice = `<span class="notice">${esc(pl.name)}: ${pl.mulligans} mulligan${pl.mulligans === 1 ? '' : 's'} so far. Keep or mulligan?</span>`;
    } else if (pl.toBottom) notice = `<span class="notice">Click ${pl.toBottom} card${pl.toBottom > 1 ? 's' : ''} to put on the bottom of your library.</span>`;
    else {
      const waiting = game.players.filter(p => !p.kept || p.toBottom).map(p => p.name);
      notice = `<span class="notice">Waiting for ${esc(waiting.join(', '))} — switch “viewing” to them.</span>`;
    }
  } else if (PHASES[s.phase] === 'Cleanup' && s.active === pl.id && pl.zones.hand.length > 7) {
    notice = `<span class="notice">Discard ${pl.zones.hand.length - 7}: click a card → To graveyard.</span>`;
  } else if (PHASES[s.phase] === 'Declare Attackers' && s.active === viewer) {
    notice = '<span class="notice">Click your creatures → Attack. Then press Next step.</span>';
  } else if (PHASES[s.phase] === 'Declare Blockers' && s.active !== viewer) {
    notice = '<span class="notice">Click your untapped creatures → Block.</span>';
  }
  const hidden = handHidden;
  $('#handbar').innerHTML = `<div class="panel">
    <div class="handhead"><h3 style="margin:0">${esc(pl.name)}'s hand (${pl.zones.hand.length})</h3>
      ${controls}${notice}<span class="spacer"></span>
      <button class="small" data-hand="hide">${hidden ? 'Show hand' : 'Hide hand'}</button></div>
    <div class="hand">${pl.zones.hand.map(c => cardHTML(c, { size: 'hand ' + (s.stage === 'mulligan' && pl.toBottom ? 'selectable' : ''), hidden })).join('') || '<span class="empty">Empty hand</span>'}</div>
  </div>`;
}

function renderSide() {
  const st = game.s.stack;
  $('#stackpanel').innerHTML = `<h3>The stack (${st.length})</h3>` + (st.length ? [...st].reverse().map((it, i) => {
    const f = game.face(it);
    const label = it.ability ? it.label : f.name;
    return `<div class="stackitem">${cardHTML(it, { bf: false })}<div class="stxt"><b>${esc(label)}</b>${it.x ? ` (X=${it.x})` : ''}<br>
      <span class="muted">${esc(game.players[it.controller].name)}${it.ability ? ' · ' + esc(it.text) : ''}</span>
      <div class="sbtns">${i === 0 ? `<button class="small" data-stack="resolve">Resolve</button>` : ''}<button class="small" data-stack="counter" data-iid2="${it.iid}">Counter</button></div></div></div>`;
  }).join('') : '<p class="muted" style="margin:0">Empty. Spells you cast wait here so others can respond.</p>');
  $('#log').innerHTML = game.s.log.slice(-250).map(l => `<li class="${l.msg.startsWith('━━') ? 'turn' : ''}">${symbols(l.msg)}</li>`).join('');
  const log = $('#log');
  log.scrollTop = log.scrollHeight;
}

function render() {
  if (!game) return;
  if (autoViewer && game.s.stage === 'play' && game.s.active !== lastActive) {
    viewer = game.s.active;
    if (game.players.filter(p => !p.lost).length > 1 && game.players.length > 1) handHidden = true; // pass-and-play privacy
  }
  lastActive = game.s.active;
  renderTop(); renderBoard(); renderHand(); renderSide();
}

function showPreview(inst) {
  const f = game.face(inst);
  const d = game.db[inst.key] || {};
  const img = f.image && f.image.normal;
  const legal = d.legalities && FORMATS[game.s.format].legality ? d.legalities[FORMATS[game.s.format].legality] : null;
  const pt = f.power != null ? `<p><b>${esc(f.power)}/${esc(f.toughness)}</b></p>` : f.loyalty ? `<p>Loyalty ${esc(f.loyalty)}</p>` : '';
  $('#preview').innerHTML = `${img ? `<img class="big" src="${img}" alt="${esc(f.name)}">` : ''}
    <div class="ptext"><b>${esc(f.name)}</b> ${symbols(f.mana_cost || '')}
    <div class="ptype">${esc(f.type_line || '')}</div>
    ${inst.ability ? `<p><i>${esc(inst.text)}</i></p>` : `<p>${symbols(f.oracle_text || '')}</p>`}${pt}
    ${legal && legal !== 'legal' ? `<p class="err" style="color:var(--red)">${esc(legal.replace('_', ' '))} in ${esc(FORMATS[game.s.format].name)}</p>` : ''}
    ${d.scryfall_uri ? `<a href="${d.scryfall_uri}" target="_blank" rel="noopener">Rulings &amp; details on Scryfall ↗</a>` : ''}</div>`;
}

// ================================================================ card actions

function zoneTargets(inst) {
  const L = game.locate(inst.iid);
  const opts = [['hand', 'To hand'], ['battlefield', 'To battlefield'], ['graveyard', 'To graveyard'], ['exile', 'To exile'],
    ['libTop', 'To top of library'], ['libBottom', 'To bottom of library']];
  if (inst.isCommander) opts.push(['command', 'To command zone']);
  return opts.filter(([z]) => z !== L.zone).map(([z, label]) => ({ label, fn: () => moveTo(inst, z) }));
}

function moveTo(inst, z) {
  if (z === 'libTop') return run(() => game.move(inst.iid, 'library', { pos: 'top' }));
  if (z === 'libBottom') return run(() => game.move(inst.iid, 'library', { pos: 'bottom' }));
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
  if (!abs.length) return toast('No activated abilities found in this card\'s text.');
  const ab = abs.length === 1 ? abs[0] : await choose('Activate which ability?', abs.map(a => ({ html: `<b>${symbols(a.cost)}</b>: ${symbols(a.text)}`, value: a })));
  if (!ab) return;
  let x = 0;
  if (/\{X\}|X$/.test(ab.cost)) { x = await askNumber('Choose a value for X', 1); if (x == null) return; }
  run(force => game.activate(inst.iid, ab.i, { force, x }));
}

function cardMenu(inst, ev) {
  const L = game.locate(inst.iid);
  if (!L) return;
  const f = game.face(inst);
  const s = game.s;
  const items = [{ header: f.name + (inst.token ? ' (token)' : '') }];
  const isLand = /\bLand\b/.test(f.type_line || '');
  const phase = PHASES[s.phase];

  if (L.zone === 'stack') {
    if (s.stack[s.stack.length - 1].iid === inst.iid) items.push({ label: '✔ Resolve', fn: () => run(() => game.resolveTop()) });
    items.push({ label: '✖ Counter', fn: () => run(() => game.counterSpell(inst.iid)) });
    return openMenu(items, ev.clientX, ev.clientY);
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
      items.push({ label: 'Pump until end of turn…', fn: async () => {
        const v = await askText('Modify P/T until end of turn', '+1/+1');
        const m = v && v.match(/^([+-]?\d+)\s*\/\s*([+-]?\d+)$/);
        if (m) run(() => game.modifyPT(inst.iid, +m[1], +m[2], true)); else if (v) toast('Use a format like +2/+0');
      } });
      items.push({ label: 'Give keyword until end of turn…', fn: async () => {
        const k = await choose('Keyword', ['Flying', 'Trample', 'Haste', 'Vigilance', 'Lifelink', 'Deathtouch', 'First strike', 'Double strike', 'Indestructible', 'Reach', 'Menace', 'Hexproof'].map(x => ({ label: x, value: x })));
        if (k) run(() => game.grantKeyword(inst.iid, k));
      } });
    }
    items.push({ label: 'Permanent P/T change…', fn: async () => {
      const v = await askText('Modify P/T (until it leaves)', '+1/+1');
      const m = v && v.match(/^([+-]?\d+)\s*\/\s*([+-]?\d+)$/);
      if (m) run(() => game.modifyPT(inst.iid, +m[1], +m[2], false));
    } });
    if (game.hasFaces(inst)) items.push({ label: '⟲ Transform / flip', fn: () => run(() => game.transform(inst.iid)) });
    items.push({ label: 'Note / label…', fn: async () => { const t = await askText('Label (e.g. "copying Bear", "attached to X")', inst.note); if (t != null) run(() => game.setNote(inst.iid, t)); } });
    items.push({ label: 'Create token copy', fn: () => run(() => game.copyAsToken(inst.iid)) });
    if (game.players.length > 1) items.push({ label: 'Give control to…', fn: async () => {
      const p = await choose('New controller', game.players.filter(p => p.id !== inst.controller && !p.lost).map(p => ({ label: p.name, value: p.id })));
      if (p != null) run(() => game.changeControl(inst.iid, p));
    } });
    items.push('-', { label: 'Destroy / sacrifice (→ graveyard)', fn: () => moveTo(inst, 'graveyard') }, ...zoneTargets(inst).filter(i => i.label !== 'To graveyard'));
    return openMenu(items, ev.clientX, ev.clientY);
  }

  // hand / command / graveyard / exile / library
  if (isLand) items.push({ label: '▶ Play land', fn: () => run(force => game.playLand(inst.iid, { force })) });
  if (!isLand || (game.db[inst.key].faces || []).length > 1) {
    const tax = L.zone === 'command' && inst.isCommander ? game.commanderTax(inst) : 0;
    items.push({ label: `▶ Cast${tax ? ` (+{${tax}} commander tax)` : ''}`, fn: () => castFlow(inst) });
    items.push({ label: 'Cast without paying mana cost', fn: () => castFlow(inst, { ignoreCost: true }) });
  }
  if (game.abilities(inst).some(a => a.kind === 'activated')) items.push({ label: '⚡ Activate ability (cycling, etc.)…', fn: () => activateFlow(inst) });
  if (game.hasFaces(inst)) items.push({ label: '⟲ Turn over (other face)', fn: () => run(() => game.transform(inst.iid)) });
  items.push({ label: 'Put onto battlefield tapped', fn: () => run(() => game.move(inst.iid, 'battlefield', { tapped: true, toPlayer: inst.owner })) });
  items.push('-', ...zoneTargets(inst));
  openMenu(items, ev.clientX, ev.clientY);
}

// ================================================================ zone viewer

function zoneView(pid, zone, { topN = null } = {}) {
  const pl = game.players[pid];
  const draw = () => {
    let cards = pl.zones[zone];
    if (zone === 'library') cards = topN ? cards.slice(-topN).reverse() : [...cards].sort((a, b) => game.face(a).name.localeCompare(game.face(b).name));
    else cards = [...cards].reverse();
    const title = zone === 'library' ? (topN ? `Top ${topN} of ${pl.name}'s library (top first)` : `${pl.name}'s library (sorted by name — order hidden)`) : `${pl.name}'s ${zone}`;
    m.el.innerHTML = `<h3>${esc(title)} — ${cards.length} card${cards.length === 1 ? '' : 's'}</h3>
      <p class="muted">Click a card for options. ${zone === 'library' && !topN ? 'Remember to shuffle after searching.' : ''}</p>
      <div class="grid">${cards.map(c => cardHTML(c)).join('') || '<span class="empty">Empty</span>'}</div>
      <div class="right">${zone === 'library' ? '<button class="btn" data-z="shuffle">Shuffle library</button>' : ''}<button class="btn primary" data-close>Done</button></div>`;
  };
  const m = openModal('', { wide: true, onClose: () => { game.onChange = render; render(); } });
  game.onChange = () => { render(); draw(); };
  draw();
  m.el.addEventListener('click', e => {
    if (e.target.closest('[data-z="shuffle"]')) { run(() => game.shuffleLibrary(pid)); return; }
    const c = e.target.closest('[data-iid]');
    if (!c) return;
    const L = game.locate(c.dataset.iid);
    if (!L) return;
    const inst = L.inst;
    const items = [{ header: game.face(inst).name }];
    if (zone !== 'hand') items.push({ label: 'To hand', fn: () => moveTo(inst, 'hand') });
    items.push({ label: 'To battlefield', fn: () => run(() => game.move(inst.iid, 'battlefield', { toPlayer: inst.owner })) });
    items.push({ label: 'To battlefield tapped', fn: () => run(() => game.move(inst.iid, 'battlefield', { toPlayer: inst.owner, tapped: true })) });
    if (zone !== 'library') items.push({ label: '▶ Cast from here', fn: () => castFlow(inst) });
    for (const t of zoneTargets(inst)) if (!['To hand', 'To battlefield'].includes(t.label)) items.push(t);
    e.stopPropagation();
    openMenu(items, e.clientX, e.clientY);
  });
}

// ================================================================ tokens / add card

function tokenDialog(pid, tokensOnly = true) {
  const m = openModal(`<h3>${tokensOnly ? 'Create token' : 'Add any card'}</h3>
    <form class="row" style="margin:6px 0"><input class="inp" style="flex:1" placeholder="${tokensOnly ? 'e.g. goblin, treasure, 1/1 elf warrior' : 'card name or Scryfall query'}" autofocus>
    <label style="flex-direction:row;align-items:center">×<input type="number" class="qty" value="1" min="1" style="width:60px"></label>
    ${tokensOnly ? '' : '<select class="dest"><option value="hand">to hand</option><option value="battlefield">to battlefield</option><option value="library">to library top</option></select>'}
    <button class="btn primary">Search</button></form>
    ${tokensOnly ? '<details><summary class="muted">Or make a custom token</summary><div class="row"><input class="cname" placeholder="Name" value="Spirit"><input class="cpt" placeholder="P/T" value="1/1" style="width:70px"><input class="ctype" placeholder="Type" value="Creature — Spirit"><button type="button" class="btn" data-custom>Create</button></div></details>' : ''}
    <div class="grid results"><span class="muted">Search Scryfall's full database.</span></div>
    <div class="right"><button class="btn" data-close>Close</button></div>`, { wide: true });
  const inp = m.el.querySelector('input.inp');
  inp.focus();
  let results = [];
  m.el.querySelector('form').addEventListener('submit', async e => {
    e.preventDefault();
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
      const key = (tokensOnly ? 'token:' : '') + c.name + (tokensOnly ? ':' + c.id : '');
      game.db[key] = c;
      if (tokensOnly) run(() => game.createToken(pid, key, n));
      else for (let i = 0; i < n; i++) run(() => game.addCardToZone(pid, key, m.el.querySelector('.dest').value));
      toast(`Added ${n}× ${c.name}`);
    }
    if (e.target.closest('[data-custom]')) {
      const name = m.el.querySelector('.cname').value || 'Token';
      const [p, t] = (m.el.querySelector('.cpt').value || '').split('/');
      const type = m.el.querySelector('.ctype').value || 'Creature';
      const key = `custom:${name}:${p}/${t}:${type}`;
      game.db[key] = { name, type_line: 'Token ' + type, power: p, toughness: t, oracle_text: '', mana_cost: '', faces: [], keywords: [], legalities: {} };
      run(() => game.createToken(pid, key, n));
    }
  });
}

// ================================================================ player menu

function playerMenu(pid, ev) {
  const pl = game.players[pid];
  const items = [{ header: pl.name },
    { label: 'Draw a card', fn: () => run(() => game.draw(pid, 1)) },
    { label: 'Draw X cards…', fn: async () => { const n = await askNumber('Draw how many?', 2); if (n > 0) run(() => game.draw(pid, n)); } },
    { label: 'Look at / scry top X…', fn: async () => { const n = await askNumber('Look at how many from the top?', 1); if (n > 0) zoneView(pid, 'library', { topN: n }); } },
    { label: 'Search library', fn: () => zoneView(pid, 'library') },
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
    { label: 'Untap all my permanents', fn: () => run(() => game.untapAll(pid)) },
    '-',
    { label: 'Set life total…', fn: async () => { const n = await askNumber('Life total', pl.life); if (n != null) run(() => game.setLife(pid, n)); } },
    { label: 'Poison +1', fn: () => run(() => game.poison(pid, 1)) },
    { label: 'Poison −1', fn: () => run(() => game.poison(pid, -1)) },
    { label: 'Commander damage…', fn: () => cmdrDamageDialog(pid) },
    { label: 'Reveal hand to the table', fn: () => {
      openModal(`<h3>${esc(pl.name)} reveals their hand</h3><div class="grid">${pl.zones.hand.map(c => cardHTML(c)).join('') || '<span class="empty">Empty</span>'}</div><div class="right"><button class="btn primary" data-close>Done</button></div>`, { wide: true });
    } },
    '-',
    { label: 'Concede', fn: async () => { if (await confirmDlg(`${pl.name} concedes?`, 'Concede')) run(() => game.concede(pid)); } },
  ];
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

// ================================================================ help & settings

function help() {
  openModal(`<h3>How to play</h3><div style="line-height:1.55">
  <p><b>Click any card</b> for its actions. <b>Double-click</b> a hand card to cast/play it, or a permanent to tap it for mana (or tap/untap).</p>
  <p><b>Turn flow:</b> use <b>Next step</b> (Space). The engine untaps, draws, empties mana pools between steps, deals combat damage and cleans up damage at end of turn.</p>
  <p><b>Casting:</b> costs are paid automatically from your mana pool and untapped lands/mana rocks; commander tax is added. Spells go on the stack — hit <b>Resolve</b> when everyone has passed. Then carry out the card's effect with the menus (draw, destroy, tokens, counters…).</p>
  <p><b>Combat:</b> in Declare Attackers click creatures → Attack. Next step → defenders click creatures → Block. Next step deals damage (first/double strike, trample, deathtouch, lifelink, infect, toxic, commander damage).</p>
  <p><b>Automatic rules:</b> summoning sickness, timing (sorcery vs instant/flash), one land per turn, legend rule, lethal damage, 0 toughness/loyalty, 0 life, 10 poison, 21 commander damage, drawing from an empty library, commander → command zone, hand size.</p>
  <p><b>Rules checks</b> can be overridden ("Do it anyway") for cards that change the rules. <b>Undo</b> with Ctrl+Z.</p>
  <p><b>Pass-and-play:</b> the hand of the active player is hidden at the start of each turn. Use “viewing” to switch hands.</p></div>
  <div class="right"><button class="btn primary" data-close>Got it</button></div>`, { wide: true });
}

function settings() {
  const s = game.s.settings;
  const m = openModal(`<h3>Settings</h3>
    <label style="flex-direction:row;gap:8px;align-items:center;color:var(--text)"><input type="checkbox" class="c1" ${s.cmdrToCommandZone ? 'checked' : ''}> Move commander to the command zone when it would go to graveyard or exile</label>
    <label style="flex-direction:row;gap:8px;align-items:center;color:var(--text);margin-top:8px"><input type="checkbox" class="c2" ${autoViewer ? 'checked' : ''}> Switch to the active player's hand each turn (pass-and-play)</label>
    <div class="right"><button class="btn primary" data-close>Done</button></div>`);
  m.el.querySelector('.c1').addEventListener('change', e => run(() => game.setSetting('cmdrToCommandZone', e.target.checked)));
  m.el.querySelector('.c2').addEventListener('change', e => { autoViewer = e.target.checked; });
}

// ================================================================ events

document.addEventListener('click', e => {
  if (e.target.closest('#menu')) return;
  closeMenu();
  if (!game || $('#game').hidden) return;

  const top = e.target.closest('[data-top]');
  if (top && top.tagName === 'BUTTON') {
    const a = top.dataset.top;
    if (a === 'next') run(force => game.nextStep({ force }));
    if (a === 'endturn') run(force => game.endTurn({ force }));
    if (a === 'skipcombat') run(() => game.skipCombat());
    if (a === 'undo') { game.undo(); render(); }
    if (a === 'help') help();
    if (a === 'settings') settings();
    if (a === 'new') confirmDlg('Leave this game and set up a new one? (The current game stays saved until you start another.)', 'New game').then(ok => {
      if (!ok) return;
      game = null;
      $('#game').hidden = true; $('#setup').hidden = false;
      renderSetup();
    });
    return;
  }

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
    if (L) cardMenu(L.inst, e);
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
    if (a === 'cmdrdmg') cmdrDamageDialog(pid);
    if (a === 'zone') zoneView(pid, actEl.dataset.z);
    if (a === 'pmenu') playerMenu(pid, e);
  }
});

document.addEventListener('dblclick', e => {
  if (!game) return;
  const el = e.target.closest('#game [data-iid]');
  if (!el) return;
  closeMenu();
  const L = game.locate(el.dataset.iid);
  if (!L) return;
  const inst = L.inst;
  const f = game.face(inst);
  if (L.zone === 'hand' || L.zone === 'command') {
    if (game.s.stage !== 'play') return;
    if (/\bLand\b/.test(f.type_line)) run(force => game.playLand(inst.iid, { force }));
    else castFlow(inst);
  } else if (L.zone === 'battlefield') {
    const opts = manaOptions(f);
    if (opts.length && !inst.tapped) tapForMana(inst);
    else run(() => game.toggleTap(inst.iid));
  }
});

document.addEventListener('change', e => {
  if (e.target.matches('[data-top="viewer"]')) { viewer = +e.target.value; handHidden = false; render(); }
});

document.addEventListener('mouseover', e => {
  if (!game) return;
  const el = e.target.closest('[data-iid]');
  if (!el) return;
  const L = game.locate(el.dataset.iid);
  if (L) showPreview(L.inst);
});

document.addEventListener('keydown', e => {
  if (!game || $('#game').hidden || e.target.closest('input, textarea, select') || $('#modal-root').children.length) return;
  if (e.code === 'Space') { e.preventDefault(); run(force => game.nextStep({ force })); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); game.undo(); render(); }
  if (e.key === 'Escape') closeMenu();
});

renderSetup();
bindSetup();
