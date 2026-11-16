# LoL 5v5 Ban/Pick

[한국어](README.md) | **English**

A self-hosted, real-time draft (ban/pick) tool for League of Legends custom games.
One person runs the program, sends an invite link to each captain, and both captains draft in their browsers. Nothing to install for the captains, no accounts.

- Tournament draft order: 3 bans, 3 picks, 2 bans, 2 picks per team (20 steps)
- Per-turn time limit with a bar that shrinks from both edges to the centre
- If a team runs out of time the match is **stopped** (no auto-pick); the host resumes or restarts
- **First Selection** (the rule pro leagues adopted in 2026): one team chooses either a side or the pick order, the other team decides the rest
- Fearless mode, best-of-3 / best-of-5 series with a set score
- Draft music: LCK and Worlds champ-select tracks by year, played through YouTube
- Broadcast-style bar at the bottom, plus a transparent broadcast-only view for OBS
- Interface in Korean, English, Japanese, Simplified Chinese and Russian
- Server addresses are never shown on screen; invite links are copied with a button

## Run (Windows)

Download `lol-banpick.exe` from the Releases page and double-click it. Node.js is not required.
A console window shows the status and your browser opens. Closing the window stops the server.

The executable is not code-signed, so Windows may warn on first launch ("More info" → "Run anyway").

### Let people outside your network connect (one-time setup)

1. **Router port forwarding**: external TCP 3000 → TCP 3000 on the PC running the program.
2. **Windows Firewall**: choose "Allow access" when asked on first launch.
3. Create a room, then use the **Copy link** buttons under "Invite links" and send each link to that captain only.

Test from a different connection (for example mobile data); many routers cannot reach their own public address from inside.

### Without port forwarding

Set `"tunnel": true` in `config.json` and put `cloudflared.exe` (from the official Cloudflare releases) next to the program.
Invite links then use a temporary `trycloudflare.com` address, which also keeps your IP out of the links. The address changes on every start.

## How it works

| Role | Can do |
|---|---|
| Host (created the room) | Start, resume, undo, record the set winner, swap sides, change options, choose on any turn |
| Captain | Use First Selection (side or pick order), choose on their own team's turns, rename their team, enter player names |
| Broadcast view | View only |

- There is no spectator link. Spectators watch through screen sharing; connections without a key are refused.
- The captain links contain the server address. Send them privately.
- Creating a room only asks for the two team names. Before each game the team holding **First Selection** chooses **either** a side (blue/red) **or** the pick order (first/second), and the other team decides what is left. First Selection is random for game 1 (the host can hand it to the other team) and goes to the loser of the previous game afterwards. The first-pick team bans and picks first, on either side.
- A selected champion is previewed for everyone and the edge of its slot blinks until it is locked in.
- **Draft music** (bottom of the page) plays in your own browser only; share audio when screen sharing. Add any YouTube link, or edit `bgm.json` next to the program (`bgm.js` in the source). Listed videos are third-party uploads and may be removed or block embedding. No audio is included in this project; check the rights of each track before using it on a stream.
- After each game the host presses "**(team) wins**": the score box fills and the next game starts. Reaching the required wins ends the series.
- Room state lives in memory only. Restarting the server removes running rooms; idle rooms are removed after 12 hours.

## Language

Each viewer picks a language with the selector on the page; the choice is remembered in that browser.
The first visit follows the browser language. A link can force a language with `&lang=ko|en|ja|zh|ru`.
Champion names come from Data Dragon in the selected language.

To add a language, add one line to `LANGS` and one block to `I18N` in `public/index.html`, and the locale code to `LOCALES` in `server.js`. Missing keys fall back to English.

## config.json

Created next to the program on first run. Restart after editing.

| Key | Default | Meaning |
|---|---|---|
| `port` | 3000 | TCP port. Forward the same port on the router. |
| `publicHost` | empty | Address used in invite links. Empty = detect the public IP. Put a DDNS name here if your IP changes. |
| `showPublicIp` | false | Show the public address in the console window. |
| `tunnel` | false | Create a Cloudflare quick tunnel (needs `cloudflared.exe`). |
| `lang` | empty | Console language, `ko` or `en`. Empty = follow the system. |

## Run from source

Requires Node.js 18 or newer.

```bash
npm install
npm start          # http://localhost:3000
npm test           # end-to-end check against a running server
npm run build:exe  # builds dist/lol-banpick.exe
```

Behind a reverse proxy, forward WebSocket upgrades on `/ws`.

## Files

- `server.js` – HTTP + WebSocket server, draft rules, timers
- `champions.js` – built-in champion list (fallback) and position table
- `bgm.js` – default draft-music list (YouTube video IDs)
- `public/index.html` – the whole interface, including translations
- `test.js` – end-to-end check

## Legal

This project isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties. Riot Games and all associated properties are trademarks or registered trademarks of Riot Games, Inc.

Champion names and images are loaded from Riot's Data Dragon at run time and are not included in this repository.
