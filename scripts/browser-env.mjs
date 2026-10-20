// What the dev-only browser scripts share: how Chromium is launched, and what a page under test
// is not allowed to reach.

// Autoplay without a gesture and muted output, so the audio graph runs headless and silently.
//
// --single-process only inside Claude Code's macOS sandbox (which sets SANDBOX_RUNTIME): there,
// Chrome registers a Mach service at startup so its helper processes can find the browser, the
// sandbox forbids registering one, and the launch aborts. With no helpers there is nothing to
// register. Single-process Chrome supports ONE browser context, so a script using these args must
// not open a second one (browser.newPage() makes a fresh context each call). Scoped so a plain
// run keeps the normal multi-process browser.
const sandboxedMac = process.env.SANDBOX_RUNTIME === "1" && process.platform === "darwin";

export const CHROME_ARGS = [
  "--autoplay-policy=no-user-gesture-required",
  "--mute-audio",
  ...(sandboxedMac ? ["--single-process"] : []),
];

// GoatCounter's script is answered with an empty one. A check that counts console errors must
// not fail on a third-party host it does not test — and inside the sandbox it always would,
// because Chrome ignores the sandbox's proxy and cannot resolve the name. Pointed at the deployed
// site, it also keeps a screenshot from being counted as a visit.
export async function stubAnalytics(page) {
  await page.route("**://gc.zgo.at/**", (r) =>
    r.fulfill({ status: 200, contentType: "text/javascript", body: "" }));
}
