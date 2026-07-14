# Live Location Tracker

A small web app to receive **live GPS locations** from people who voluntarily share them. You get a dashboard with a real-time map.

## How it works

1. **You** create a tracking room on the home page.
2. **Share the link** with people (they must agree to share location).
3. They open the link on their phone, enter their name, and tap **Start sharing**.
4. **You** open the admin dashboard and see everyone moving on a map in real time.

## Quick start

```bash
cd /home/aduna/play
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python server.py
```

Open **http://localhost:8000** in your browser.

On first run, the server prints an **admin token** in the terminal. Keep it secret — it protects your dashboard.

## Using on phones (same Wi‑Fi)

Phones need to reach your computer. Find your LAN IP:

```bash
hostname -I
```

Then set the public URL and restart:

```bash
export PUBLIC_URL=http://YOUR_LAN_IP:8000
python server.py
```

Create a room and send people: `http://YOUR_LAN_IP:8000/share/ROOM_ID`

## Deploy (Render)

1. Push this repo to GitHub (already done if you used the setup below).
2. Go to [Render Dashboard](https://dashboard.render.com/) → **New** → **Blueprint**.
3. Connect your GitHub repo — Render reads `render.yaml` automatically.
4. After deploy, copy your app URL (e.g. `https://live-location-tracker.onrender.com`).
5. In Render → your service → **Environment**, note the auto-generated `ADMIN_TOKEN` (or set your own).

Share links will use your Render URL automatically via `RENDER_EXTERNAL_URL`.

One-click deploy (connect GitHub, then click Deploy):

**https://render.com/deploy?repo=https://github.com/aduna-kebeda/live-location-tracker**

After deploy, open your service URL and create a room. Find `ADMIN_TOKEN` under **Environment** in the Render dashboard.

### Auto-deploy on push (optional)

1. Deploy once via the link above.
2. In Render → your service → copy the **Service ID** (`srv-...`).
3. In GitHub → repo **Settings → Secrets → Actions**, add:
   - `RENDER_API_KEY` — from [Render Account Settings → API Keys](https://dashboard.render.com/u/settings#api-keys)
   - `RENDER_SERVICE_ID` — your service ID
4. Future pushes to `main` redeploy automatically.

## Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit: live location tracker"
gh repo create live-location-tracker --public --source=. --push
```

## Environment variables

| Variable       | Description                                      |
|----------------|--------------------------------------------------|
| `ADMIN_TOKEN`  | Secret token for admin dashboard (auto-generated if unset) |
| `PUBLIC_URL`   | Base URL used in share/admin links (default: `http://localhost:8000`) |

## Important

- **Consent only** — only track people who explicitly agree.
- Location is sent **while the share page stays open** in the browser.
- For use over the internet (not just LAN), deploy behind HTTPS (e.g. ngrok, a VPS, or Railway).

## Tech

- **Backend:** FastAPI + WebSockets
- **Map:** Leaflet + OpenStreetMap
- **No database** — locations are in memory and cleared when someone stops sharing or goes offline (~2 min)
