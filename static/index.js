const SESSIONS_KEY = 'relay_sessions';

function loadSessions() {
  try {
    return JSON.parse(localStorage.getItem(SESSIONS_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveSession(session) {
  const sessions = loadSessions().filter(s => s.room_id !== session.room_id);
  sessions.unshift({ ...session, created_at: Date.now() });
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions.slice(0, 20)));
}

function renderSessions() {
  const list = document.getElementById('sessions-list');
  const sessions = loadSessions();
  if (!sessions.length) {
    list.innerHTML = '';
    list.classList.add('hidden');
    return;
  }
  list.classList.remove('hidden');
  list.innerHTML = '<h3>Your sessions</h3>';
  for (const s of sessions) {
    const row = document.createElement('div');
    row.className = 'session-row';
    row.innerHTML = `
      <span class="session-id">${s.room_id}</span>
      <a class="btn small" href="/admin/${s.room_id}?token=${encodeURIComponent(s.admin_token)}">Open view</a>
    `;
    list.appendChild(row);
  }
}

const createBtn = document.getElementById('create-room');
const result = document.getElementById('result');

createBtn.addEventListener('click', async () => {
  createBtn.disabled = true;
  createBtn.textContent = 'Creating…';
  try {
    const res = await fetch('/api/rooms', { method: 'POST' });
    const data = await res.json();
    saveSession(data);
    document.getElementById('share-url').value = data.share_url;
    document.getElementById('admin-url').value = data.admin_url;
    document.getElementById('open-admin').href = data.admin_url;
    result.classList.remove('hidden');
    renderSessions();
    window.location.href = data.admin_url;
  } finally {
    createBtn.disabled = false;
    createBtn.textContent = 'New session';
  }
});

document.querySelectorAll('[data-copy]').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = document.getElementById(btn.dataset.copy);
    input.select();
    navigator.clipboard.writeText(input.value);
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  });
});

renderSessions();
