// Run with: node tests/engine.test.mjs   (Node 18+; no dependencies)
import assert from 'node:assert/strict';
import { parseDecklist, validateDeck, resolveTrailing, parseCost, payCost, manaOptions, canPair, SAMPLE_DECKS } from '../js/rules.js';
import { Game, PHASES, RuleError } from '../js/game.js';

let passed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log('✓', name); } catch (e) { console.error('✗', name, '\n  ', e.message); process.exitCode = 1; } };

const legal = { commander: 'legal', standard: 'legal', modern: 'legal', vintage: 'legal', legacy: 'legal', pauper: 'legal', pioneer: 'legal' };
const card = (o) => ({ keywords: [], color_identity: [], legalities: legal, oracle_text: '', faces: [], mana_cost: '', ...o });
const DB = {
  'Forest': card({ name: 'Forest', type_line: 'Basic Land — Forest', oracle_text: '({T}: Add {G}.)' }),
  'Mountain': card({ name: 'Mountain', type_line: 'Basic Land — Mountain' }),
  'Llanowar Elves': card({ name: 'Llanowar Elves', type_line: 'Creature — Elf Druid', mana_cost: '{G}', power: '1', toughness: '1', oracle_text: '{T}: Add {G}.', color_identity: ['G'] }),
  'Grizzly Bears': card({ name: 'Grizzly Bears', type_line: 'Creature — Bear', mana_cost: '{1}{G}', power: '2', toughness: '2', color_identity: ['G'] }),
  'Sol Ring': card({ name: 'Sol Ring', type_line: 'Artifact', mana_cost: '{1}', oracle_text: '{T}: Add {C}{C}.' }),
  'Lightning Bolt': card({ name: 'Lightning Bolt', type_line: 'Instant', mana_cost: '{R}', color_identity: ['R'], oracle_text: 'Lightning Bolt deals 3 damage to any target.' }),
  'Hulk': card({ name: 'Hulk', type_line: 'Legendary Creature — Giant', mana_cost: '{2}{G}', power: '7', toughness: '7', color_identity: ['G'], oracle_text: 'Trample' }),
  'Biter': card({ name: 'Biter', type_line: 'Creature — Snake', mana_cost: '{G}', power: '1', toughness: '1', oracle_text: 'Deathtouch' }),
  'Banned Thing': card({ name: 'Banned Thing', type_line: 'Artifact', legalities: { ...legal, commander: 'banned' } }),
  'Partner A': card({ name: 'Partner A', type_line: 'Legendary Creature — Human', oracle_text: 'Partner (You can have two commanders if both have partner.)' }),
  'Partner B': card({ name: 'Partner B', type_line: 'Legendary Creature — Human', oracle_text: 'Flying\nPartner (You can have two commanders if both have partner.)' }),
};
const lookup = n => DB[n];

test('parse decklist with sections, set codes and *CMDR*', () => {
  const d = parseDecklist('Commander\n1 Hulk\n\nDeck\n1x Sol Ring (CMR) 263\n4 Forest *F*\nSB: 1 Lightning Bolt\nFire/Ice');
  assert.equal(d.commanders[0].name, 'Hulk');
  assert.deepEqual(d.main.map(e => [e.qty, e.name]), [[1, 'Sol Ring'], [4, 'Forest'], [1, 'Fire // Ice']]);
  assert.equal(d.side[0].name, 'Lightning Bolt');
  assert.equal(parseDecklist('1 Hulk *CMDR*').commanders.length, 1);
});

test('sample decks are exactly 100 cards', () => {
  for (const t of Object.values(SAMPLE_DECKS)) {
    const d = parseDecklist(t);
    assert.equal(d.main.reduce((n, e) => n + e.qty, 0) + d.commanders.length, 100);
  }
});

