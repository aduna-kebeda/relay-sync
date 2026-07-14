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

from fastapi import FastAPI, File, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", secrets.token_urlsafe(16))
STALE_SECONDS = 600
STATE_FILE = Path(os.environ.get("STATE_FILE", "data/state.json"))
UPLOAD_DIR = Path(os.environ.get("UPLOAD_DIR", "data/uploads"))
MAX_PHOTO_BYTES = 10 * 1024 * 1024
ALLOWED_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif"}


def _save_state() -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    trackers_data = {
        room_id: {tid: loc.to_dict() for tid, loc in room_trackers.items()}
        for room_id, room_trackers in rooms.items()
        if room_trackers
    }
    STATE_FILE.write_text(
        json.dumps(
            {
                "room_tokens": room_tokens,
                "room_meta": room_meta,
                "trackers": trackers_data,
                "photos": photos,
            }
        )
    )


def _load_state() -> None:
    if not STATE_FILE.exists():
        return
    try:
        data = json.loads(STATE_FILE.read_text())
        room_tokens.update(data.get("room_tokens", {}))
        room_meta.update(data.get("room_meta", {}))
        photos.clear()
        photos.extend(data.get("photos", []))
        for room_id, room_trackers in data.get("trackers", {}).items():
            _ensure_room(room_id)
            now = time.time()
            for tid, loc in room_trackers.items():
                if now - loc.get("updated_at", 0) > STALE_SECONDS:
                    continue
                rooms[room_id][tid] = LocationUpdate(
                    tracker_id=loc["tracker_id"],
                    name=loc["name"],
                    lat=loc["lat"],
                    lng=loc["lng"],
                    accuracy=loc.get("accuracy"),
                    updated_at=loc["updated_at"],
                )
    except Exception:
        pass


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
# uploaded photos metadata (persisted)
photos: list[dict[str, Any]] = []


@dataclass
class PhotoRecord:
    photo_id: str
    room_id: str
    tracker_id: str
    name: str
    filename: str
    uploaded_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _room_photos(room_id: str) -> list[dict[str, Any]]:
    return [p for p in photos if p["room_id"] == room_id]


def _photo_by_id(room_id: str, photo_id: str) -> dict[str, Any] | None:
    for p in photos:
        if p["room_id"] == room_id and p["photo_id"] == photo_id:
            return p
    return None


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
    if stale:
        _save_state()


