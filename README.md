# 🎲 Perudo! 🦙

Liar's dice for liars & llamas. It's a multiplayer, phone-first take on Perudo that you play in the browser. There's nothing to install: one person makes a room, everyone else scans the QR code or taps the invite link, and the lying begins.

**▶ Play: https://knappdaddy.github.io/Perudo/**

## Features

- **Rooms with 4-letter codes**, invite links and a QR code for friends sitting at the same table
- **Full Perudo rules**: wild aces (🦙 llamas!), halving and doubling when you switch to or from aces, **Dudo**, **Calza**, and **Palifico** rounds
- **House rules**: 1–6 starting dice, with Calza and Palifico each switchable on or off
- **Bots** to fill empty seats (2–8 players in total)
- **Made for phones**: big tap targets, a confirm tap on Dudo and Calza so you can't call one by accident, a "hide my dice" cup for nosy neighbours, buzz on your turn, and a screen that stays awake while you play
- **Survives flaky connections**: if your phone locks or drops signal you get your seat back on reconnect. If you're gone for 40 seconds on your turn, a bot plays it for you.
- **No server needed**: it runs on GitHub Pages
- **Emote reactions** (🤥 😂 🔥 …), synthesized sound effects with a mute button, and confetti for the winner
- The host (or the server) deals and resolves every round, and only sends each phone its own dice, so guests can't peek at other players' dice from their browser

## Play it

**https://knappdaddy.github.io/Perudo/** is hosted free on GitHub Pages, with no server.

On GitHub Pages there's no game server. Whoever taps *New room* hosts the game in their own browser, and phones swap small messages through free public MQTT brokers over secure WebSockets. That gets through practically any Wi-Fi or mobile network. The host listens on several brokers at once (EMQX, HiveMQ, and Eclipse on port 443), so one broker going down doesn't break games. Some things to know:

- **The host keeps their screen open.** The game lives on the host's phone. If the host reloads, the game is restored from their phone's storage and everyone reconnects automatically. If the host locks their phone for a while, other players freeze until the host comes back.
- If a guest's phone locks or reloads, they get their seat back. If a guest is gone for 40 seconds on their turn, a bot plays it for them.
- **Public brokers are public.** Messages aren't encrypted end to end, so someone who guessed your room code and went looking could read the game traffic. That's fine for a dice game with friends, but don't send anything secret. To use your own broker, list it under `brokers` in `public/config.js`.

Every push to `main` that touches `public/` redeploys the site through `.github/workflows/pages.yml`.

## Run it locally

Any static file server works, because `public/` is the whole app:

```bash
npx serve public          # relay mode, just like GitHub Pages
```

There's also an optional Node server that runs every room centrally over WebSockets. It's sturdier, since nobody's phone has to stay awake, but it needs a host that runs Node (Render, Fly, Railway; there's a `render.yaml` and a `Dockerfile`):

```bash
npm install
npm start                 # → http://localhost:3000 (server mode)
```

`npm test` runs the rules, game-flow and WebSocket tests.

## How it's built

```
public/game/rules.js  Bid/count rules
public/game/room.js   Game state machine: lobby → bidding → reveal → game over
public/game/bot.js    Probability-based bot (it only sees its own dice)
public/game/hub.js    Routes players' messages to rooms, over any transport
public/net.js         The browser's link: MQTT relay, or WebSocket to the Node server
public/mqtt-lite.js   A tiny MQTT-over-WebSocket client (connect, subscribe, publish)
public/config.js      Picks the mode ('relay' by default; the Node server overrides it)
public/app.js         Vanilla-JS UI, no build step
public/style.css      The look: chunky outlines, hard shadows, Andean zigzags
server/index.js       Optional Node server (static files + WebSockets)
```

The same game engine (`public/game/`) runs on the Node server or in the host's browser.

## Rules in 30 seconds

Everyone shakes their dice in secret. Take turns bidding on how many dice on the **whole table** show a face ("seven 4s"). Each bid must go up: either more dice, or the same number on a higher face. **Aces are wild.** On your turn, if you think the last bid is a lie, call **Dudo!** If you're right the bidder loses a die; if you're wrong, you do. Anyone except the bidder can call **Calza!** to say the bid is *exactly* right: get it right and you win a die back, get it wrong and you lose one. The first time a player drops to one die, the next round is **Palifico**: aces aren't wild and the face can't change. The last player with dice wins.
