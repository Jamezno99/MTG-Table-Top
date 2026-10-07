// Run with: node tests/effects.test.mjs — the card-text engine, end to end, with real Oracle text.
import assert from 'node:assert/strict';
import { Game, PHASES } from '../js/game.js';

let passed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log('✓', name); } catch (e) { console.error('✗', name, '\n  ', e.stack.split('\n').slice(0, 3).join('\n   ')); process.exitCode = 1; } };

const legal = { commander: 'legal' };
const C = (name, type_line, oracle_text = '', extra = {}) => ({ name, type_line, oracle_text, mana_cost: '', colors: [], color_identity: [], keywords: [], faces: [], legalities: legal, ...extra });
const cr = (name, sub, cost, pt, text, colors = []) => C(name, `Creature — ${sub}`, text, { mana_cost: cost, power: pt.split('/')[0], toughness: pt.split('/')[1], colors, color_identity: colors });
const DB = Object.fromEntries([
  C('Forest', 'Basic Land — Forest'), C('Mountain', 'Basic Land — Mountain'), C('Swamp', 'Basic Land — Swamp'), C('Island', 'Basic Land — Island'),
  C('Shivan Reef', 'Land', '{T}: Add {C}.\n{T}: Add {U} or {R}. Shivan Reef deals 1 damage to you.'),
  C('Steam Vents', 'Land — Island Mountain', "({T}: Add {U} or {R}.)\nAs Steam Vents enters, you may pay 2 life. If you don't, it enters tapped."),
  C('Spirebluff Canal', 'Land', 'This land enters tapped unless you control two or fewer other lands.\n{T}: Add {U} or {R}.'),
  C('Thornwood Falls', 'Land', 'This land enters tapped.\nWhen this land enters, you gain 1 life.\n{T}: Add {G} or {U}.'),
  C('Sol Ring', 'Artifact', '{T}: Add {C}{C}.', { mana_cost: '{1}' }),
  C('Arcane Signet', 'Artifact', "{T}: Add one mana of any color in your commander's color identity.", { mana_cost: '{2}' }),
  C('Treasure', 'Token Artifact — Treasure', '{T}, Sacrifice this artifact: Add one mana of any color.'),
  C('Lightning Bolt', 'Instant', 'Lightning Bolt deals 3 damage to any target.', { mana_cost: '{R}', colors: ['R'] }),
  C('Counterspell', 'Instant', 'Counter target spell.', { mana_cost: '{U}{U}', colors: ['U'] }),
  C('Harmonize', 'Sorcery', 'Draw three cards.', { mana_cost: '{2}{G}{G}', colors: ['G'] }),
  C('Cultivate', 'Sorcery', 'Search your library for up to two basic land cards, reveal those cards, put one onto the battlefield tapped and the other into your hand, then shuffle.', { mana_cost: '{2}{G}', colors: ['G'] }),
  C('Beast Within', 'Instant', 'Destroy target permanent. Its controller creates a 3/3 green Beast creature token.', { mana_cost: '{2}{G}', colors: ['G'] }),
  C('Overrun', 'Sorcery', 'Creatures you control get +3/+3 and gain trample until end of turn.', { mana_cost: '{2}{G}{G}{G}', colors: ['G'] }),
  C('Snuff Out', 'Instant', "If you control a Swamp, you may pay 4 life rather than pay this spell's mana cost.\nDestroy target nonblack creature. It can't be regenerated.", { mana_cost: '{3}{B}', colors: ['B'] }),
  C('Village Rites', 'Instant', 'As an additional cost to cast this spell, sacrifice a creature.\nDraw two cards.', { mana_cost: '{B}', colors: ['B'] }),
  C('Think Twice', 'Instant', 'Draw a card.\nFlashback {2}{U}', { mana_cost: '{1}{U}', colors: ['U'] }),
  C('Return of the Wildspeaker', 'Instant', 'Choose one —\n• Draw cards equal to the greatest power among non-Human creatures you control.\n• Non-Human creatures you control get +3/+3 until end of turn.', { mana_cost: '{4}{G}', colors: ['G'] }),
  C('Impact Tremors', 'Enchantment', 'Whenever a creature you control enters, Impact Tremors deals 1 damage to each opponent.', { mana_cost: '{1}{R}', colors: ['R'] }),
  C('Coat of Arms', 'Artifact', 'Each creature gets +1/+1 for each other creature on the battlefield that shares at least one creature type with it.', { mana_cost: '{5}' }),
  C('Swiftfoot Boots', 'Artifact — Equipment', 'Equipped creature has hexproof and haste.\nEquip {1}', { mana_cost: '{2}' }),
  C('Skullclamp', 'Artifact — Equipment', 'Equipped creature gets +1/-1.\nWhenever equipped creature dies, draw two cards.\nEquip {1}', { mana_cost: '{1}' }),
  C('Unholy Strength', 'Enchantment — Aura', 'Enchant creature\nEnchanted creature gets +2/+1.', { mana_cost: '{B}', colors: ['B'] }),
  C('Goblin Bombardment', 'Enchantment', 'Sacrifice a creature: Goblin Bombardment deals 1 damage to any target.', { mana_cost: '{1}{R}', colors: ['R'] }),
  C('Purphoros, God of the Forge', 'Legendary Enchantment Creature — God', "Indestructible\nAs long as your devotion to red is less than five, Purphoros isn't a creature.\nWhenever another creature you control enters, Purphoros deals 2 damage to each opponent.\n{2}{R}: Creatures you control get +1/+0 until end of turn.", { mana_cost: '{3}{R}', power: '6', toughness: '5', colors: ['R'] }),
  cr('Grizzly Bears', 'Bear', '{1}{G}', '2/2', '', ['G']),
  cr('Raging Goblin', 'Goblin Berserker', '{R}', '1/1', 'Haste', ['R']),
  cr('Llanowar Elves', 'Elf Druid', '{G}', '1/1', '{T}: Add {G}.', ['G']),
  cr('Elvish Archdruid', 'Elf Druid', '{1}{G}{G}', '2/2', 'Other Elf creatures you control get +1/+1.\n{T}: Add {G} for each Elf you control.', ['G']),
  cr('Goblin King', 'Goblin', '{1}{R}{R}', '2/2', 'Other Goblins get +1/+1 and have mountainwalk.', ['R']),
  cr('Goblin Warchief', 'Goblin Warrior', '{1}{R}{R}', '2/2', 'Goblin spells you cast cost {1} less to cast.\nGoblins you control have haste.', ['R']),
  cr('Siege-Gang Commander', 'Goblin', '{3}{R}{R}', '2/2', 'When Siege-Gang Commander enters, create three 1/1 red Goblin creature tokens.\n{1}{R}, Sacrifice a Goblin: Siege-Gang Commander deals 2 damage to any target.', ['R']),
  cr('Mogg War Marshal', 'Goblin Warrior', '{1}{R}', '1/1', 'Echo {1}{R}\nWhen this creature enters or dies, create a 1/1 red Goblin creature token.', ['R']),
  cr('Krenko, Mob Boss', 'Goblin Warrior', '{2}{R}{R}', '3/3', '{T}: Create X 1/1 red Goblin creature tokens, where X is the number of Goblins you control.', ['R']),
  cr('Hellrider', 'Devil', '{2}{R}{R}', '3/3', "Haste\nWhenever a creature you control attacks, Hellrider deals 1 damage to the player or planeswalker it's attacking.", ['R']),
  cr('Lys Alana Huntmaster', 'Elf Warrior', '{2}{G}{G}', '3/3', 'Whenever you cast an Elf spell, you may create a 1/1 green Elf Warrior creature token.', ['G']),
  cr('Goblin Ringleader', 'Goblin', '{3}{R}', '2/2', 'Haste\nWhen Goblin Ringleader enters, reveal the top four cards of your library. Put all Goblin cards revealed this way into your hand and the rest on the bottom of your library in any order.', ['R']),
  cr('Wood Elves', 'Elf Scout', '{2}{G}', '1/1', 'When Wood Elves enters, search your library for a Forest card, put that card onto the battlefield, then shuffle.', ['G']),
  cr('Sungrace Pegasus', 'Pegasus', '{1}{W}', '1/2', 'Flying, lifelink', ['W']),
  cr('Hexproof Bear', 'Bear', '{1}{G}', '2/2', 'Hexproof', ['G']),
  cr('Upkeep Healer', 'Cleric', '{W}', '1/1', 'At the beginning of your upkeep, you gain 1 life.', ['W']),
  cr('Zombie Walker', 'Zombie', '{B}', '2/2', '', ['B']),
].map(c => [c.name, c]));
for (const c of Object.values(DB)) if (c.name === 'Krenko, Mob Boss' || c.name === 'Purphoros, God of the Forge') c.type_line = c.type_line.replace(/^(Enchantment )?Creature|^Legendary/, m => m);
DB['Krenko, Mob Boss'].type_line = 'Legendary Creature — Goblin Warrior';

