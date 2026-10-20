// What the dev-only browser scripts share: how the browser is launched, and what a page under test
// is not allowed to reach. Every script opens its page through openPage(), so neither half can be
// forgotten — offline-check once got the launch flags and missed the analytics stub.
import * as pw from "playwright-core";

// Inside Claude Code's macOS sandbox, which sets SANDBOX_RUNTIME.
export const sandboxedMac = process.env.SANDBOX_RUNTIME === "1" && process.platform === "darwin";

// Autoplay without a gesture and muted output, so the audio graph runs headless and silently.
//
// --single-process only inside the sandbox: there, Chrome registers a Mach service at startup so
// its helper processes can find the browser, the sandbox forbids registering one, and the launch
// aborts. With no helpers there is nothing to register. Scoped so a plain run keeps the normal
// multi-process browser.
const CHROME_ARGS = [
  "--autoplay-policy=no-user-gesture-required",
  "--mute-audio",
  ...(sandboxedMac ? ["--single-process"] : []),
];

// WebKit does not come up inside the sandbox; without a limit it sits out Playwright's 180 s
// default before failing with nothing said about why.
const SANDBOX_WEBKIT_TIMEOUT = 15000;

// Launches `engine`, opens ONE context with `contextOpts`, and returns { browser, ctx, page }.
//
// One context because single-process Chrome supports only one: a second (which
// browser.newPage() makes on every call) crashes it with TargetClosedError — and only inside the
// sandbox, so a plain run would never catch it. Open further pages with ctx.newPage().
//
// GoatCounter's script is answered with an empty one, for every page in the context. A check that
// counts console errors must not fail on a third-party host it does not test — and inside the
// sandbox it always would, because Chrome ignores the sandbox's proxy and cannot resolve the name.
// Pointed at the deployed site, it also keeps a run from being counted as a visit.
export async function openPage(engine = "chromium", contextOpts = {}) {
  const launch = { args: engine === "chromium" ? CHROME_ARGS : [] };
  if (sandboxedMac && engine === "webkit") launch.timeout = SANDBOX_WEBKIT_TIMEOUT;
  const browser = await pw[engine].launch(launch).catch((e) => {
    if (sandboxedMac && engine === "webkit") {
      console.error("WebKit cannot launch inside Claude Code's macOS sandbox; run this one unsandboxed.");
      process.exit(1);
    }
    throw e;
  });
  const ctx = await browser.newContext(contextOpts);
  await ctx.route("**://gc.zgo.at/**", (r) =>
    r.fulfill({ status: 200, contentType: "text/javascript", body: "" }));
  return { browser, ctx, page: await ctx.newPage() };
}
