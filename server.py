"""Relay coordination server."""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", secrets.token_urlsafe(16))
STALE_SECONDS = 120
STATE_FILE = Path(os.environ.get("STATE_FILE", "data/state.json"))


def _load_state() -> None:
    if not STATE_FILE.exists():
        return
    try:
        data = json.loads(STATE_FILE.read_text())
        room_tokens.update(data.get("room_tokens", {}))
        room_meta.update(data.get("room_meta", {}))
    except Exception:
        pass


def _save_state() -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps({"room_tokens": room_tokens, "room_meta": room_meta}))


def _valid_admin_token(room_id: str, token: str) -> bool:
    if token == ADMIN_TOKEN:
        return True
    stored = room_tokens.get(room_id)
    if stored is None and token:
        room_tokens[room_id] = token
        _save_state()
        return True
    return token == stored


def public_base_url() -> str:
    return (
        os.environ.get("PUBLIC_URL")
        or os.environ.get("RENDER_EXTERNAL_URL")
        or "http://localhost:8000"
    )

app = FastAPI(title="Relay")

# room_id -> { tracker_id -> LocationUpdate }
rooms: dict[str, dict[str, LocationUpdate]] = {}
# room_id -> admin token for that session
room_tokens: dict[str, str] = {}
# room_id -> session metadata
room_meta: dict[str, dict[str, float]] = {}
# room_id -> set of admin websocket connections
admin_connections: dict[str, set[WebSocket]] = {}
# room_id -> set of tracker websocket connections (for optional push)
tracker_connections: dict[str, dict[str, WebSocket]] = {}


@dataclass
class LocationUpdate:
    tracker_id: str
    name: str
    lat: float
    lng: float
    accuracy: float | None
    updated_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class CreateRoomResponse(BaseModel):
    room_id: str
    admin_token: str
    share_url: str
    admin_url: str


class JoinRoomRequest(BaseModel):
    name: str = Field(min_length=1, max_length=64)


class LocationPayload(BaseModel):
    lat: float
    lng: float
    accuracy: float | None = None


def _ensure_room(room_id: str) -> None:
    if room_id not in rooms:
        rooms[room_id] = {}
        admin_connections[room_id] = set()
        tracker_connections[room_id] = {}


def _prune_stale(room_id: str) -> None:
    now = time.time()
    trackers = rooms.get(room_id, {})
    stale = [tid for tid, loc in trackers.items() if now - loc.updated_at > STALE_SECONDS]
    for tid in stale:
        del trackers[tid]
        tracker_connections.get(room_id, {}).pop(tid, None)


async def _broadcast_to_admins(room_id: str) -> None:
    _prune_stale(room_id)
    payload = {
        "type": "locations",
        "trackers": [loc.to_dict() for loc in rooms.get(room_id, {}).values()],
    }
    dead: list[WebSocket] = []
    for ws in admin_connections.get(room_id, set()):
        try:
            await ws.send_json(payload)
        except Exception:
            dead.append(ws)
    for ws in dead:
        admin_connections[room_id].discard(ws)


@app.get("/")
async def index():
    return FileResponse("static/index.html")


@app.get("/share/{room_id}")
async def share_page(room_id: str):
    _ensure_room(room_id)
    return FileResponse("static/share.html")


@app.get("/admin/{room_id}")
async def admin_page(room_id: str):
    _ensure_room(room_id)
    return FileResponse("static/admin.html")


@app.post("/api/rooms", response_model=CreateRoomResponse)
async def create_room():
    room_id = secrets.token_urlsafe(8)
    room_token = secrets.token_urlsafe(16)
    _ensure_room(room_id)
    room_tokens[room_id] = room_token
    room_meta[room_id] = {"created_at": time.time()}
    _save_state()
    base = public_base_url()
    return CreateRoomResponse(
        room_id=room_id,
        admin_token=room_token,
        share_url=f"{base}/share/{room_id}",
        admin_url=f"{base}/admin/{room_id}?token={room_token}",
    )


@app.get("/api/rooms/{room_id}")
async def get_room(room_id: str):
    _ensure_room(room_id)
    _prune_stale(room_id)
    return {
        "room_id": room_id,
        "created_at": room_meta.get(room_id, {}).get("created_at"),
        "member_count": len(rooms[room_id]),
        "trackers": [loc.to_dict() for loc in rooms[room_id].values()],
    }


@app.post("/api/rooms/{room_id}/join")
async def join_room(room_id: str, body: JoinRoomRequest):
    _ensure_room(room_id)
    tracker_id = secrets.token_urlsafe(12)
    loc = LocationUpdate(
        tracker_id=tracker_id,
        name=body.name.strip(),
        lat=0.0,
        lng=0.0,
        accuracy=None,
    )
    rooms[room_id][tracker_id] = loc
    await _broadcast_to_admins(room_id)
    return {"tracker_id": tracker_id, "name": loc.name}


@app.post("/api/rooms/{room_id}/trackers/{tracker_id}/location")
async def update_location(room_id: str, tracker_id: str, body: LocationPayload):
    _ensure_room(room_id)
    tracker = rooms[room_id].get(tracker_id)
    if not tracker:
        raise HTTPException(status_code=404, detail="Tracker not found")

    tracker.lat = body.lat
    tracker.lng = body.lng
    tracker.accuracy = body.accuracy
    tracker.updated_at = time.time()

    await _broadcast_to_admins(room_id)
    return {"ok": True}


@app.websocket("/ws/admin/{room_id}")
async def admin_websocket(websocket: WebSocket, room_id: str, token: str):
    _ensure_room(room_id)
    if not _valid_admin_token(room_id, token):
        await websocket.close(code=4403)
        return

    _ensure_room(room_id)
    await websocket.accept()
    admin_connections[room_id].add(websocket)

    try:
        await websocket.send_json(
            {
                "type": "locations",
                "trackers": [loc.to_dict() for loc in rooms[room_id].values()],
            }
        )
        while True:
            await websocket.receive_text()  # ping keepalive from client
    except WebSocketDisconnect:
        pass
    finally:
        admin_connections[room_id].discard(websocket)


@app.websocket("/ws/track/{room_id}/{tracker_id}")
async def tracker_websocket(websocket: WebSocket, room_id: str, tracker_id: str):
    _ensure_room(room_id)
    tracker = rooms[room_id].get(tracker_id)
    if not tracker:
        await websocket.close(code=4404)
        return

    await websocket.accept()
    tracker_connections[room_id][tracker_id] = websocket

    try:
        while True:
            raw = await websocket.receive_text()
            data = json.loads(raw)
            if data.get("type") != "location":
                continue
            tracker.lat = float(data["lat"])
            tracker.lng = float(data["lng"])
            tracker.accuracy = data.get("accuracy")
            tracker.updated_at = time.time()
            await _broadcast_to_admins(room_id)
    except WebSocketDisconnect:
        pass
    finally:
        tracker_connections[room_id].pop(tracker_id, None)


@app.on_event("startup")
async def startup():
    _load_state()

    async def prune_loop():
        while True:
            for room_id in list(rooms.keys()):
                before = len(rooms[room_id])
                _prune_stale(room_id)
                if len(rooms[room_id]) != before:
                    await _broadcast_to_admins(room_id)
            await asyncio.sleep(30)

    asyncio.create_task(prune_loop())


app.mount("/static", StaticFiles(directory="static"), name="static")

if __name__ == "__main__":
    import uvicorn

    print(f"\n  Admin token: {ADMIN_TOKEN}\n")
    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run("server:app", host="0.0.0.0", port=port, reload=True)
