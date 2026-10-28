/**
 * Playwright launch defaults that work on a desktop and in a container.
 *
 * Chromium refuses to start as root with its sandbox on:
 *
 *   Running as root without --no-sandbox is not supported.
 *
 * Railway (and most container images) run as root, so the sandbox has to be
 * disabled there. On a normal desktop it stays on: the DragonStats login
 * deliberately looks like a hand-opened browser, and Google is more suspicious
 * of a sandbox-less one.
 */
function sandboxEnabled() {
  const override = process.env.DRAGONSTATS_NO_SANDBOX;
  if (override === '1') return false;
  if (override === '0') return true;
  if (process.env.PLAYWRIGHT_NO_SANDBOX === '1') return false;
  if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) {
    return false;
  }
  return true;
}

/** `chromium.launch` options with the sandbox decision applied. */
function launchOptions(extra = {}) {
  return { chromiumSandbox: sandboxEnabled(), ...extra };
}

module.exports = { sandboxEnabled, launchOptions };