function newGame(mainA = [{ key: 'Forest', qty: 40 }], mainB = [{ key: 'Mountain', qty: 40 }], cmdrs = [[], []]) {
  const g = Game.create({ format: 'commander', db: DB, players: [
    { name: 'Ann', main: mainA, commanders: cmdrs[0] }, { name: 'Bob', main: mainB, commanders: cmdrs[1] }], first: 0 });
  for (const p of g.players) g.keep(p.id);
  return g;
}
const put = (g, pid, key, zone = 'battlefield') => { g.addCardToZone(pid, key, zone); const z = g.players[pid].zones[zone]; const c = z[z.length - 1]; c.sick = false; return c; };
const lands = (g, pid, key, n) => { for (let i = 0; i < n; i++) put(g, pid, key); };
const top = g => g.s.stack[g.s.stack.length - 1];
const tokens = (g, pid, name) => g.players[pid].zones.battlefield.filter(c => c.token && g.face(c).name === name);
// pass the turn, discarding down to 7 if forced cleanup asks for it
const pass = g => { g.endTurn(); if (g.s.pending) g.cleanupDiscard(g.s.pending.pid, g.players[g.s.pending.pid].zones.hand.slice(0, g.s.pending.n).map(c => c.iid)); };
const resolveAll = (g, choices = {}) => { for (let i = 0; g.s.stack.length && i < 30; i++) g.resolveTop(choices); };

