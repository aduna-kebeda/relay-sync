const createBtn = document.getElementById('create-room');
const sessionsSection = document.getElementById('sessions-section');
const sessionsList = document.getElementById('sessions-list');
const statSessions = document.getElementById('stat-sessions');
const statActive = document.getElementById('stat-active');
const statStatus = document.getElementById('stat-status');

async function fetchSessionStats(session) {
  try {
    const res = await fetch(`/api/rooms/${session.room_id}`);
    if (!res.ok) return { members: 0, live: 0 };
    const data = await res.json();
    const trackers = data.trackers || [];
    return {
      members: trackers.length,
      live: trackers.filter(Relay.hasCoords).length,
    };
  } catch {
    return { members: 0, live: 0 };
  }
}

async function renderSessions() {
  const sessions = Relay.sessions.load();
  statSessions.textContent = sessions.length;

  if (!sessions.length) {
    sessionsSection.classList.add('hidden');
    statActive.textContent = '—';
    return;
  }

  sessionsSection.classList.remove('hidden');
  sessionsList.innerHTML = '';

  let totalLive = 0;
  const stats = await Promise.all(sessions.map(async (s, i) => {
    const { members, live } = await fetchSessionStats(s);
    totalLive += live;
    return { session: s, members, live, index: i };
  }));

  statActive.textContent = totalLive;

  for (const { session, members, live, index } of stats) {
    const card = document.createElement('div');
    card.className = 'session-card';
    card.style.animationDelay = `${index * 0.05}s`;
    const shortId = session.room_id.slice(0, 8);
    const ago = Relay.formatTime((session.created_at || Date.now()) / 1000);

    card.innerHTML = `
      <div class="session-icon">${shortId.slice(0, 2).toUpperCase()}</div>
      <div class="session-info">
        <div class="session-title">Session ${shortId}</div>
        <div class="session-meta">${members} member${members !== 1 ? 's' : ''} · ${live} live · ${ago}</div>
      </div>
      <div class="session-actions">
        <button class="btn ghost small" data-copy-share="${session.room_id}" title="Copy invite">Link</button>
        <a class="btn primary small" href="/admin/${session.room_id}?token=${encodeURIComponent(session.admin_token)}">Open</a>
        <button class="btn ghost small" data-remove="${session.room_id}" title="Remove">✕</button>
      </div>
    `;
    sessionsList.appendChild(card);
  }

  sessionsList.querySelectorAll('[data-copy-share]').forEach(btn => {
    Relay.bindCopyButton(btn, () => `${location.origin}/share/${btn.dataset.copyShare}`, 'Invite link copied');
  });

  sessionsList.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      Relay.sessions.remove(btn.dataset.remove);
      Relay.toast('Session removed', 'info');
      renderSessions();
    });
  });
}

createBtn.addEventListener('click', async () => {
  Relay.setLoading(createBtn, true, 'Start new session', 'Creating…');
  statStatus.textContent = 'Creating';
  try {
    const res = await fetch('/api/rooms', { method: 'POST' });
    if (!res.ok) throw new Error('Could not create session');
    const data = await res.json();
    Relay.sessions.save(data);
    Relay.toast('Session created', 'success');
    window.location.href = data.admin_url;
  } catch (e) {
    Relay.toast(e.message || 'Something went wrong', 'error');
    statStatus.textContent = 'Error';
  } finally {
    Relay.setLoading(createBtn, false, 'Start new session');
  }
});

document.getElementById('refresh-sessions').addEventListener('click', () => {
  statStatus.textContent = 'Refreshing';
  renderSessions().then(() => { statStatus.textContent = 'Ready'; });
});

renderSessions();
setInterval(renderSessions, 15000);
