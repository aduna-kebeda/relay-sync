# Relay

Group coordination app. Create a session, share an invite link, and view members on a map.

## Quick start

```bash
cd /home/aduna/play
source .venv/bin/activate
python server.py
```

Open **http://localhost:8000**

## Deploy (Render)

**https://render.com/deploy?repo=https://github.com/aduna-kebeda/relay-sync**

After deploy, note `ADMIN_TOKEN` under **Environment** in the Render dashboard.

## Environment variables

| Variable       | Description                                      |
|----------------|--------------------------------------------------|
| `ADMIN_TOKEN`  | Secret token for your overview page              |
| `PUBLIC_URL`   | Base URL for invite/view links                   |

## Tech

FastAPI, WebSockets, Leaflet. In-memory sessions — data clears when members leave (~2 min idle).