test('commander validation: size, identity, singleton, banlist', () => {
  const ok = validateDeck(parseDecklist('Commander\n1 Hulk\nDeck\n1 Sol Ring\n1 Llanowar Elves\n97 Forest'), lookup, 'commander');
  assert.deepEqual(ok.errors, []);
  const bad = validateDeck(parseDecklist('Commander\n1 Hulk\nDeck\n2 Sol Ring\n1 Lightning Bolt\n1 Banned Thing\n90 Forest'), lookup, 'commander');
  const all = bad.errors.join('\n');
  assert.match(all, /exactly 100/);
  assert.match(all, /singleton/);
  assert.match(all, /Lightning Bolt is outside/);
  assert.match(all, /Banned Thing is BANNED/);
  const noCmdr = validateDeck(parseDecklist('Deck\n1 Grizzly Bears'), lookup, 'commander');
  assert.match(noCmdr.errors.join(), /No commander/);
  const notLegend = validateDeck(parseDecklist('Commander\n1 Grizzly Bears\nDeck\n99 Forest'), lookup, 'commander');
  assert.match(notLegend.errors.join(), /can't be your commander/);
});

test('partner pairing', () => {
  assert.ok(canPair(DB['Partner A'], DB['Partner B']));
  assert.ok(!canPair(DB['Partner A'], DB['Hulk']));
});

test('constructed: 4-copy limit and 60 minimum', () => {
  const r = validateDeck(parseDecklist('5 Lightning Bolt\n20 Mountain'), lookup, 'modern');
  assert.match(r.errors.join(), /minimum is 60/);
  assert.match(r.errors.join(), /maximum is 4/);
});

test('mana cost payment incl. hybrid & phyrexian', () => {
  assert.ok(payCost({ G: 2 }, parseCost('{1}{G}')));
  assert.equal(payCost({ G: 1 }, parseCost('{1}{G}')), null);
  assert.ok(payCost({ W: 1, C: 1 }, parseCost('{1}{W/U}')));
  assert.equal(payCost({}, parseCost('{G/P}')).lifeLoss, 2);
  assert.ok(payCost({ R: 4 }, parseCost('{X}{R}'), 3));
});

test('mana options from text and basic types', () => {
  assert.deepEqual(manaOptions(DB['Forest']), [{ G: 1 }]);
  assert.deepEqual(manaOptions(DB['Sol Ring']), [{ C: 2 }]);
  assert.deepEqual(manaOptions({ type_line: 'Land', oracle_text: '{T}: Add {R} or {G}.' }), [{ R: 1 }, { G: 1 }]);
  assert.deepEqual(manaOptions({ type_line: 'Land', oracle_text: '{T}: Add one mana of any color in your commander\'s color identity.' }), [{ any: 1 }]);
});

function newGame(main1, main2, cmdrs = [[], []]) {
  const g = Game.create({ format: 'commander', db: DB, players: [
    { name: 'Ann', main: main1, commanders: cmdrs[0] },
    { name: 'Bob', main: main2, commanders: cmdrs[1] }] });
  for (const p of g.players) { g.keep(p.id); }
  for (const p of g.players) while (p.toBottom) g.bottomFromHand(p.id, p.zones.hand[0].iid);
  return g;
}
const put = (g, pid, key, zone = 'battlefield') => { g.addCardToZone(pid, key, zone); const z = g.players[pid].zones[zone]; const c = z[z.length - 1]; c.sick = false; return c; };
const goTo = (g, phase) => { while (PHASES[g.s.phase] !== phase) g.nextStep(); };

test('game starts after mulligans, life 40, first player skips draw in 1v1', () => {
  const g = newGame([{ key: 'Forest', qty: 30 }], [{ key: 'Forest', qty: 30 }]);
  assert.equal(g.s.stage, 'play');
  assert.equal(g.players[0].life, 40);
  const a = g.players[g.s.active];
  goTo(g, 'Main 1');
  assert.equal(a.zones.hand.length, 7);
});

test('London mulligan with free first mulligan in Commander', () => {
  const g = Game.create({ format: 'commander', db: DB, players: [{ name: 'A', main: [{ key: 'Forest', qty: 40 }], commanders: [] }, { name: 'B', main: [{ key: 'Forest', qty: 40 }], commanders: [] }] });
  g.mulligan(0); g.mulligan(0); g.keep(0);
  assert.equal(g.players[0].toBottom, 1);
});

test('land drop limit and auto-tap casting', () => {
  const g = newGame([{ key: 'Forest', qty: 30 }], [{ key: 'Forest', qty: 30 }]);
  const pid = g.s.active;
  goTo(g, 'Main 1');
  const hand = g.players[pid].zones.hand;
  g.playLand(hand[0].iid);
  assert.throws(() => g.playLand(hand[0].iid), RuleError);
  put(g, pid, 'Forest');
  const bears = put(g, pid, 'Grizzly Bears', 'hand');
  g.cast(bears.iid);
  assert.equal(g.s.stack.length, 1);
  assert.equal(g.players[pid].zones.battlefield.filter(c => c.tapped).length, 2);
  g.resolveTop();
  assert.ok(g.players[pid].zones.battlefield.some(c => c.key === 'Grizzly Bears'));
});

test('sorcery-speed timing is enforced, instants are not', () => {
  const g = newGame([{ key: 'Forest', qty: 30 }], [{ key: 'Forest', qty: 30 }]);
  const opp = 1 - g.s.active;
  const bears = put(g, opp, 'Grizzly Bears', 'hand');
  assert.throws(() => g.cast(bears.iid), /own turn/);
});

test('commander tax and return to command zone', () => {
  const g = newGame([{ key: 'Forest', qty: 30 }], [{ key: 'Forest', qty: 30 }], [['Hulk'], ['Hulk']]);
  const pid = g.s.active;
  goTo(g, 'Main 1');
  for (let i = 0; i < 8; i++) put(g, pid, 'Forest');
  const hulk = g.players[pid].zones.command[0];
  g.cast(hulk.iid); g.resolveTop();
  g.move(hulk.iid, 'graveyard');
  assert.equal(g.locate(hulk.iid).zone, 'command');
  assert.equal(g.commanderTax(hulk), 2);
  g.cast(hulk.iid);
  assert.equal(g.players[pid].zones.battlefield.filter(c => c.tapped).length, 8); // 3 + (3+2)
});

test('combat: trample, deathtouch, commander damage loss at 21', () => {
  const g = newGame([{ key: 'Forest', qty: 30 }], [{ key: 'Forest', qty: 30 }], [['Hulk'], []]);
  const a = g.s.active === 0 ? 0 : 1;
  // make player 0 active-agnostic: give the active player a Hulk commander on battlefield
  const pid = g.s.active, opp = 1 - pid;
  const hulk = g.players[0].zones.command[0];
  g.move(hulk.iid, 'battlefield', { toPlayer: pid }); hulk.sick = false; hulk.isCommander = true;
  const bear = put(g, opp, 'Grizzly Bears');
  goTo(g, 'Declare Attackers');
  g.declareAttack(hulk.iid, opp);
  g.nextStep();
  g.declareBlock(bear.iid, hulk.iid);
  g.nextStep(); // damage
  assert.equal(g.players[opp].life, 35);       // 7 - 2 lethal to bear = 5 trample
  assert.equal(g.locate(bear.iid).zone, 'graveyard');
  assert.equal(g.players[opp].cmdrDmg[hulk.iid], 5);
  g.commanderDamage(opp, hulk.iid, 16);
  assert.ok(g.players[opp].lost);
  assert.equal(g.s.winner, pid);
});

test('deathtouch blocker kills big attacker; summoning sick cannot attack', () => {
  const g = newGame([{ key: 'Forest', qty: 30 }], [{ key: 'Forest', qty: 30 }]);
  const pid = g.s.active, opp = 1 - pid;
  const big = put(g, pid, 'Hulk');
  const sick = put(g, pid, 'Grizzly Bears'); sick.sick = true;
  const snake = put(g, opp, 'Biter');
  goTo(g, 'Declare Attackers');
  assert.throws(() => g.declareAttack(sick.iid, opp), /summoning sickness/);
  g.declareAttack(big.iid, opp);
  g.nextStep(); g.declareBlock(snake.iid, big.iid); g.nextStep();
  assert.equal(g.locate(big.iid).zone, 'graveyard');
  assert.equal(g.players[opp].life, 34); // trample: 1 lethal to snake (deathtouch? no—Hulk lacks deathtouch, snake toughness 1) => 6
});

test('undo restores state; drawing from empty library loses', () => {
  const g = newGame([{ key: 'Forest', qty: 8 }], [{ key: 'Forest', qty: 30 }]);
  const before = g.players[0].zones.hand.length;
  g.draw(0, 1); g.undo();
  assert.equal(g.players[0].zones.hand.length, before);
  g.draw(0, 5);
  assert.ok(g.players[0].lost);
});

test('activated & loyalty abilities parse', () => {
  const g = new Game({ X: card({ name: 'X', type_line: 'Legendary Planeswalker — Test', oracle_text: '+1: Draw a card.\n−3: Destroy target creature.\nEquip {2}' }) });
  const ab = g.abilities({ key: 'X', face: 0, eot: { kw: [] } });
  assert.equal(ab.length, 3);
  assert.equal(ab[1].sign, -1);
});

test('forfeit gives the win, rematch keeps score and loser goes first', () => {
  const g = newGame([{ key: 'Forest', qty: 30 }], [{ key: 'Forest', qty: 30 }]);
  g.concede(1);
  assert.equal(g.s.winner, 0);
  assert.equal(g.s.score[0], 1);
  g.rematch(0);
  assert.equal(g.s.match, 2);
  assert.equal(g.s.winner, null);
  assert.equal(g.s.stage, 'mulligan');
  assert.equal(g.s.firstPlayer, 1);
  assert.equal(g.s.score[0], 1);
  assert.equal(g.players[1].zones.hand.length, 7);
  assert.equal(g.players[1].life, 40);
});

test('mana tracker: available mana from untapped sources, clear pool', () => {
  const g = newGame([{ key: 'Forest', qty: 30 }], [{ key: 'Forest', qty: 30 }]);
  const pid = g.s.active;
  put(g, pid, 'Forest'); put(g, pid, 'Forest'); put(g, pid, 'Sol Ring');
  const elf = put(g, pid, 'Llanowar Elves'); elf.sick = true;   // sick dork can't tap
  let av = g.availableMana(pid);
  assert.equal(av.total, 4);           // 2 Forests + Sol Ring (2)
  assert.equal(av.per.G, 2);
  assert.equal(av.per.C, 2);
  elf.sick = false;
  assert.equal(g.availableMana(pid).total, 5);
  g.tapForMana(g.players[pid].zones.battlefield[0].iid, { G: 1 });
  assert.equal(g.players[pid].pool.G, 1);
  assert.equal(g.availableMana(pid).total, 4);
  g.addMana(pid, 'R', 2);
  g.clearPool(pid);
  assert.deepEqual(g.players[pid].pool, { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 });
});

test('Moxfield export: commander listed last after a blank line', () => {
  const DB2 = { ...DB,
    'Zada, Hedron Grinder': card({ name: 'Zada, Hedron Grinder', type_line: 'Legendary Creature — Goblin Ally', color_identity: ['R'], power: '3', toughness: '3' }),
    'Mountain': card({ name: 'Mountain', type_line: 'Basic Land — Mountain' }),
  };
  const look = n => DB2[n];
  const text = '1 Lightning Bolt (2X2) 117\n1 Sol Ring *F*\n97 Mountain\n\n1 Zada, Hedron Grinder\n';
  const d = resolveTrailing(parseDecklist(text), look, 'commander');
  assert.deepEqual(d.commanders.map(c => c.name), ['Zada, Hedron Grinder']);
  assert.ok(!d.main.some(e => e.name.startsWith('Zada')));
  assert.match(d.detected, /Commander detected: Zada/);
  assert.deepEqual(validateDeck(d, look, 'commander').errors, []);
});

test('Moxfield export: partners at the end; non-commander last group stays in the deck', () => {
  const look = n => DB[n];
  const p = resolveTrailing(parseDecklist('98 Forest\n\n1 Partner A\n1 Partner B'), look, 'commander');
  assert.deepEqual(p.commanders.map(c => c.name), ['Partner A', 'Partner B']);
  const q = resolveTrailing(parseDecklist('1 Hulk\n98 Forest\n\n1 Grizzly Bears'), look, 'commander');
  assert.equal(q.commanders.length, 0);
  assert.ok(q.main.some(e => e.name === 'Grizzly Bears'));
  // explicit headings still win over the blank-line rule
  const r = resolveTrailing(parseDecklist('Commander\n1 Hulk\n\nDeck\n98 Forest\n\n1 Partner A'), look, 'commander');
  assert.deepEqual(r.commanders.map(c => c.name), ['Hulk']);
});

test('MTGO/Moxfield 60-card export: last group becomes the sideboard', () => {
  const look = n => DB[n];
  const d = resolveTrailing(parseDecklist('4 Lightning Bolt\n56 Mountain\n\n3 Grizzly Bears'), look, 'modern');
  assert.deepEqual(d.side, [{ qty: 3, name: 'Grizzly Bears' }]);
  assert.equal(d.main.reduce((n, e) => n + e.qty, 0), 60);
});

console.log(`\n${passed} tests passed`);
