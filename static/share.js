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
  sharing.classList.add('hidden');
  joinForm.classList.remove('hidden');
  statusText.textContent = 'Sharing live location…';
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
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'location',
              lat: latitude,
              lng: longitude,
              accuracy,
            }));
          }
        },
        (err) => {
          statusText.textContent = 'Location error — check permissions';
          showError(err.message || 'Could not get location.');
        },
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
      );
    };

    ws.onclose = () => {
      statusText.textContent = 'Disconnected';
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
