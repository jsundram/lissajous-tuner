// App boot + the PWA integration example. index.html owns structure, styles.css
// owns looks; app.js wires the runtime and hands you two hooks to fill in:
//   render()  — (re)fetch + repaint. Runs on load, resume, poll, and PTR.
//   paint()   — turn data into DOM. Kept separate so a theme change can repaint
//               WITHOUT a network round-trip.
//
// What it wires for you: service worker + "tap to update" tag, theme (with the
// JS-baked-color contract), stale-while-revalidate data, and the keep-fresh loop
// (foreground poll + resume re-pull + optional pull-to-refresh).

const VER_PREFIX = "lt-v";          // must match sw.js's V stem — and V's numeric tail is load-bearing
const DATA_URL = "";               // <-- your cross-origin data endpoint (empty = disabled, like ping.js)
const DATA_KEY = "main";           // localStorage cache slot for this endpoint
const STALE_MS = 5 * 60 * 1000;    // cached data older than this is worth re-fetching

let lastData = null;               // last payload, so a theme change can repaint without refetching

// ---- data + rendering ------------------------------------------------------
// CACHE-FIRST: peek → paint → revalidate → repaint only if changed. A returning
// visitor sees real data instantly instead of the placeholder, even on a flaky
// connection; the network round-trip happens behind the already-painted UI. Only
// the true first run (nothing cached) falls back to awaiting the network.
async function render(){
  const app = document.getElementById("app");
  if(!DATA_URL) return;            // no endpoint wired yet — leave the placeholder copy in index.html

  // Only the boot call needs the cache paint; on a poll/resume/PTR re-render the
  // screen already shows this data, so painting it again would just flash.
  const cached = lastData === null ? Data.peek(DATA_KEY) : null;
  if(cached){                      // instant paint from the cache, no await
    lastData = cached.data;
    paint(cached.data);
    showStale(cached);
  }

  try{
    const res = await Data.revalidate(DATA_URL, { key: DATA_KEY, timeoutMs: 5000 });
    if(res.changed || lastData === null){   // skip the repaint (and its flash) when nothing moved
      const first = lastData === null;
      lastData = res.data;
      if(first) paint(res.data);            // nothing on screen yet — no transition to make
      else applyUpdate(res.data);           // replacing live content — do it gently
    }
    showStale(res);                // always: clears the "cached · N min old" tag
  }catch{
    // Offline, timed out, or the endpoint returned an empty/invalid payload —
    // data.js refused to cache it, so whatever is on screen is still the best
    // copy we have. Only a run that never painted anything has nothing to show.
    const c = Data.peek(DATA_KEY);
    if(c) showStale(c);            // re-flag it stale: the network read didn't land
    else if(lastData === null) app.textContent = "Couldn't load data and nothing is cached yet — reconnect and reopen.";
  }
}

// Swap in freshly-revalidated data WITHOUT yanking the page out from under the
// reader. Cache-first means the user is already looking at content when the
// network lands, so a naive paint() resets scroll and pops layout.
// Reviewed against real downstream DOM (pwa-starter#6: musiclog, haydn scatter);
// what survived, in order of how much it matters:
//   1. don't repaint at all unless the payload changed  (res.changed, in render)
//      — the load-bearing defense, worth more than everything below combined.
//   2. restore scroll — rebuilding a container resets it to 0. Window-level only,
//      and that's the right floor: even a list-heavy app usually scrolls the
//      document, and inner overflow containers built by keyed joins keep their
//      own offsets. If yours don't, restoring them is paint()'s job.
//   3. crossfade the swap via a View Transition where supported. Skipped under
//      prefers-reduced-motion; unsupported browsers take the plain path. Two
//      caveats at real DOM size: startViewTransition freezes rendering while
//      swap() runs, so a heavy synchronous paint() (thousands of SVG nodes, a
//      force layout) turns the crossfade into a visible stall — and its async
//      snapshot→swap gap is a window another repaint (theme flip, resize) can
//      land in. Fine at this skeleton's scale; measure before keeping it in a
//      big app.
// What was CUT (see #6): restoring focus. Dead code in both paint regimes — a
// paint() that wipes-and-rebuilds destroys the focused node (document.contains()
// fails), and one that patches in place never loses focus. Real recovery means
// re-finding the element by id after the rebuild, which only your paint() can do.
// What's deliberately NOT here: deferring the update while the user is mid-
// interaction (defense 4, see CLAUDE.md). The triggers generalize — (a) an open
// overlay: menu, dropdown, tooltip, fullscreen; (b) focus inside a form control;
// (c) a pointer gesture in flight — but every predicate is app-specific, so it
// belongs in your shouldDefer(), not in the skeleton.
function applyUpdate(data){
  const y = scrollY;
  const swap = () => {
    paint(data);
    if(scrollY !== y) scrollTo(0, y);
  };
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if(document.startViewTransition && !still) document.startViewTransition(swap);
  else swap();
}

function paint(data){
  // → your app goes here. Read `data`, paint the DOM. Runs on first load, on
  //   resume, after a pull-to-refresh, AND on every theme change — so keep it
  //   idempotent, and read any baked colors via Theme.getCssColor(token).
  document.getElementById("app").textContent = JSON.stringify(data);
}

function showStale(res){          // "loaded from cache, N min old" so the user knows they're offline
  const tag = document.getElementById("stale");
  if(!tag) return;
  if(res.stale){
    tag.hidden = false;
    tag.textContent = `cached · ${Math.round(res.ageMs / 60000)} min old`;
  }else{
    tag.hidden = true;
  }
}

