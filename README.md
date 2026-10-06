# MTG Tabletop

A browser-based Magic: The Gathering simulator with live card data, deck legality checking and full Commander support. It is a static site with no build step and no server, so it runs on GitHub Pages.

## Features

- **Every card.** Oracle text, images and legality come live from [Scryfall](https://scryfall.com). This includes double-faced, split and adventure cards, tokens, emblems and dungeons.
- **Always-current banlist.** Decks are checked against Scryfall's legality data, which follows every official B&R announcement. It is re-checked every 3 days.
- **Commander.** The deck checker enforces:
  - exactly 100 cards
  - singleton, except basics and "any number of cards named"
  - color identity
  - commander eligibility, including Partner, Partner with, Friends forever, Backgrounds and Doctor's companion
- **Commander play.** 40 life, command zone, commander tax, commander returns to the command zone, 21 commander-damage tracking, free first mulligan.
- **Other formats.** Standard, Pioneer, Modern, Legacy, Vintage (restricted list), Pauper, and Freeform.
- **Rules engine.** The engine handles:
  - Turn structure: all 12 steps, untap/draw, mana pools emptying between steps, and cleanup.
  - Timing: sorcery speed vs. instant/flash, one land per turn, and summoning sickness.
  - Casting: spells go on the stack, with auto-paid mana costs (hybrid, Phyrexian, X) and auto-tapping of lands and mana rocks.
  - Abilities: activated and loyalty abilities.
  - Combat: attackers and blockers with flying/reach and menace warnings, first strike, double strike, trample, deathtouch, lifelink, infect, toxic and vigilance.
  - State-based actions: lethal damage, 0 toughness, 0 loyalty, the legend rule, 0 life, 10 poison, 21 commander damage, and drawing from an empty library.
- **Pass-and-play.** 1–4 players on one screen. Hands are hidden between turns.
- **Quality of life.** Undo (Ctrl+Z), and automatic saving in your browser.

### What is automatic vs. manual

The engine enforces the rules of the game: turns, timing, costs, combat and state-based actions. It does **not** automatically execute each card's unique effect text. No simulator does that perfectly for all 27,000+ cards.

When a spell resolves, you carry out its text using the card menus. These cover draw, destroy, exile, tokens, counters, P/T changes, keywords, control changes and library searches.

Any rules check can be overridden with **"Do it anyway"** for cards that change the rules.

## Put it on GitHub Pages

1. Create a new repository on GitHub, e.g. `mtg-tabletop`.
2. Upload the contents of this folder (`index.html`, `css/`, `js/`, `assets/`, …) to the repository root.
   - Either drag them into the web uploader, or run:
     ```bash
     git init && git add . && git commit -m "MTG Tabletop"
     git branch -M main
     git remote add origin https://github.com/<you>/mtg-tabletop.git
     git push -u origin main
     ```
3. In the repository, open **Settings → Pages → Build and deployment → Source: Deploy from a branch**.
4. Choose `main` / `(root)` and save.
5. After about a minute your site is live at `https://<you>.github.io/mtg-tabletop/`.

### Run locally

ES modules don't load from `file://`, so serve the folder with either of these:

```bash
python3 -m http.server 8000      # then open http://localhost:8000
# or
npx serve .
```

### Tests

```bash
node tests/engine.test.mjs
```

## How to play

1. **Set up the game.**
   - Pick a format and the number of players.
   - Paste a decklist for each player, or click a sample deck.
   - For Commander, put the commander under a `Commander` heading or add `*CMDR*` after its name.
   - Click **Check decks & start**.
2. **Mulligan.** Each player chooses Keep or Mulligan. Use the "viewing" selector to switch players.
3. **Take turns.**
   - Press **Next step** (or Space) to advance.
   - **Click** a card for its actions.
   - **Double-click** to cast/play a card from hand, or to tap a permanent for mana.
4. **Resolve spells.** Cast spells wait on the stack until you press **Resolve**. Then carry out the card's effect.
5. **Combat.**
   - In Declare Attackers, click a creature and choose **Attack**.
   - Press Next step.
   - The defender clicks their creatures and chooses **Block**.
   - Press Next step to deal damage.

## Project layout

```
index.html          page shell
css/style.css       styling (backdrop: assets/backdrop.jpg)
js/rules.js         deck parsing & validation, formats, mana costs
js/scryfall.js      Scryfall API client with caching & rate limiting
js/game.js          game engine (zones, turns, stack, combat, SBAs, Commander)
js/main.js          user interface
tests/              engine tests (Node)
```

## Ideas for next steps

- Online multiplayer, peer-to-peer via WebRTC (e.g. PeerJS), so friends can play from different computers.
- Drag-and-drop cards between zones.
- Attaching Auras and Equipment to permanents.

## Legal

MTG Tabletop is unofficial Fan Content permitted under the Wizards of the Coast Fan Content Policy. It is not approved or endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast. ©Wizards of the Coast LLC.

Card data and images are provided by Scryfall. Please respect [Scryfall's API guidelines](https://scryfall.com/docs/api).