// ------------------------------------------------------------------ turn automation
test('auto upkeep + auto draw: turns start in Main 1 after drawing', () => {
  const g = newGame();
  assert.equal(PHASES[g.s.phase], 'Main 1');
  assert.equal(g.players[0].zones.hand.length, 7);              // first player skips the draw in 1v1
  g.endTurn();
  assert.equal(g.s.active, 1);
  assert.equal(PHASES[g.s.phase], 'Main 1');
  assert.equal(g.players[1].zones.hand.length, 8);
});

test('upkeep triggers stop the turn at upkeep until resolved', () => {
  const g = newGame();
  put(g, 1, 'Upkeep Healer');
  g.endTurn();
  assert.equal(PHASES[g.s.phase], 'Upkeep');
  assert.equal(g.s.stack.length, 1);
  g.resolveTop();
  assert.equal(g.players[1].life, 41);
  g.nextStep();                       // → draw (auto draw continues to Main 1)
  assert.equal(PHASES[g.s.phase], 'Main 1');
  assert.equal(g.players[1].zones.hand.length, 8);
});

test('auto steps can be turned off', () => {
  const g = newGame();
  g.setSetting('autoUpkeep', false);
  g.endTurn();
  assert.equal(PHASES[g.s.phase], 'Upkeep');
});

test('forced cleanup: must discard to 7 before the turn passes', () => {
  const g = newGame();
  g.draw(0, 2);                                                // 9 cards
  g.endTurn();
  assert.deepEqual(g.s.pending, { type: 'discard', pid: 0, n: 2 });
  assert.throws(() => g.nextStep(), /must first discard/);
  assert.throws(() => g.cleanupDiscard(0, [g.players[0].zones.hand[0].iid]), /exactly 2/);
  const h = g.players[0].zones.hand;
  g.cleanupDiscard(0, [h[0].iid, h[1].iid]);
  assert.equal(g.players[0].zones.hand.length, 7);
  assert.equal(g.players[0].zones.graveyard.length, 2);
  assert.equal(g.s.active, 1);
  assert.equal(g.s.pending, null);
});