// Re-fetch only if visible AND actually stale — so a backgrounded tab never
// fetches and a just-loaded one isn't hit again. ageMs() answers "how stale?"
// with no network call.
function maybeRefresh(){
  if(document.visibilityState !== "visible") return;
  if(!DATA_URL) return;
  if(Data.ageMs(DATA_KEY) < STALE_MS) return;
  render();
}

// ---- theme -----------------------------------------------------------------
function onThemeChange(){
  // theme.js already cleared the color cache before calling us. Repaint anything
  // that baked a color into JS (canvas/SVG); pure var(--…) elements updated free.
  updateThemeLabel();
  if(lastData) paint(lastData);
}

function wireThemeToggle(){
  const btn = document.getElementById("theme");
  if(!btn) return;
  btn.onclick = () => Theme.cycle();   // cycle fires onThemeChange, which updates the label
  updateThemeLabel();
}

function updateThemeLabel(){
  const btn = document.getElementById("theme");
  if(btn) btn.textContent = "Theme: " + Theme.get().replace(/^./, c => c.toUpperCase());
}

// ---- service-worker version tag (unchanged plumbing) -----------------------
async function checkVer(){
  const tag = document.getElementById("ver");
  if(!tag) return;
  // HIGHEST version, not the first key: two caches can legitimately coexist for a while (sw.js
  // keeps the old one as a net until the new precache is complete), and caches.keys() is in
  // creation order — so find() would report the OLD version as installed and show a permanent
  // "tap to update" tag on an already-current device.
  //
  // But only among caches that actually HOLD something. sw.js's ensureShellOnce() calls
  // caches.open(V) before it fetches anything, so a bumped version exists as an EMPTY cache the
  // moment an install starts — and per-file precaching means that worker activates even if every
  // shell fetch failed. Ranking on names alone then reads the empty placeholder as "installed",
  // concludes the device is current, and hides the tag on a device still serving the PREVIOUS
  // release out of the old cache — killing the one affordance that unsticks it by hand. A
  // partly-filled new cache still reads as installed; that state repairs itself on the next
  // top-up, whereas the empty one can persist.
  let installed = "";
  try{
    const keys = (await caches.keys()).filter(k => k.startsWith(VER_PREFIX));
    const sized = await Promise.all(
      keys.map(async k => [(await (await caches.open(k)).keys()).length, k]));
    installed = sized
      .filter(([n]) => n > 0)
      .map(([, k]) => [parseInt(k.slice(VER_PREFIX.length), 10) || 0, k])
      .sort((a, b) => a[0] - b[0])
      .map(([, k]) => k)
      .pop() || "";
  }catch{}
  if(!installed){ tag.hidden = true; return; }

  let latest = "";
  try{   // ?_= + no-store dodges both the SW cache and the HTTP cache → the live sw.js on the server
    const src = await (await fetch("./sw.js?_=" + Date.now(), {cache:"no-store"})).text();
    // Read the DECLARATION, not the first prefix-shaped string anywhere in the file: sw.js's
    // comments cite version names as examples, so an unanchored /app-v\d+/ scan can match a
    // comment and pin a permanent "tap to update" tag that does nothing when tapped
    // (forceUpdate() clears caches, reloads, and re-reads the same comment). Same expression as
    // scripts/sw-lint.py's ver(); keep the two in agreement.
    latest = (src.match(/const V\s*=\s*"([^"]*)"/) || ["", ""])[1];
  }catch{}   // offline: leave latest empty → neutral tag, never a false "behind"

  const behind = latest && latest !== installed;
  tag.hidden = false;
  tag.className = "ver" + (behind ? " behind" : "");
  tag.textContent = behind ? `${installed} → ${latest}` : installed;
  tag.title = behind ? "New version available — tap to update" : "Up to date";
  tag.onclick = behind ? forceUpdate : null;
}

async function forceUpdate(){   // the hammer: drop every cache, reload → SW reinstalls the latest shell
  try{ await Promise.all((await caches.keys()).map(k => caches.delete(k))); }catch{}
  location.reload();
}

// Ask the active SW to top up any missing precache entries. iOS can reclaim Cache API contents
// (storage pressure, ~7 idle days) while leaving the registration in place, and sw.js only
// precaches on install — i.e. on a V bump. Without this nudge a device whose cache got evicted
// stays broken offline indefinitely; with it, one online launch repairs it.
function requestShellTopUp(){
  if(!("serviceWorker" in navigator) || !navigator.onLine) return;
  // getRegistration() resolves undefined when there's nothing registered; .ready would just
  // never settle, leaving a pending promise behind on every foreground.
  navigator.serviceWorker.getRegistration()
    .then(reg => { if(reg && reg.active) reg.active.postMessage("ensure-shell"); })
    .catch(() => {});
}

// ---- boot ------------------------------------------------------------------
function boot(){
  if("serviceWorker" in navigator){
    navigator.serviceWorker.register("./sw.js").catch(()=>{});
    // A registration can exist with no ACTIVE worker for a moment — first install, or the swap
    // during an update — and the top-up ping is fire-and-forget, so it would simply be dropped
    // and nothing would retry until the next launch. That undercuts the whole "open it once with
    // a connection and it repairs itself" promise, so retry when a worker takes control.
    navigator.serviceWorker.addEventListener("controllerchange", requestShellTopUp);
  }

  Theme.init();                       // re-apply pre-paint attr + watch the OS for auto-mode users
  Theme.subscribe(onThemeChange);
  wireThemeToggle();

  render();
  checkVer();
  requestShellTopUp();

  setInterval(maybeRefresh, STALE_MS);                                       // foreground poll

  // iOS home-screen apps RESUME rather than reload — re-pull (gated), re-check version, and
  // re-ping the shell top-up on foreground.
  addEventListener("visibilitychange", () => { if(!document.hidden){ maybeRefresh(); checkVer(); requestShellTopUp(); } });
}

boot();
