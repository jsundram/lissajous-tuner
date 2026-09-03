// Three-state theme (auto / light / dark) + the "JS-baked color" contract.
//
// WHY THIS EXISTS: dark mode via CSS custom properties (styles.css) is a free
// variable swap for anything the browser paints *from CSS*. But any color you
// read INTO JS at render time — ctx.fillStyle, an SVG/d3 .attr('fill', …), a
// baked color scale — freezes at the value it held when it ran; a theme flip
// can't reach it. So this module makes theme changes observable and gives you a
// memoized getCssColor() whose cache is cleared *before* your re-render runs.
//
// The three subtleties this irons out once:
//   1. notify() invalidates the color cache BEFORE calling subscribers — so a
//      subscriber's getCssColor() reads the NEW value, not the stale one.
//   2. it fires on the OS theme flip too, but only while in 'auto' — the classic
//      miss is auto-mode users whose colors freeze when they change the OS theme.
//   3. the pre-paint <script> in index.html stays a dumb 3-liner using the SAME
//      key + attribute values as this file, so the two can never disagree.
//
// Loaded as a classic script before app.js; exposes a global `Theme`.

window.Theme = (function () {
  const KEY = "lt-theme";                   // localStorage key (grep-able; rename with the others)
  const VALID = ["auto", "light", "dark"]; // cycle order
  const listeners = new Set();
  let colorCache = {};

  const read = () => {
    let v = null;
    try { v = localStorage.getItem(KEY); } catch {}
    return VALID.includes(v) ? v : "auto";
  };

  const apply = t => {
    const el = document.documentElement;
    // 'auto' = no attribute, so the @media(prefers-color-scheme) rule wins.
    if (t === "auto") el.removeAttribute("data-theme");
    else el.setAttribute("data-theme", t);
  };

  function notify() {
    invalidateColorCache();          // (1) clear BEFORE subscribers re-read colors
    listeners.forEach(fn => fn());
  }

  function get() { return read(); }

  function set(t) {
    if (!VALID.includes(t)) return;
    try { localStorage.setItem(KEY, t); } catch {}
    apply(t);
    notify();
  }

  function cycle() {
    const next = VALID[(VALID.indexOf(get()) + 1) % VALID.length];
    set(next);
    return next;
  }

  // True if dark is *currently* showing — honors an explicit override and, under
  // 'auto', the OS preference. Use instead of matchMedia(...).matches directly.
  function isDark() {
    const t = get();
    if (t === "dark") return true;
    if (t === "light") return false;
    return matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  // Read a CSS custom property into JS, memoized. Route EVERY JS color read
  // through here so invalidateColorCache() (fired on each theme change, before
  // your re-render) can reset them. Purely var(--…)-driven elements skip this.
  function getCssColor(token) {
    if (token in colorCache) return colorCache[token];
    const v = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
    colorCache[token] = v;
    return v;
  }
  function invalidateColorCache() { colorCache = {}; }

  // Re-apply pre-paint (defense in depth) and watch the OS for 'auto' users (2).
  function init() {
    apply(get());
    matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", () => { if (get() === "auto") notify(); });
  }

  return { get, set, cycle, isDark, subscribe, getCssColor, invalidateColorCache, init };
})();