// ------------------------------------------------------------------ spells with targets
test('Lightning Bolt: target chosen on cast, 3 damage kills a creature or hits a player', () => {
  const g = newGame([{ key: 'Mountain', qty: 40 }], [{ key: 'Forest', qty: 40 }]);
  lands(g, 0, 'Mountain', 2);
  const bear = put(g, 1, 'Grizzly Bears');
  const b1 = put(g, 0, 'Lightning Bolt', 'hand');
  const plan = g.planOf(b1);
  assert.equal(plan.targetSlots.length, 1);
  assert.ok(g.candidates(plan.targetSlots[0].spec, 0).some(c => c.id === 'p1'));
  g.cast(b1.iid, { choices: { targets: { [plan.targetSlots[0].key]: ['c' + bear.iid] } } });
  g.resolveTop();
  assert.equal(g.players[1].zones.graveyard.length, 1);
  const b2 = put(g, 0, 'Lightning Bolt', 'hand');
  g.cast(b2.iid, { choices: { targets: { [g.planOf(b2).targetSlots[0].key]: ['p1'] } } });
  g.resolveTop();
  assert.equal(g.players[1].life, 37);
});

test('spells fizzle when their only target is gone; hexproof hides opposing creatures', () => {
  const g = newGame([{ key: 'Mountain', qty: 40 }], [{ key: 'Forest', qty: 40 }]);
  lands(g, 0, 'Mountain', 1);
  const bear = put(g, 1, 'Grizzly Bears');
  const hex = put(g, 1, 'Hexproof Bear');
  const bolt = put(g, 0, 'Lightning Bolt', 'hand');
  const slot = g.planOf(bolt).targetSlots[0];
  const cands = g.candidates(slot.spec, 0).map(c => c.id);
  assert.ok(!cands.includes('c' + hex.iid));
  g.cast(bolt.iid, { choices: { targets: { [slot.key]: ['c' + bear.iid] } } });
  g.move(bear.iid, 'hand');
  g.resolveTop();
  assert.equal(g.players[1].life, 40);
  assert.ok(g.s.log.some(l => /targets are no longer legal/.test(l.msg)));
});

test('Counterspell counters the spell it targets', () => {
  const g = newGame([{ key: 'Island', qty: 40 }], [{ key: 'Forest', qty: 40 }]);
  lands(g, 1, 'Forest', 4); lands(g, 0, 'Island', 2);
  pass(g);
  const h = put(g, 1, 'Harmonize', 'hand');
  g.cast(h.iid);
  const cs = put(g, 0, 'Counterspell', 'hand');
  const slot = g.planOf(cs).targetSlots[0];
  g.cast(cs.iid, { choices: { targets: { [slot.key]: ['s' + h.iid] } } });
  g.resolveTop();
  assert.equal(g.s.stack.length, 0);
  assert.ok(g.players[1].zones.graveyard.some(c => c.iid === h.iid));
  assert.equal(g.players[1].zones.hand.length, 8);   // Harmonize never drew
});

test('Beast Within: destroy target permanent, its controller gets a 3/3 Beast', () => {
  const g = newGame();
  lands(g, 0, 'Forest', 3);
  const ring = put(g, 1, 'Sol Ring');
  const bw = put(g, 0, 'Beast Within', 'hand');
  g.cast(bw.iid, { choices: { targets: { [g.planOf(bw).targetSlots[0].key]: ['c' + ring.iid] } } });
  g.resolveTop();
  assert.ok(!g.players[1].zones.battlefield.includes(ring));
  assert.equal(tokens(g, 1, 'Beast').length, 1);
  assert.deepEqual(g.pt(tokens(g, 1, 'Beast')[0]), { p: 3, t: 3 });
});

