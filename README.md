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

## Important security notes
- Pair only WhatsApp accounts you own or are authorized to manage.
- The `sessions/` folder contains authentication material. Anyone who obtains it may be able to access the linked account.
- This starter is not a multi-user production service. Add authentication, stricter rate limiting, session cleanup, and monitoring before public use.
- WhatsApp/Baileys behavior can change; test with a spare account first.
- Persistent disks may require a paid Render plan; verify current plan eligibility in Render.
