# RoliBot — Setup Guide (Windows)

This bot links a Discord user's Roblox account via Rolimons' phrase
verification, then can drive a real browser to create trade ads on their
behalf.

## What you need installed first

1. **Node.js** — download from https://nodejs.org (pick the "LTS" version).
   Run the installer, click Next through everything (defaults are fine).
2. That's it for system requirements. No database, no compiler needed.

## One-time setup

1. Open this folder in a terminal. On Windows: open the `rolibot` folder in
   File Explorer, then type `cmd` into the address bar and press Enter —
   that opens a command prompt already inside this folder.

2. Install everything:
   ```
   npm install
   npx playwright install chromium
   ```
   The second command downloads the actual browser the bot will control.
   It's a one-time ~150MB download.

3. Copy `.env.example` to a new file named exactly `.env` (no `.example`).
   Open `.env` in Notepad and fill in:
   - `DISCORD_BOT_TOKEN` — from the Bot page in the Discord Developer Portal
   - `DISCORD_CLIENT_ID` — from the General Information page (called
     "Application ID")
   - `COMMANDS_CHANNEL_ID`, `ERRORS_CHANNEL_ID`, `SUCCESS_CHANNEL_ID` — the
     three channel IDs you copied earlier (Developer Mode must be on in
     Discord to copy these: User Settings → Advanced → Developer Mode)

4. Register the slash commands with Discord (only needs to be done once,
   or again if you change the command list later):
   ```
   npm run register
   ```
   You should see "Done! Commands registered: startlogin, confirm, logout, status"

5. Start the bot:
   ```
   npm start
   ```
   You should see "Logged in as YourBotName#1234" — that means it's working.
   Leave this window open; closing it stops the bot. To stop it on purpose,
   click the window and press Ctrl+C.

## Testing it for the first time

Keep `SHOW_BROWSER=true` in your `.env` for now — this makes the automated
browser visible in a window so we can both watch what it does and fix
anything that doesn't match Rolimons' current page layout.

In Discord, in your `#commands` channel:
```
/startlogin roblox_id:YOUR_NUMERIC_ROBLOX_ID
```
A browser window should pop up, navigate to rolimons.com/verify, and the
bot should reply to you (visibly only to you) with a phrase.

Paste that phrase into your Roblox profile's "About" section, save it,
then run:
```
/confirm
```

If anything errors out or the browser does something unexpected, **don't
worry — this is expected on the first try.** Screenshot or describe what
the browser window showed and we'll fix the automation script together.

## Notes

- This currently only handles login/verification. The `/create` trade-ad
  builder, cooldown scheduling, and error/success channel routing for ads
  come next, once login is confirmed working.
- Each verified user gets a session file in the `sessions/` folder. Treat
  this folder as sensitive — anyone with these files could act as that
  user on Rolimons. Don't upload this folder anywhere public.
- Once everything is confirmed working, you can set `SHOW_BROWSER=false`
  in `.env` so the browser runs invisibly in the background.
