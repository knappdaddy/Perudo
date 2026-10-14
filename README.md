# 🎲 Perudo! 🦙

Liar's dice for liars & llamas. It's a multiplayer, phone-first take on Perudo that you play in the browser. There's nothing to install: one person makes a room, everyone else scans the QR code or taps the invite link, and the lying begins.

## Features

- **Rooms with 4-letter codes**, invite links and a QR code for friends sitting at the same table
- **Full Perudo rules**: wild aces (🦙 llamas!), halving and doubling when you switch to or from aces, **Dudo**, **Calza**, and **Palifico** rounds
- **House rules**: 1–6 starting dice, with Calza and Palifico each switchable on or off
- **Bots** to fill empty seats (2–8 players in total)
- **Made for phones**: big tap targets, a confirm tap on Dudo and Calza so you can't call one by accident, a "hide my dice" cup for nosy neighbours, buzz on your turn, and a screen that stays awake while you play
- **Survives flaky connections**: if your phone locks or drops signal you get your seat back on reconnect. If you're gone for 40 seconds on your turn, a bot plays it for you.
- **Emote reactions** (🤥 😂 🔥 …), synthesized sound effects with a mute button, and confetti for the winner
- The server deals and resolves every round, so nobody can peek at other players' dice from their browser

## Run it locally

```bash
npm install
npm start          # → http://localhost:3000
```

To play with phones on the same Wi-Fi, open `http://<your-computer's-LAN-IP>:3000` on each phone.

`npm run dev` restarts the server on file changes. `npm test` runs the rules, game-flow and WebSocket tests.

## Put it on the internet

It's one small Node process (HTTP and WebSockets on the same port) with no database, so any Node host works. Rooms live in memory, so a restart or redeploy ends any games in progress.

- **Render**: push this repo to GitHub, then choose *New → Blueprint* and pick the repo. `render.yaml` sets everything up. The free tier sleeps when idle, so the first visit after a break takes about 30 seconds.
- **Fly.io / Railway / anything with Docker**: use the included `Dockerfile`. The app listens on `$PORT`.

Run a **single instance**: rooms aren't shared between servers.

## How it's built

```
server/index.js   HTTP static server + WebSocket hub (ws)
server/room.js    Game state machine: lobby → bidding → reveal → game over
server/bot.js     Probability-based bot (it only sees its own dice)
public/rules.js   Bid/count rules, shared by the server and the browser
public/app.js     Vanilla-JS client, no build step
public/style.css  The look: chunky outlines, hard shadows, Andean zigzags
```

## Rules in 30 seconds

Everyone shakes their dice in secret. Take turns bidding on how many dice on the **whole table** show a face ("seven 4s"). Each bid must go up: either more dice, or the same number on a higher face. **Aces are wild.** On your turn, if you think the last bid is a lie, call **Dudo!** If you're right the bidder loses a die; if you're wrong, you do. Anyone except the bidder can call **Calza!** to say the bid is *exactly* right: get it right and you win a die back, get it wrong and you lose one. The first time a player drops to one die, the next round is **Palifico**: aces aren't wild and the face can't change. The last player with dice wins.