async def _broadcast_to_admins(room_id: str) -> None:
    _prune_stale(room_id)
    payload = {
        "type": "update",
        "trackers": [loc.to_dict() for loc in rooms.get(room_id, {}).values()],
        "photos": _room_photos(room_id),
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


@app.get("/download/cashrush.apk")
async def download_apk():
    path = Path("static/cashrush.apk")
    if not path.exists():
        raise HTTPException(status_code=404, detail="APK not built yet")
    return FileResponse(
        path,
        media_type="application/vnd.android.package-archive",
        filename="CashRush.apk",
    )


@app.get("/share/{room_id}")
async def share_page(room_id: str):
    _ensure_room(room_id)
    return FileResponse("static/share.html")


@app.get("/admin/{room_id}")
async def admin_page(room_id: str, request: Request):
    _ensure_room(room_id)
    base = public_base_url() or str(request.base_url).rstrip("/")
    invite_url = f"{base}/share/{room_id}"
    html = (Path("static/admin.html").read_text()
            .replace("__ROOM_ID__", room_id)
            .replace("__INVITE_URL__", invite_url))
    return HTMLResponse(html)


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
        "photos": _room_photos(room_id),
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
    _save_state()
    await _broadcast_to_admins(room_id)
    return {"tracker_id": tracker_id, "name": loc.name}


@app.get("/api/rooms/{room_id}/trackers/{tracker_id}")
async def get_tracker(room_id: str, tracker_id: str):
    _ensure_room(room_id)
    tracker = rooms[room_id].get(tracker_id)
    if not tracker:
        raise HTTPException(status_code=404, detail="Not found")
    return tracker.to_dict()


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
    _save_state()

    await _broadcast_to_admins(room_id)
    return {"ok": True}


@app.post("/api/rooms/{room_id}/trackers/{tracker_id}/photos")
async def upload_photo(
    room_id: str,
    tracker_id: str,
    file: UploadFile = File(...),
):
    _ensure_room(room_id)
    tracker = rooms[room_id].get(tracker_id)
    if not tracker:
        raise HTTPException(status_code=404, detail="Tracker not found")

    if not file.content_type or not file.content_type.startswith("image/"):
        ext = Path(file.filename or "photo.jpg").suffix.lower()
        if ext not in ALLOWED_EXT:
            raise HTTPException(status_code=400, detail="Images only")

    ext = Path(file.filename or "photo.jpg").suffix.lower()
    if ext not in ALLOWED_EXT:
        ext = ".jpg"

    raw = await file.read()
    if len(raw) > MAX_PHOTO_BYTES:
        raise HTTPException(status_code=400, detail="File too large (max 10MB)")

    photo_id = secrets.token_urlsafe(10)
    filename = f"{photo_id}{ext}"
    dest_dir = UPLOAD_DIR / room_id
    dest_dir.mkdir(parents=True, exist_ok=True)
    (dest_dir / filename).write_bytes(raw)

    record = PhotoRecord(
        photo_id=photo_id,
        room_id=room_id,
        tracker_id=tracker_id,
        name=tracker.name,
        filename=filename,
    )
    photos.append(record.to_dict())
    _save_state()
    await _broadcast_to_admins(room_id)
    return {"ok": True, "photo_id": photo_id}


@app.get("/api/rooms/{room_id}/photos")
async def list_photos(room_id: str, token: str):
    _ensure_room(room_id)
    if not _valid_admin_token(room_id, token):
        raise HTTPException(status_code=403, detail="Forbidden")
    return {"photos": _room_photos(room_id)}


@app.get("/api/rooms/{room_id}/photos/{photo_id}/file")
async def get_photo_file(room_id: str, photo_id: str, token: str):
    if not _valid_admin_token(room_id, token):
        raise HTTPException(status_code=403, detail="Forbidden")
    record = _photo_by_id(room_id, photo_id)
    if not record:
        raise HTTPException(status_code=404, detail="Not found")
    path = UPLOAD_DIR / room_id / record["filename"]
    if not path.exists():
        raise HTTPException(status_code=404, detail="File missing")
    return FileResponse(path)


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
                "type": "update",
                "trackers": [loc.to_dict() for loc in rooms[room_id].values()],
                "photos": _room_photos(room_id),
            }
        )
        while True:
            await websocket.receive_text()  # ping keepalive from client
    except WebSocketDisconnect:
        pass
    finally:
        admin_connections[room_id].discard(websocket)


@app.post("/api/rooms/{room_id}/trackers/{tracker_id}/ping")
async def tracker_ping(room_id: str, tracker_id: str):
    _ensure_room(room_id)
    tracker = rooms[room_id].get(tracker_id)
    if not tracker:
        raise HTTPException(status_code=404, detail="Tracker not found")
    tracker.updated_at = time.time()
    _save_state()
    await _broadcast_to_admins(room_id)
    return {"ok": True}


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
            if raw == "ping":
                tracker.updated_at = time.time()
                _save_state()
                continue
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if data.get("type") == "ping":
                tracker.updated_at = time.time()
                _save_state()
                continue
            if data.get("type") != "location":
                continue
            tracker.lat = float(data["lat"])
            tracker.lng = float(data["lng"])
            tracker.accuracy = data.get("accuracy")
            tracker.updated_at = time.time()
            _save_state()
            await _broadcast_to_admins(room_id)
    except WebSocketDisconnect:
        pass
    finally:
        tracker_connections[room_id].pop(tracker_id, None)


@app.on_event("startup")
async def startup():
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
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