test('Overrun pumps your team until end of turn; modal spell uses the chosen mode', () => {
  const g = newGame();
  lands(g, 0, 'Forest', 5);
  const bear = put(g, 0, 'Grizzly Bears');
  const ov = put(g, 0, 'Overrun', 'hand');
  g.cast(ov.iid); g.resolveTop();
  assert.deepEqual(g.pt(bear), { p: 5, t: 5 });
  assert.ok(g.kw(bear, 'Trample'));
  pass(g); pass(g);
  assert.deepEqual(g.pt(bear), { p: 2, t: 2 });
  lands(g, 0, 'Forest', 5);
  for (const c of g.players[0].zones.battlefield) c.tapped = false;
  const rw = put(g, 0, 'Return of the Wildspeaker', 'hand');
  g.cast(rw.iid, { choices: { modes: [1] } });
  g.resolveTop();
  assert.deepEqual(g.pt(bear), { p: 5, t: 5 });
});

test('Cultivate: one basic onto the battlefield tapped, one into hand', () => {
  const g = newGame([{ key: 'Forest', qty: 40 }]);
  lands(g, 0, 'Forest', 3);
  const cu = put(g, 0, 'Cultivate', 'hand');
  const handBefore = g.players[0].zones.hand.length;
  g.cast(cu.iid);
  const need = g.resolutionNeeds(top(g).iid).find(n => n.kind === 'search');
  assert.equal(need.max, 2);
  const picks = need.candidates.slice(0, 2).map(c => c.iid);
  g.resolveTop({ picks: { [need.key]: picks } });
  const bfIds = g.players[0].zones.battlefield.map(c => c.iid);
  assert.ok(bfIds.includes(picks[0]));
  assert.ok(g.players[0].zones.battlefield.find(c => c.iid === picks[0]).tapped);
  assert.ok(g.players[0].zones.hand.some(c => c.iid === picks[1]));
  assert.equal(g.players[0].zones.hand.length, handBefore);   // -Cultivate +1 land
});

// ------------------------------------------------------------------ triggers
test('Siege-Gang Commander + Impact Tremors: ETB tokens, and Tremors triggers for every creature', () => {
  const g = newGame([{ key: 'Mountain', qty: 40 }], [{ key: 'Forest', qty: 40 }]);
  put(g, 0, 'Impact Tremors');
  lands(g, 0, 'Mountain', 5);
  const sg = put(g, 0, 'Siege-Gang Commander', 'hand');
  g.cast(sg.iid);
  g.resolveTop();                                  // Siege-Gang enters
  assert.equal(g.s.stack.length, 2);               // its ETB + Tremors
  resolveAll(g);
  assert.equal(tokens(g, 0, 'Goblin').length, 3);
  assert.equal(g.players[1].life, 36);             // 1 (Siege-Gang) + 3 (tokens)
});

test('dies trigger (Mogg War Marshal) and ETB-or-dies', () => {
  const g = newGame([{ key: 'Mountain', qty: 40 }]);
  lands(g, 0, 'Mountain', 2);
  const mwm = put(g, 0, 'Mogg War Marshal', 'hand');
  g.cast(mwm.iid); g.resolveTop(); resolveAll(g);
  assert.equal(tokens(g, 0, 'Goblin').length, 1);
  g.move(mwm.iid, 'graveyard');
  resolveAll(g);
  assert.equal(tokens(g, 0, 'Goblin').length, 2);
});

test('Krenko: X = number of Goblins you control; Goblin King pumps and grants mountainwalk', () => {
  const g = newGame([{ key: 'Mountain', qty: 40 }], [{ key: 'Mountain', qty: 40 }]);
  const k = put(g, 0, 'Krenko, Mob Boss');
  const king = put(g, 0, 'Goblin King');
  const ab = g.abilities(k)[0];
  g.activate(k.iid, ab.i); resolveAll(g);
  assert.equal(tokens(g, 0, 'Goblin').length, 2);  // Krenko + King
  const t = tokens(g, 0, 'Goblin')[0];
  assert.deepEqual(g.pt(t), { p: 2, t: 2 });
  t.sick = false;                                    // (tokens made this turn can't attack yet)
  assert.deepEqual(g.pt(king), { p: 2, t: 2 });    // "Other" Goblins
  assert.ok(g.kw(t, 'Mountainwalk'));
  put(g, 1, 'Mountain'); const blocker = put(g, 1, 'Grizzly Bears');
  g.nextStep(); g.nextStep();
  g.declareAttack(t.iid, 1); g.nextStep();
  assert.throws(() => g.declareBlock(blocker.iid, t.iid), /mountainwalk/);
});

