// DOM building + formatting helpers.
//
// Everything is built with createElement rather than innerHTML. That is not
// stylistic: game titles come from filenames on disk, and this app can spawn
// processes, so a ROM named `<img onerror=...>` must never become markup.

/**
 * Terse element builder.
 *   h('div', {class: 'card', nav: true, onClick: fn}, 'text', child)
 * Supported props: class/className, text, style (object), dataset, attrs,
 * nav (sets data-nav), on<Event> handlers. There is deliberately no `html`.
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);

  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;

    if (key === 'class' || key === 'className') {
      el.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : String(value);
    } else if (key === 'text') {
      el.textContent = String(value);
    } else if (key === 'style' && typeof value === 'object') {
      for (const [prop, val] of Object.entries(value)) {
        if (val === null || val === undefined) continue;
        if (prop.startsWith('--')) el.style.setProperty(prop, String(val));
        else el.style[prop] = String(val);
      }
    } else if (key === 'dataset') {
      for (const [prop, val] of Object.entries(value)) {
        if (val !== null && val !== undefined) el.dataset[prop] = String(val);
      }
    } else if (key === 'nav') {
      el.dataset.nav = value === true ? '1' : String(value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else {
      el.setAttribute(key, value === true ? '' : String(value));
    }
  }

  appendAll(el, children);
  return el;
}

export function appendAll(parent, children) {
  for (const child of children.flat(6)) {
    if (child === null || child === undefined || child === false || child === '') continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export function clear(el) {
  el.replaceChildren();
  return el;
}

/** Stable non-negative hash, used for deterministic generated art. */
export function hashString(str) {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

// ------------------------------------------------------------- formatting

export function fmtBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const decimals = value >= 100 || unit === 0 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[unit]}`;
}

/** "3h 12m" / "48m" / "Never played" */
export function fmtPlaytime(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s === 0) return 'Not played yet';
  if (s < 60) return 'Under a minute';
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

/** mm:ss / h:mm:ss for the live session timer. */
export function fmtTimer(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
}

export function fmtRelative(timestamp) {
  const ts = Number(timestamp) || 0;
  if (!ts) return 'Never';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'Just now';
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function fmtClock(date = new Date()) {
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Case/space-insensitive substring search over a game's searchable fields. */
export function matchesQuery(game, query) {
  if (!query) return true;
  const needle = query.toLowerCase().replace(/\s+/g, '');
  if (!needle) return true;
  const haystack = `${game.title} ${game.region || ''} ${game.platform}`.toLowerCase().replace(/\s+/g, '');
  return haystack.includes(needle);
}

export const SORTS = {
  name: { label: 'Name', compare: (a, b) => a.sortKey.localeCompare(b.sortKey) },
  recent: {
    label: 'Recently played',
    compare: (a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0) || a.sortKey.localeCompare(b.sortKey),
  },
  played: {
    label: 'Most played',
    compare: (a, b) => (b.playSeconds || 0) - (a.playSeconds || 0) || a.sortKey.localeCompare(b.sortKey),
  },
  size: { label: 'Size', compare: (a, b) => (b.size || 0) - (a.size || 0) },
};

export function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
