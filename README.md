# FivesTracker

Single-file mobile-first 5-a-side match tracker. Vanilla JS, zero dependencies, works offline from `file://` or hosted as static.

## Features

- 8-player editable roster
- Live match mode: tap-to-log goals, subs, cards with a real-time clock
- Post-match backfill mode for matches you didn't track live
- Deterministic per-player minutes / matches / goals across the season
- JSON export/import for full backup + device transfer
- 360px sideline-ready: one-handed, big tap targets, no modal labyrinth

## Run locally

Open `index.html` in any browser. That's it.

## Deploy

Static hosting — Vercel auto-detects. No build step.

## Cloud sync (Vercel KV)

The Roster tab has a **Cloud sync** card that syncs the entire app state across
devices using a 6-digit code. Anyone with the code reads + writes the same
blob — no accounts, no email, no sign-in friction on the sideline.

**One-time setup on Vercel:**

1. Open the project in the Vercel dashboard.
2. Go to **Storage → Browse Marketplace** and add the **Upstash for Redis** (or
   Vercel KV → Upstash) integration.
3. Connect it to the FivesTracker project. Vercel auto-injects the env vars
   `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
4. Redeploy. The `/api/sync` Edge function will start working.

**On the device:**

- First device: open the app → Roster → Cloud sync → tap **Generate new code**.
  The code is copied to your clipboard and saved on the device.
- Other devices: open the app → Roster → Cloud sync → type the same code → tap
  **Connect**. The cloud copy is pulled.
- After that, every change auto-pushes (1.5 s debounce). On boot, if the cloud
  has a newer copy than this device, you're asked before it's adopted.

**Capability model:** the code IS the auth. Anyone with it has full read +
write. Don't share it outside the team. Generate a new one if it leaks
(connecting all devices to the new code re-establishes the team blob).

The KV blob is keyed by `fives:<code>`, capped at 256 KB (typical state is a
few KB). No PII beyond player names entered by the coach.