test('Goblin Warchief: haste for Goblins and Goblin spells cost {1} less', () => {
  const g = newGame([{ key: 'Mountain', qty: 40 }]);
  put(g, 0, 'Goblin Warchief');
  lands(g, 0, 'Mountain', 1);
  const mwm = put(g, 0, 'Mogg War Marshal', 'hand');   // {1}{R} → {R}
  g.cast(mwm.iid);
  assert.equal(g.players[0].zones.battlefield.filter(c => c.tapped).length, 1);
  g.resolveTop(); resolveAll(g);
  assert.ok(g.kw(mwm, 'Haste'));
  g.nextStep(); g.nextStep();
  g.declareAttack(mwm.iid, 1);                          // no summoning-sickness error
  assert.equal(mwm.attacking, 1);
});

test('Hellrider: attack triggers hit the defending player', () => {
  const g = newGame([{ key: 'Mountain', qty: 40 }]);
  put(g, 0, 'Hellrider'); const gob = put(g, 0, 'Raging Goblin');
  g.nextStep(); g.nextStep();
  g.declareAttack(gob.iid, 1);
  assert.equal(g.s.stack.length, 1);
  g.resolveTop();
  assert.equal(g.players[1].life, 39);
});

test('cast trigger with "you may" can be declined; Elvish Archdruid lord + mana', () => {
  const g = newGame();
  const hunt = put(g, 0, 'Lys Alana Huntmaster');
  const druid = put(g, 0, 'Elvish Archdruid');
  lands(g, 0, 'Forest', 1);
  const elf = put(g, 0, 'Llanowar Elves', 'hand');
  g.cast(elf.iid);
  assert.equal(g.s.stack.length, 2);
  const trig = top(g);
  const opt = g.resolutionNeeds(trig.iid).find(n => n.kind === 'optional');
  g.resolveTop({ skip: [opt.key] });
  assert.equal(tokens(g, 0, 'Elf Warrior').length, 0);
  g.resolveTop();
  assert.deepEqual(g.pt(elf), { p: 2, t: 2 });
  assert.deepEqual(g.pt(druid), { p: 2, t: 2 });
  const choice = g.manaChoices(druid)[0];
  assert.equal(choice.n, 3);                       // Archdruid + Llanowar + Huntmaster (an Elf Warrior)
  g.tapForMana(druid.iid, 0);
  assert.equal(g.players[0].pool.G, 3);
  assert.ok(hunt);
});

test('Goblin Ringleader reveals four and takes the Goblins', () => {
  const g = newGame([{ key: 'Mountain', qty: 30 }, { key: 'Raging Goblin', qty: 10 }]);
  const lib = g.players[0].zones.library;
  const topFour = lib.slice(-4);
  const goblins = topFour.filter(c => g.face(c).name === 'Raging Goblin').length;
  const hand = g.players[0].zones.hand.length;
  put(g, 0, 'Goblin Ringleader');
  g.resolveTop();
  assert.equal(g.players[0].zones.hand.length, hand + goblins);
  assert.equal(lib.length, 40 - 7 - goblins);
});

test('Wood Elves fetches a Forest untapped', () => {
  const g = newGame([{ key: 'Forest', qty: 40 }]);
  const before = g.players[0].zones.battlefield.length;
  put(g, 0, 'Wood Elves');
  g.resolveTop();
  const bf = g.players[0].zones.battlefield;
  assert.equal(bf.length, before + 2);
  assert.ok(!bf[bf.length - 1].tapped);
});

