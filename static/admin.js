const parts = window.location.pathname.split('/');
const roomId = parts[parts.indexOf('admin') + 1] || parts.pop();
const token = new URLSearchParams(window.location.search).get('token');

const trackerCount = document.getElementById('tracker-count');
const connectionEl = document.getElementById('connection');
const trackerList = document.getElementById('tracker-list');
const sidebarEmpty = document.querySelector('.sidebar-empty');

const map = L.map('map').setView([20, 0], 2);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap',
  maxZoom: 19,
}).addTo(map);

const markers = new Map();
const colors = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4'];

function colorFor(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash + id.charCodeAt(i) * (i + 1)) % colors.length;
  return colors[hash];
}

function formatTime(ts) {
  const sec = Math.round(Date.now() / 1000 - ts);
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  return `${Math.floor(sec / 60)}m ago`;
}

function updateTrackers(trackers) {
  const active = trackers.filter(t => t.lat !== 0 || t.lng !== 0);
  trackerCount.textContent = `${active.length} ${active.length === 1 ? 'person' : 'people'}`;
  sidebarEmpty.classList.toggle('hidden', active.length > 0);
  trackerList.innerHTML = '';

  const seen = new Set();
  for (const t of active) {
    seen.add(t.tracker_id);
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="name" style="color:${colorFor(t.tracker_id)}">${escapeHtml(t.name)}</div>
      <div class="meta">${t.lat.toFixed(5)}, ${t.lng.toFixed(5)} · ${formatTime(t.updated_at)}</div>
    `;
    trackerList.appendChild(li);

    const color = colorFor(t.tracker_id);
    if (markers.has(t.tracker_id)) {
      const m = markers.get(t.tracker_id);
      m.setLatLng([t.lat, t.lng]);
      m.setPopupContent(`<strong>${escapeHtml(t.name)}</strong><br>${t.lat.toFixed(5)}, ${t.lng.toFixed(5)}`);
    } else {
      const icon = L.divIcon({
        className: 'tracker-marker',
        html: `<div style="background:${color};width:14px;height:14px;border-radius:50%;border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,.4)"></div>`,
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      });
      const marker = L.marker([t.lat, t.lng], { icon })
        .addTo(map)
        .bindPopup(`<strong>${escapeHtml(t.name)}</strong>`);
      markers.set(t.tracker_id, marker);
    }
  }

  for (const [id, marker] of markers) {
    if (!seen.has(id)) {
      map.removeLayer(marker);
      markers.delete(id);
    }
  }

  if (active.length === 1) {
    map.setView([active[0].lat, active[0].lng], 15);
  } else if (active.length > 1) {
    const bounds = L.latLngBounds(active.map(t => [t.lat, t.lng]));
    map.fitBounds(bounds.pad(0.2));
  }
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function connect() {
  if (!token) {
    connectionEl.textContent = 'Missing admin token';
    connectionEl.className = 'connection disconnected';
    return;
  }

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}/ws/admin/${roomId}?token=${encodeURIComponent(token)}`);

  ws.onopen = () => {
    connectionEl.textContent = 'Live';
    connectionEl.className = 'connection connected';
  };

  ws.onmessage = (ev) => {
    const data = JSON.parse(ev.data);
    if (data.type === 'locations') updateTrackers(data.trackers);
  };

  ws.onclose = () => {
    connectionEl.textContent = 'Reconnecting…';
    connectionEl.className = 'connection disconnected';
    setTimeout(connect, 2000);
  };
}

connect();
