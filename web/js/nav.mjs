// Spatial focus manager.
//
// Views mark focusable things with data-nav and never think about navigation
// again. Direction moves pick the nearest element that actually sits that way
// on screen, scored by edge distance plus a penalty for cross-axis
// misalignment. Geometry rather than DOM order means one implementation covers
// rails, grids, forms and modals — including layouts that reflow.

const OVERLAP_BONUS = 4000; // strongly prefer a candidate in the same row/column
const CROSS_WEIGHT = 2.4;

let scope = document.body;
let current = null;

/** Limit navigation to a subtree — used when a modal opens. */
export function setScope(element) {
  scope = element || document.body;
}

export function getScope() {
  return scope;
}

function isVisible(el) {
  if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
  if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return false;
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return false;
  // Off-screen rails are still navigable; fully collapsed containers are not.
  return true;
}

export function focusables() {
  return [...scope.querySelectorAll('[data-nav]')].filter(isVisible);
}

function centerOf(rect) {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/**
 * Score a candidate for a directional move. Lower is better; null means the
 * candidate is not in that direction at all.
 */
function score(fromRect, toRect, direction) {
  const from = centerOf(fromRect);
  const to = centerOf(toRect);
  const EPS = 2;

  let along;
  let crossGap;
  let overlaps;

  if (direction === 'right') {
    if (toRect.left < fromRect.right - EPS) return null;
    along = toRect.left - fromRect.right;
    crossGap = Math.abs(to.y - from.y);
    overlaps = toRect.bottom > fromRect.top + EPS && toRect.top < fromRect.bottom - EPS;
  } else if (direction === 'left') {
    if (toRect.right > fromRect.left + EPS) return null;
    along = fromRect.left - toRect.right;
    crossGap = Math.abs(to.y - from.y);
    overlaps = toRect.bottom > fromRect.top + EPS && toRect.top < fromRect.bottom - EPS;
  } else if (direction === 'down') {
    if (toRect.top < fromRect.bottom - EPS) return null;
    along = toRect.top - fromRect.bottom;
    crossGap = Math.abs(to.x - from.x);
    overlaps = toRect.right > fromRect.left + EPS && toRect.left < fromRect.right - EPS;
  } else if (direction === 'up') {
    if (toRect.bottom > fromRect.top + EPS) return null;
    along = fromRect.top - toRect.bottom;
    crossGap = Math.abs(to.x - from.x);
    overlaps = toRect.right > fromRect.left + EPS && toRect.left < fromRect.right - EPS;
  } else {
    return null;
  }

  return Math.max(0, along) + crossGap * CROSS_WEIGHT - (overlaps ? OVERLAP_BONUS : 0);
}

/**
 * Move focus one step. Returns true when focus actually moved, so callers can
 * fall back to their own behaviour at the edge of a list.
 */
export function move(direction) {
  const candidates = focusables();
  if (!candidates.length) return false;

  if (!current || !candidates.includes(current)) {
    focus(candidates[0]);
    return true;
  }

  const fromRect = current.getBoundingClientRect();
  let best = null;
  let bestScore = Infinity;

  for (const candidate of candidates) {
    if (candidate === current) continue;
    const result = score(fromRect, candidate.getBoundingClientRect(), direction);
    if (result === null) continue;
    if (result < bestScore) {
      bestScore = result;
      best = candidate;
    }
  }

  if (!best) return false;
  focus(best);
  return true;
}

export function focus(element, { scroll = true } = {}) {
  if (!element) return;
  if (current === element) {
    if (scroll) scrollTo(element);
    return;
  }

  if (current) current.classList.remove('is-focused');
  current = element;
  current.classList.add('is-focused');

  // Real DOM focus for inputs so typing works; everything else stays visual so
  // the browser never scrolls or rings it for us.
  if (element.matches('input, textarea, select')) {
    element.focus({ preventScroll: true });
  } else if (document.activeElement && document.activeElement !== document.body) {
    if (document.activeElement.matches('input, textarea, select')) document.activeElement.blur();
  }

  if (scroll) scrollTo(element);
}

function scrollTo(element) {
  const reduce = document.documentElement.dataset.motion === 'reduce';
  element.scrollIntoView({
    block: 'nearest',
    inline: 'nearest',
    behavior: reduce ? 'auto' : 'smooth',
  });
}

export function getCurrent() {
  return current;
}

/** Focus the element a view marked as its entry point, else the first one. */
export function focusInitial() {
  const preferred = scope.querySelector('[data-nav][data-nav-initial]');
  const target = preferred && isVisible(preferred) ? preferred : focusables()[0];
  if (target) {
    focus(target, { scroll: false });
  } else if (current) {
    // An empty scope (a modal with no buttons) must not leave a stale ring.
    current.classList.remove('is-focused');
    current = null;
  }
}

/** Focus by the stable key a view stamped on an element, if it still exists. */
export function focusKey(key) {
  if (!key) return false;
  const target = scope.querySelector(`[data-nav][data-nav-key="${CSS.escape(key)}"]`);
  if (target && isVisible(target)) {
    focus(target);
    return true;
  }
  return false;
}

export function currentKey() {
  return current?.dataset.navKey || null;
}

/** Click whatever is focused. Views wire behaviour with normal click handlers. */
export function activate() {
  if (!current) return false;
  if (current.matches('input, textarea')) return false; // Enter in a field is the field's business
  current.click();
  return true;
}

// Mouse and touch users get the same focus model: hovering moves focus, so the
// hint bar and Y-button actions always refer to what you are looking at.
document.addEventListener('pointerover', (ev) => {
  if (ev.pointerType === 'touch') return;
  const target = ev.target.closest?.('[data-nav]');
  if (target && scope.contains(target) && isVisible(target)) {
    focus(target, { scroll: false });
  }
});