// ------------------------------------------------------------------ statics / equipment / auras
test('equipment: Swiftfoot Boots gives hexproof + haste; Skullclamp draws when the creature dies', () => {
  const g = newGame();
  lands(g, 0, 'Forest', 3);
  const boots = put(g, 0, 'Swiftfoot Boots');
  const bear = put(g, 0, 'Grizzly Bears', 'battlefield'); bear.sick = true;
  const eq = g.abilities(boots).find(a => a.equip);
  const slot = g.planOf({ ability: true, text: eq.text, srcName: 'Swiftfoot Boots', key: boots.key, face: 0, controller: 0 }).targetSlots[0];
  g.activate(boots.iid, eq.i, { choices: { targets: { [slot.key]: ['c' + bear.iid] } } });
  g.resolveTop();
  assert.equal(boots.attachedTo, bear.iid);
  assert.ok(g.kw(bear, 'Hexproof') && g.kw(bear, 'Haste'));
  const clamp = put(g, 0, 'Skullclamp');
  const eq2 = g.abilities(clamp).find(a => a.equip);
  const elf = put(g, 0, 'Llanowar Elves');
  g.activate(clamp.iid, eq2.i, { choices: { targets: { 's0.t': ['c' + elf.iid] } } });
  g.resolveTop();
  const hand = g.players[0].zones.hand.length;
  assert.equal(g.locate(elf.iid).zone, 'graveyard');     // 1/1 with +1/-1 dies to state-based actions
  resolveAll(g);
  assert.equal(g.players[0].zones.hand.length, hand + 2);
  assert.equal(clamp.attachedTo, null);
});

test('aura attaches on resolution and falls off with its host', () => {
  const g = newGame([{ key: 'Swamp', qty: 40 }]);
  lands(g, 0, 'Swamp', 1);
  const z = put(g, 0, 'Zombie Walker');
  const aura = put(g, 0, 'Unholy Strength', 'hand');
  const slot = g.planOf(aura).targetSlots[0];
  g.cast(aura.iid, { choices: { targets: { [slot.key]: ['c' + z.iid] } } });
  g.resolveTop();
  assert.deepEqual(g.pt(z), { p: 4, t: 3 });
  g.move(z.iid, 'graveyard');
  assert.equal(g.locate(aura.iid).zone, 'graveyard');
});

test('Coat of Arms and devotion (Purphoros is not a creature without devotion)', () => {
  const g = newGame([{ key: 'Mountain', qty: 40 }]);
  const p = put(g, 0, 'Purphoros, God of the Forge');
  assert.equal(g.isCreature(p), false);
  const a = put(g, 0, 'Raging Goblin'), b = put(g, 0, 'Goblin King');
  put(g, 0, 'Coat of Arms');
  assert.deepEqual(g.pt(a), { p: 3, t: 3 });   // 1/1 +1 King +1 Coat (shares Goblin with King)
  assert.ok(b);
});

// ------------------------------------------------------------------ costs
test('Goblin Bombardment: sacrifice cost, then 1 damage to any target', () => {
  const g = newGame([{ key: 'Mountain', qty: 40 }]);
  const bomb = put(g, 0, 'Goblin Bombardment');
  const gob = put(g, 0, 'Raging Goblin');
  const ab = g.abilities(bomb)[0];
  assert.throws(() => g.activate(bomb.iid, ab.i), /sacrifice/);
  g.activate(bomb.iid, ab.i, { choices: { sac: [gob.iid], targets: { 's0.to0': ['p1'] } } });
  assert.equal(g.locate(gob.iid).zone, 'graveyard');
  g.resolveTop();
  assert.equal(g.players[1].life, 39);
});

