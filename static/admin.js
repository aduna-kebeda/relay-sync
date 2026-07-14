const parts = window.location.pathname.split('/');
const roomId = parts[parts.indexOf('admin') + 1] || parts.pop();
const token = Relay.resolveToken(roomId);

document.getElementById('session-code').textContent = `ID ${roomId}`;
const inviteUrl = `${location.origin}/share/${roomId}`;
document.getElementById('invite-url').textContent = inviteUrl;

document.getElementById('copy-invite').addEventListener('click', () => Relay.copy(inviteUrl, 'Invite copied'));
document.getElementById('copy-share').addEventListener('click', async () => {
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Relay session', url: inviteUrl });
      return;
    } catch { /* fallback */ }
  }
  Relay.copy(inviteUrl, 'Invite copied');
});

const trackerCount = document.getElementById('tracker-count');
const memberLiveCount = document.getElementById('member-live-count');
const connectionEl = document.getElementById('connection');
const trackerList = document.getElementById('tracker-list');
const sidebarEmpty = document.getElementById('sidebar-empty');

const map = L.map('map', { zoomControl: true }).setView([20, 0], 2);
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap &copy; CARTO',
  maxZoom: 19,
}).addTo(map);

const markers = new Map();
let activeMemberId = null;
let lastTrackers = [];
let ws = null;
let pollTimer = null;
let tickTimer = null;

function setConnection(live) {
  connectionEl.className = live ? 'badge badge-live' : 'badge badge-offline';
  connectionEl.innerHTML = live
    ? '<span class="badge-dot"></span> Live'
    : '<span class="badge-dot"></span> Reconnecting';
}

function makeIcon(color, pulse = false) {
  return L.divIcon({
    className: 'tracker-marker-wrap',
    html: `<div class="tracker-pin ${pulse ? 'pulse' : ''}" style="background:${color}"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

function renderMemberCard(t) {
  const located = Relay.hasCoords(t);
  const color = Relay.colorFor(t.tracker_id);
  const card = document.createElement('div');
  card.className = `member-card ${located ? '' : 'no-signal'} ${activeMemberId === t.tracker_id ? 'active' : ''}`;
  card.dataset.id = t.tracker_id;
  card.innerHTML = `
    <div class="member-avatar" style="background:${color}">${Relay.initials(t.name)}</div>
    <div class="member-info">
      <div class="member-name">${Relay.escapeHtml(t.name)}</div>
      <div class="member-meta">${located
        ? `${t.lat.toFixed(4)}, ${t.lng.toFixed(4)} · ${Relay.formatTime(t.updated_at)}`
        : `Waiting for signal · ${Relay.formatTime(t.updated_at)}`}</div>
    </div>
    <span class="badge ${located ? 'badge-live' : 'badge-waiting'}">${located ? 'Live' : 'Pending'}</span>
  `;
  card.addEventListener('click', () => focusMember(t.tracker_id));
  return card;
}

function focusMember(id) {
  activeMemberId = id;
  const t = lastTrackers.find(x => x.tracker_id === id);
  if (t && Relay.hasCoords(t)) {
    map.setView([t.lat, t.lng], 16, { animate: true });
    markers.get(id)?.openPopup();
  }
  updateTrackers(lastTrackers);
}

function updateTrackers(trackers) {
  lastTrackers = trackers;
  const live = trackers.filter(Relay.hasCoords);
  trackerCount.textContent = `${trackers.length} member${trackers.length !== 1 ? 's' : ''}`;
  memberLiveCount.textContent = live.length;
  sidebarEmpty.classList.toggle('hidden', trackers.length > 0);
  trackerList.innerHTML = '';

  const onMap = new Set();
  for (const t of trackers) {
    trackerList.appendChild(renderMemberCard(t));
    if (!Relay.hasCoords(t)) continue;
    onMap.add(t.tracker_id);
    const color = Relay.colorFor(t.tracker_id);

    if (markers.has(t.tracker_id)) {
      const m = markers.get(t.tracker_id);
      m.setLatLng([t.lat, t.lng]);
      m.setPopupContent(`<strong>${Relay.escapeHtml(t.name)}</strong><br><span style="opacity:0.7">${Relay.formatTime(t.updated_at)}</span>`);
    } else {
      const marker = L.marker([t.lat, t.lng], { icon: makeIcon(color, true) })
        .addTo(map)
        .bindPopup(`<strong>${Relay.escapeHtml(t.name)}</strong>`);
      markers.set(t.tracker_id, marker);
    }
  }

  for (const [id, marker] of markers) {
    if (!onMap.has(id)) {
      map.removeLayer(marker);
      markers.delete(id);
    }
  }

  if (live.length === 1 && !activeMemberId) {
    map.setView([live[0].lat, live[0].lng], 14, { animate: true });
  } else if (live.length > 1 && !activeMemberId) {
    map.fitBounds(L.latLngBounds(live.map(t => [t.lat, t.lng])).pad(0.15), { animate: true });
  }
}

async function pollTrackers() {
  try {
    const res = await fetch(`/api/rooms/${roomId}`);
    if (!res.ok) return;
    const data = await res.json();
    updateTrackers(data.trackers || []);
  } catch { /* ignore */ }
}

function connect() {
  if (pollTimer) clearInterval(pollTimer);
  if (!token) {
    setConnection(false);
    connectionEl.innerHTML = '<span class="badge-dot"></span> No token';
    pollTrackers();
    pollTimer = setInterval(pollTrackers, 3000);
    return;
  }

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws/admin/${roomId}?token=${encodeURIComponent(token)}`);

  ws.onopen = () => {
    setConnection(true);
    pollTrackers();
  };

  ws.onmessage = (ev) => {
    const data = JSON.parse(ev.data);
    if (data.type === 'locations') updateTrackers(data.trackers);
  };

  ws.onclose = () => {
    setConnection(false);
    setTimeout(connect, 2500);
  };

  pollTimer = setInterval(pollTrackers, 4000);
}

connect();

setInterval(() => {
  if (ws?.readyState === WebSocket.OPEN) ws.send('ping');
}, 25000);

tickTimer = setInterval(() => {
  if (lastTrackers.length) updateTrackers([...lastTrackers]);
}, 1000);

window.addEventListener('resize', () => map.invalidateSize());
