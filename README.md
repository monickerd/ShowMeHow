# QuickHelp

Lightweight 1:1 screen sharing for tech support. No accounts, no plugins — just share a link and go.

Built with Node.js, WebRTC, and WebSockets. Zero runtime dependencies beyond `ws`.

## How it works

1. The helper opens the app and clicks **Start a session** to generate a room link.
2. They send the link to the person who needs help.
3. The person clicks the link, grants screen-share permission, and the helper sees their screen live.

Rooms are ephemeral — they're created on demand and deleted when both participants disconnect.

## Running locally

```bash
npm install
npm run dev       # starts on http://localhost:8383 with --watch
```

## Running with Docker

```bash
docker compose up --build
```

The app listens on port `8383` by default. Set `BASE_URL` to your public hostname so generated room links are correct:

```bash
BASE_URL=https://share.example.com docker compose up -d
```

## TURN server (optional)

WebRTC works peer-to-peer, but clients behind strict NAT or firewalls may need a TURN relay. Configure one via environment variables:

| Variable | Description |
|---|---|
| `TURN_URLS` | Comma-separated list of TURN/TURNS endpoints |
| `TURN_USERNAME` | TURN credential username |
| `TURN_CREDENTIAL` | TURN credential password |

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8383` | HTTP listen port |
| `BASE_URL` | `http://localhost:{PORT}` | Public base URL for room links |
| `TURN_URLS` | — | TURN server endpoints |
| `TURN_USERNAME` | — | TURN username |
| `TURN_CREDENTIAL` | — | TURN password |
