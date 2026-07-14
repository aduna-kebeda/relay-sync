const roomId = window.location.pathname.split('/').pop();
const joinForm = document.getElementById('join-form');
const sharing = document.getElementById('sharing');
const errorEl = document.getElementById('error');
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const coordsEl = document.getElementById('coords');
const statusText = document.getElementById('status-text');
const personNameEl = document.getElementById('person-name');

let watchId = null;
let ws = null;
let trackerId = null;
let trackerName = null;

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.classList.remove('hidden');
}

function hideError() {
  errorEl.classList.add('hidden');
}

function stopSharing() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  if (ws) {
    ws.close();
    ws = null;
  }
  trackerId = null;
  trackerName = null;
  sharing.classList.add('hidden');
  joinForm.classList.remove('hidden');
  statusText.textContent = 'Connected…';
}

async function sendLocation(lat, lng, accuracy) {
  if (!trackerId) return;
  const payload = { lat, lng, accuracy };
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'location', ...payload }));
    return;
  }
  await fetch(`/api/rooms/${roomId}/trackers/${trackerId}/location`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function startSharing() {
  hideError();
  const name = document.getElementById('name').value.trim();
  if (!name) {
    showError('Please enter your name.');
    return;
  }

  if (!navigator.geolocation) {
    showError('Geolocation is not supported on this device.');
    return;
  }

  startBtn.disabled = true;

  try {
    const joinRes = await fetch(`/api/rooms/${roomId}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!joinRes.ok) throw new Error('Could not join room.');
    const { tracker_id } = await joinRes.json();
    trackerId = tracker_id;
    trackerName = name;

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}/ws/track/${roomId}/${trackerId}`);

    ws.onopen = () => {
      joinForm.classList.add('hidden');
      sharing.classList.remove('hidden');
      personNameEl.textContent = name;

      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          const { latitude, longitude, accuracy } = pos.coords;
          coordsEl.textContent = `${latitude.toFixed(6)}, ${longitude.toFixed(6)} (±${Math.round(accuracy)}m)`;
          sendLocation(latitude, longitude, accuracy);
        },
        (err) => {
          statusText.textContent = 'Permission needed';
          showError(err.message || 'Could not connect.');
        },
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
      );
    };

    ws.onclose = () => {
      statusText.textContent = 'Reconnecting…';
      setTimeout(() => {
        if (!trackerId) return;
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(`${protocol}//${location.host}/ws/track/${roomId}/${trackerId}`);
      }, 2000);
    };
  } catch (e) {
    showError(e.message || 'Something went wrong.');
  } finally {
    startBtn.disabled = false;
  }
}

startBtn.addEventListener('click', startSharing);
stopBtn.addEventListener('click', stopSharing);

window.addEventListener('beforeunload', stopSharing);

setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send('ping');
}, 25000);
