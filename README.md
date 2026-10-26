# HansXmd Session Generator

A Node.js/Express web interface for pairing a WhatsApp account using Baileys.

## Requirements
- Node.js 20 or newer
- A Render service with a persistent disk if you want auth files to survive restarts

## Run locally
```bash
npm install
npm start
```
Open http://localhost:3000

## Deploy on Render
1. Upload the complete folder to a GitHub repository.
2. Create a Render Blueprint from the repository, or create a Node web service.
3. Use `npm install` as the build command and `npm start` as the start command.
4. Set `SESSION_DIR` to the persistent disk mount path.
5. Keep the `sessions/` directory private; never commit it or expose it through static hosting.

## Session ID (MEGA)
After linking, the server uploads `creds.json` to your MEGA account and sends a short ID like `HansTz&fileId#key` to your WhatsApp "Message yourself" chat, then deletes its local copy.
Set these environment variables (Render > Environment): `MEGA_EMAIL`, `MEGA_PASSWORD`. Use a dedicated MEGA account.

## Linking tips
- Pairing code: enter the number with country code, digits only (e.g. 2348012345678). Enter the code within ~1 minute: WhatsApp > Linked devices > Link a device > Link with phone number instead.
- The status must change to `connected`. After you enter the code the page briefly shows `reconnecting` - that is normal.
- If linking fails, delete the old linked-device entry in WhatsApp and generate a fresh code.
- `@whiskeysockets/baileys` is set to `latest`; run `npm update` to refresh.

## Important security notes
- Pair only WhatsApp accounts you own or are authorized to manage.
- The `sessions/` folder contains authentication material. Anyone who obtains it may be able to access the linked account.
- This starter is not a multi-user production service. Add authentication, stricter rate limiting, session cleanup, and monitoring before public use.
- WhatsApp/Baileys behavior can change; test with a spare account first.
- Persistent disks may require a paid Render plan; verify current plan eligibility in Render.
