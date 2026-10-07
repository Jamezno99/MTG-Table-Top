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
- **Online play, free.** One player hosts and friends join with a room code or invite link, from any computer or phone (see [Playing online](#playing-online)).
- **Phone friendly.** Tapping a card opens a menu with a "Read card" view. Your hand docks to the bottom of the screen, and dialogs slide up from the bottom.
- **Pass-and-play.** 1–4 players on one screen. Hands are hidden between turns.
- **Playmat board.** Each player has their own mat:
  - a life medallion in their commander's colors
  - creatures in front and lands behind, mirrored for opponents across the table
  - piles for the command zone, library, graveyard and exile
- **Matches.** **🏳 Forfeit** ends the game for you. After a winner is decided, **🔁 Rematch** starts a new game with the same decks and keeps a running score. In 1v1 the loser goes first. Works online too.
- **Animated.** A boot screen when the app opens, plus animation for cards drawn, played and tapped, life changes, mana, phase changes and each new turn. It all switches off when the device is set to reduce motion.
- **Quality of life.** Undo (Ctrl+Z), and automatic saving in your browser.

### Card text: what the app understands

The app reads each card's Oracle text and carries out the common patterns itself. Tap a card and choose **Read card** (or hover on desktop) to see **"What the app does with this card"**: each ability is listed as automatic or by hand.

- **Spells.** Targets are chosen when you cast, and the effect happens when the spell resolves. A spell with no legal targets left fizzles, and hexproof and shroud are respected. Supported effects include:
  - damage, drawing, life gain and loss, destroy, exile, bounce, tap/untap, counters, pump, fight
  - tokens, including Treasure, Food, Clue and the other named tokens
  - countering spells, searching your library, mill, discard, scry, looking at the top cards
  - modal "Choose one" spells
- **Triggered abilities.** Enters, dies, attacks, cast, upkeep/end step and damage-to-player triggers go on the stack automatically, in the correct order. "You may" asks you, and "Whenever … for the first time" / "if …" conditions are checked.
- **Static abilities.** These are applied automatically:
  - lords ("Other Goblins get +1/+1")
  - granted keywords
  - Equipment and Aura bonuses
  - cost reducers
  - devotion gods
  - Coat of Arms-style effects
- **Activated abilities.** Every ability shows in the card's menu with its full cost: mana, {T}, sacrifice, discard, life or loyalty. Equip, cycling, ninjutsu and channel are included.
- **Alternative and extra costs.** These are supported:
  - "Pay N life" instead of mana (Snuff Out style)
  - additional costs (sacrifice, discard, pay life)
  - kicker, flashback, and "costs {N} less"
- **Mana sources.** Pain lands deal their damage, and shock lands ask whether to pay 2 life. Fast lands, check lands and tapped lands enter correctly. Treasure sacrifices itself, and Signets take their {1}. "Any color in your commander's identity" and "for each Elf" mana are also handled. Auto-pay uses free sources before painful ones.
- **Anything else** (rare or complex wording) is flagged "by hand". Resolve it with **By hand** on the stack and use the card menus. Any rules check can be overridden with **"Do it anyway"**.

### Turn automation

These can be switched off in **☰ → Settings → Automation**:

- **Auto upkeep.** Untap and upkeep pass automatically unless something triggers.
- **Auto draw.** You draw for the turn and go straight to Main 1.
- **Force cleanup.** At end of turn you must discard down to 7 before the turn passes.
- **Auto triggers.** Triggered abilities are put on the stack for you.

### Your hand on a phone

Tap **⤢ View hand** (or swipe up on your hand) for a full-screen view. It shows large cards, can sort by order drawn, mana value or type, and has a Play/Cast button under each card.

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
node tests/effects.test.mjs
```

## How to play

1. **Set up the game.**
   - Pick a format and the number of players.
   - Paste a decklist for each player, or click a sample deck.
   - For Commander, put the commander under a `Commander` heading or add `*CMDR*` after its name.
   - Moxfield's plain-text export works as-is: the deck comes first, then the commander on its own after a blank line. The app detects it and says so in the report. In 60-card formats, that last group is read as the sideboard.
   - Click **Check decks & start**.
2. **Mulligan.** Each player chooses Keep or Mulligan. Use the "viewing" selector to switch players.
3. **Take turns.** The turn tracker in the middle of the table shows whose turn it is, the phase (Beginning, Main 1, Combat, Main 2, End) and the step. Tap a later phase to skip ahead to it.
   - Above your hand, the action bar has one-tap Draw, Draw X, Scry, Search, Shuffle, Mill, Token and Untap all. Tapping your library pile does the same, and **D** draws a card.

   - Press **Next step** (or Space) to advance.
   - **Click** a card for its actions.
   - **Double-click** to cast/play a card from hand, or to tap a permanent for mana.
4. **Resolve spells.** Cast spells and triggers wait on the stack until you press **Resolve**. The app then carries out the card's effect, asking you for any choices. **By hand** resolves it without automation.
5. **Combat.**
   - In Declare Attackers, click a creature and choose **Attack**.
   - Press Next step.
   - The defender clicks their creatures and chooses **Block**.
   - Press Next step to deal damage.

## Playing online

Online play is peer-to-peer (WebRTC via [PeerJS](https://peerjs.com)) and costs nothing to run:

1. **Host.** Choose **Host online**, pick the format, paste your deck and press **Create room**. You'll get a 6-letter room code and an invite link.
2. **Friends join.** They open the invite link, or choose **Join online** and type the code. Then they enter a name, paste a deck and press **Join room**. Up to 4 players.
3. **Lobby.** Everyone can see each deck's legality in the lobby. A player can fix their deck and press **Send updated deck**.
4. **Start.** The host presses **Start game**.

How it works:

- **The host's browser runs the game.** The host must keep the tab open. If the host's tab closes, the game is saved: the host chooses **Resume saved game → Host again**, and everyone rejoins with the same link.
- **Hidden information stays hidden.** Each player's browser only receives their own hand. Opponents' hands and every library order are hidden. The host's computer does hold the full game, so it's built for playing with people you trust.
- **Dropped connections.** If you drop, reopen the invite link and join with **the same name** to get your seat back.
- **Taking turns.** Only the active player normally advances the turn. Anyone can still advance it for a player who has disconnected, after a confirmation.
- **Chat.** Use the box under the game log.

**If a friend can't connect** (some strict work or school networks block direct connections):

1. Sign up for a free TURN relay, for example the free tier at metered.ca.
2. Add its details to `EXTRA_ICE_SERVERS` at the top of `js/net.js`.

PeerJS's free public server only introduces the browsers to each other. After that, game data flows directly between players.

## Android app (MTG Sim)

This repository also builds an Android app called **MTG Sim** (with its own icon). It is the same code as the website wrapped in an app, so online play works in every direction: app with app, app with website, and website with website.

**How you get the APK:** GitHub builds it for you, free.

1. Push this repository to GitHub (the workflow is in `.github/workflows/android-apk.yml`).
2. GitHub builds the app in a few minutes. Watch it in the **Actions** tab.
3. The APK appears on your repository's **Releases** page as **MTG Sim for Android → `MTG-Sim.apk`**.
4. Every later push rebuilds it, so the app always matches the website.

**Installing:**

1. On an Android phone, open the Releases page and download `MTG-Sim.apk`.
2. Open the file. Android asks you to allow installs from your browser or files app; allow it once.
3. Send friends the same Releases link.

**Signing key (do this once, recommended):** an Android update only installs over the old app if both are signed with the same key.

1. Add the two secrets from the private `mtg-sim-signing-key.zip` under **Settings → Secrets and variables → Actions**:
   - `ANDROID_KEYSTORE_BASE64`
   - `ANDROID_KEYSTORE_PASSWORD`
2. Without them the app still builds and installs, but each new version needs the old one uninstalled first, which also clears its saved decks.
3. Never commit the key file to the repository.

**Good to know:**

- **Invite links.** An invite link made in the app opens your GitHub Pages website, so friends without the app can join in the browser. App users can just type the room code.
- **Keeping the game alive.** The app keeps the screen on, because whoever hosts has to keep the game open.
- **Version check.** If an old app and a newer website (or the other way round) try to play together, both get a clear "version mismatch, please update" message instead of a broken game. If you change the online messages in `js/net.js`, bump `PROTOCOL` there.
- **Building on your own computer (optional).** Copy `index.html`, `css/`, `js/` and `assets/` into `android/app/src/main/assets/www/`, then open the `android` folder in Android Studio.

## Project layout

```
index.html          page shell
css/style.css       styling (backdrop: assets/backdrop.jpg)
js/rules.js         deck parsing & validation, formats, mana costs
js/scryfall.js      Scryfall API client with caching & rate limiting
js/game.js          game engine (zones, turns, stack, combat, SBAs, Commander)
js/effects.js       card-text reader: abilities, costs, triggers, statics, effects
js/net.js           online play: PeerJS host/guest, hidden-information filtering
js/main.js          user interface (setup, lobby, board, phone layout)
js/config.js        deployment settings (the Android build fills in the website address)
android/            the MTG Sim Android app (WebView wrapper, icons)
.github/workflows/  builds the APK on every push
tests/              engine tests (Node)
```

## Ideas for next steps

- A dedicated game server (about $5–10/month) for public matchmaking and hands that are hidden even from the host.
- Drag-and-drop cards between zones.

## Legal

MTG Tabletop is unofficial Fan Content permitted under the Wizards of the Coast Fan Content Policy. It is not approved or endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast. ©Wizards of the Coast LLC.

Card data and images are provided by Scryfall. Please respect [Scryfall's API guidelines](https://scryfall.com/docs/api).
