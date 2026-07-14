const SESSIONS_KEY = 'relay_sessions';

const Relay = {
  sessions: {
    load() {
      try { return JSON.parse(localStorage.getItem(SESSIONS_KEY) || '[]'); }
      catch { return []; }
    },
    save(session) {
      const list = Relay.sessions.load().filter(s => s.room_id !== session.room_id);
      list.unshift({ ...session, created_at: session.created_at || Date.now() });
      localStorage.setItem(SESSIONS_KEY, JSON.stringify(list.slice(0, 20)));
    },
    remove(roomId) {
      const list = Relay.sessions.load().filter(s => s.room_id !== roomId);
      localStorage.setItem(SESSIONS_KEY, JSON.stringify(list));
    },
    resolveToken(roomId) {
      const fromUrl = new URLSearchParams(location.search).get('token');
      if (fromUrl) return fromUrl;
      return Relay.sessions.load().find(s => s.room_id === roomId)?.admin_token || null;
    },
  },

  toast(msg, type = 'info') {
    let root = document.getElementById('toast-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'toast-root';
      root.className = 'toast-root';
      document.body.appendChild(root);
    }
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = msg;
    root.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 300);
    }, 2800);
  },

  async copy(text, label = 'Copied') {
    try {
      await navigator.clipboard.writeText(text);
      Relay.toast(label, 'success');
      return true;
    } catch {
      Relay.toast('Copy failed', 'error');
      return false;
    }
  },

  escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  },

  initials(name) {
    return name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';
  },

  colorFor(id) {
    const colors = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4', '#ec4899'];
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = (hash + id.charCodeAt(i) * (i + 1)) % colors.length;
    return colors[hash];
  },

  formatTime(ts) {
    if (!ts) return '—';
    const sec = Math.max(0, Math.round(Date.now() / 1000 - ts));
    if (sec < 5) return 'just now';
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    return `${Math.floor(sec / 3600)}h ago`;
  },

  formatDate(ts) {
    if (!ts) return 'Unknown';
    const d = new Date(ts * 1000 || ts);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  },

  hasCoords(t) {
    return t.lat !== 0 || t.lng !== 0;
  },

  setLoading(btn, loading, idleText, loadingText = 'Please wait…') {
    if (!btn) return;
    btn.disabled = loading;
    btn.dataset.idleText = btn.dataset.idleText || idleText;
    btn.textContent = loading ? loadingText : btn.dataset.idleText;
    btn.classList.toggle('is-loading', loading);
  },
};

window.Relay = Relay;