test('Snuff Out (pay 4 life instead, needs a Swamp), Village Rites (sacrifice), Think Twice (flashback)', () => {
  const g = newGame([{ key: 'Island', qty: 40 }], [{ key: 'Forest', qty: 40 }]);
  const bear = put(g, 1, 'Grizzly Bears');
  const so = put(g, 0, 'Snuff Out', 'hand');
  const slot = g.planOf(so).targetSlots[0];
  assert.throws(() => g.cast(so.iid, { alt: 'life', choices: { targets: { [slot.key]: ['c' + bear.iid] } } }), /Swamp/);
  put(g, 0, 'Swamp');
  g.cast(so.iid, { alt: 'life', choices: { targets: { [slot.key]: ['c' + bear.iid] } } });
  assert.equal(g.players[0].life, 36);
  g.resolveTop();
  assert.equal(g.locate(bear.iid).zone, 'graveyard');
  const vr = put(g, 0, 'Village Rites', 'hand');
  const elf = put(g, 0, 'Llanowar Elves');
  const hand = g.players[0].zones.hand.length;
  g.cast(vr.iid, { choices: { sac: [elf.iid] } });
  g.resolveTop();
  assert.equal(g.locate(elf.iid).zone, 'graveyard');
  assert.equal(g.players[0].zones.hand.length, hand - 1 + 2);
  lands(g, 0, 'Island', 5);
  const tt = put(g, 0, 'Think Twice', 'graveyard');
  assert.throws(() => g.cast(tt.iid), /graveyard/);
  g.cast(tt.iid, { alt: 'flashback' });
  g.resolveTop();
  assert.equal(g.locate(tt.iid).zone, 'exile');
});

// ------------------------------------------------------------------ mana
test('lands: shock (pay 2 or tapped), fastland condition, enters-tapped gainland with its trigger', () => {
  const g = newGame([{ key: 'Island', qty: 40 }]);
  const sv = put(g, 0, 'Steam Vents', 'hand');
  assert.ok(g.landPrompt(sv).shock);
  g.playLand(sv.iid, { etb: 'pay' });
  assert.equal(sv.tapped, false);
  assert.equal(g.players[0].life, 38);
  pass(g); pass(g);
  const sv2 = put(g, 0, 'Steam Vents', 'hand');
  g.playLand(sv2.iid);
  assert.equal(sv2.tapped, true);
  pass(g); pass(g);
  const sc = put(g, 0, 'Spirebluff Canal', 'hand');
  g.playLand(sc.iid);                                // 2 other lands → untapped
  assert.equal(sc.tapped, false);
  pass(g); pass(g);
  const tf = put(g, 0, 'Thornwood Falls', 'hand');
  g.playLand(tf.iid);
  assert.equal(tf.tapped, true);
  resolveAll(g);
  assert.equal(g.players[0].life, 39);
});

test('painlands only cost life when colored mana is needed; Treasure and Arcane Signet', () => {
  const g = newGame([{ key: 'Mountain', qty: 40 }], [{ key: 'Forest', qty: 40 }], [['Krenko, Mob Boss'], []]);
  put(g, 0, 'Shivan Reef'); put(g, 0, 'Shivan Reef');
  const ring = put(g, 0, 'Sol Ring', 'hand');
  g.cast(ring.iid); g.resolveTop();
  assert.equal(g.players[0].life, 40);               // used {C}
  const bolt = put(g, 0, 'Lightning Bolt', 'hand');
  g.cast(bolt.iid, { choices: { targets: { [g.planOf(bolt).targetSlots[0].key]: ['p1'] } } });
  assert.equal(g.players[0].life, 39);               // {R} from the Reef hurt
  g.resolveTop();
  const sig = put(g, 0, 'Arcane Signet');
  const o = g.manaChoices(sig)[0];
  assert.ok(o.identity);
  assert.throws(() => g.tapForMana(sig.iid, 0, 'G'), /only make R/);
  g.tapForMana(sig.iid, 0, 'R');
  const tr = put(g, 0, 'Treasure'); tr.token = true;
  g.tapForMana(tr.iid, 0, 'U');
  assert.equal(g.players[0].pool.U, 1);
  assert.ok(!g.players[0].zones.battlefield.includes(tr));
});

test('the card reader explains what is automated', () => {
  const g = newGame();
  const sg = put(g, 0, 'Siege-Gang Commander');
  const u = g.understand(sg);
  assert.equal(u.length, 2);
  assert.ok(u.every(x => x.status === 'auto'));
  const mwm = put(g, 0, 'Mogg War Marshal');
  const u2 = g.understand(mwm);
  assert.equal(u2[0].status, 'manual');              // Echo isn't automated
  assert.equal(u2[1].status, 'auto');
});

console.log(`\n${passed} card-text tests passed`);
