// Transient messages. Errors stay long enough to read from a couch; successes
// get out of the way quickly.

import { h } from './util.mjs';

const root = () => document.getElementById('toast-root');
const MAX_VISIBLE = 3;

function show(text, kind, ms) {
  const host = root();
  if (!host) return () => {};

  const el = h(
    'div',
    { class: ['toast', kind && `toast-${kind}`], role: kind === 'error' ? 'alert' : 'status' },
    h('div', { class: 'toast-bar' }),
    h('div', { text }),
  );
  host.append(el);

  while (host.children.length > MAX_VISIBLE) host.firstElementChild.remove();

  const dismiss = () => {
    if (!el.isConnected) return;
    el.classList.add('is-leaving');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400);
  };
  const timer = setTimeout(dismiss, ms);
  return () => {
    clearTimeout(timer);
    dismiss();
  };
}

export const toast = {
  info: (text) => show(text, null, 3200),
  good: (text) => show(text, 'good', 3000),
  error: (text) => show(text, 'error', 6500),
};

/** For "Scanning…" style messages that end when the work does. */
export function stickyToast(text) {
  return show(text, null, 120_000);
}
