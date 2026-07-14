const roomId = window.location.pathname.split('/').pop();
const joinForm = document.getElementById('join-form');
const sharing = document.getElementById('sharing');
const errorEl = document.getElementById('error');
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const coordsEl = document.getElementById('coords');
const statusText = document.getElementById('status-text');
const statusSub = document.getElementById('status-sub');
const statusPanel = document.getElementById('status-panel');
const statusRing = document.getElementById('status-ring');
const personNameEl = document.getElementById('person-name');
const signalEl = document.getElementById('signal-status');
const lastUpdateEl = document.getElementById('last-update');

let watchId = null;
let ws = null;
let trackerId = null;
let lastSent = 0;
let tickTimer = null;

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.classList.remove('hidden');
  statusPanel.classList.add('error-state');
}

function hideError() {
  errorEl.classList.add('hidden');
  statusPanel.classList.remove('error-state');
}

function setConnected(active) {
  statusRing.classList.toggle('static', active);
  statusPanel.classList.toggle('waiting', !active);
  statusText.textContent = active ? 'Connected' : 'Connecting…';
  statusSub.textContent = active ? 'Session active' : 'Establishing link…';
}

function stopSharing() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  if (ws) { ws.close(); ws = null; }
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  trackerId = null;
  sharing.classList.add('hidden');
  joinForm.classList.remove('hidden');
  setConnected(false);
}

async function sendLocation(lat, lng, accuracy) {
  if (!trackerId) return;
  const payload = { lat, lng, accuracy };
  lastSent = Date.now();
  lastUpdateEl.textContent = 'just now';
  signalEl.textContent = `±${Math.round(accuracy)}m`;

  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'location', ...payload }));
    return;
  }
  await fetch(`/api/rooms/${roomId}/trackers/${trackerId}/location`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

function connectWs() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws/track/${roomId}/${trackerId}`);

  ws.onopen = () => setConnected(true);

  ws.onclose = () => {
    setConnected(false);
    statusSub.textContent = 'Reconnecting…';
    setTimeout(() => { if (trackerId) connectWs(); }, 2000);
  };
}

async function startSharing() {
  hideError();
  const name = document.getElementById('name').value.trim();
  if (!name) { showError('Please enter your name.'); return; }
  if (!navigator.geolocation) { showError('Geolocation is not supported on this device.'); return; }

  Relay.setLoading(startBtn, true, 'Join session', 'Joining…');

  try {
    const joinRes = await fetch(`/api/rooms/${roomId}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!joinRes.ok) throw new Error('Could not join session.');
    const { tracker_id } = await joinRes.json();
    trackerId = tracker_id;

    joinForm.classList.add('hidden');
    sharing.classList.remove('hidden');
    personNameEl.textContent = name;
    setConnected(false);
    connectWs();

    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        coordsEl.textContent = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
        signalEl.textContent = `±${Math.round(accuracy)}m · Good`;
        setConnected(true);
        sendLocation(latitude, longitude, accuracy);
      },
      (err) => {
        statusText.textContent = 'Permission needed';
        statusSub.textContent = 'Enable location in browser settings';
        signalEl.textContent = 'Unavailable';
        showError(err.message || 'Could not access location.');
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );

    tickTimer = setInterval(() => {
      if (!lastSent) return;
      const sec = Math.round((Date.now() - lastSent) / 1000);
      lastUpdateEl.textContent = sec < 5 ? 'just now' : `${sec}s ago`;
    }, 1000);

    Relay.toast('Joined session', 'success');
  } catch (e) {
    showError(e.message || 'Something went wrong.');
  } finally {
    Relay.setLoading(startBtn, false, 'Join session');
  }
}

startBtn.addEventListener('click', startSharing);
stopBtn.addEventListener('click', () => {
  stopSharing();
  Relay.toast('Left session', 'info');
});

document.getElementById('name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') startSharing();
});

window.addEventListener('beforeunload', stopSharing);

setInterval(() => {
  if (ws?.readyState === WebSocket.OPEN) ws.send('ping');
}, 25000);
