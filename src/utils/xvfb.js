const fs = require('fs');
const { spawnSync } = require('child_process');

/**
 * Virtual display support for the DragonStats gate.
 *
 * The gate's headless mint can be refused by Arcjet (HTTP 403), and its only
 * working fallback is a real browser window - which needs an X display. A
 * headless server has none, so Chromium dies with:
 *
 *   Missing X server or $DISPLAY ... The platform failed to initialize.
 *
 * `xvfb-run` supplies a throwaway X server for exactly this case. This module
 * decides when it is needed and how to wrap a command with it. It is a no-op
 * on Windows/macOS, when a usable display already exists, or when the host
 * does not have xvfb-run installed.
 */

const SCREEN = '-screen 0 1600x1000x24';
/** Marks a child that is already inside xvfb-run, so it never wraps twice. */
const ALREADY_WRAPPED = 'PHOENIX_XVFB';

/**
 * Whether this process can open a real browser window right now.
 *
 * Linux trusts DISPLAY/WAYLAND_DISPLAY, but only after checking the X socket:
 * a stale variable pointing at a dead display is worse than none, because
 * Chromium starts and then crashes instead of being wrapped in Xvfb.
 */
function displayAvailable() {
  if (process.platform !== 'linux') return true;
  if (process.env.WAYLAND_DISPLAY) return true;
  const display = process.env.DISPLAY;
  if (!display) return false;
  const match = /^:(\d+)/.exec(display);
  if (!match) return true;
  return fs.existsSync(`/tmp/.X11-unix/X${match[1]}`);
}

/** Absolute path to xvfb-run, or null when the host does not have it. */
function xvfbRunPath() {
  if (process.platform !== 'linux') return null;
  const result = spawnSync('sh', ['-c', 'command -v xvfb-run'], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  const found = String(result.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  return found || null;
}

/**
 * Wraps `command args` in xvfb-run when the host has no usable display.
 *
 * Returns `{ command, args, wrapped, missing }`. `wrapped` is true only when
 * xvfb-run was actually prepended; `missing` is true when a display was needed
 * but the binary is not installed (the caller can then explain the fix).
 */
function wrapCommand(command, args) {
  if (displayAvailable()) return { command, args, wrapped: false, missing: false };
  if (process.env[ALREADY_WRAPPED] === '1') return { command, args, wrapped: false, missing: false };
  const xvfb = xvfbRunPath();
  if (!xvfb) return { command, args, wrapped: false, missing: true };
  return {
    command: xvfb,
    args: ['-a', '-s', SCREEN, command, ...args],
    wrapped: true,
    missing: false,
  };
}

/**
 * Re-runs the current script under xvfb-run when it needs a display.
 *
 * For scripts started by hand (`npm run scrape`) rather than by the dashboard
 * runner. The re-exec keeps stdio attached so output and exit codes behave as
 * if the user had typed `xvfb-run` themselves. No-op inside an existing
 * wrapper or when a display is already present.
 */
function reexecUnderXvfb() {
  if (displayAvailable()) return;
  if (process.env[ALREADY_WRAPPED] === '1') return;
  const xvfb = xvfbRunPath();
  if (!xvfb) {
    console.error(
      '[XVFB] No display and xvfb-run is not installed; a headed browser cannot start.\n' +
        '[XVFB] Install it with: sudo apt-get update && sudo apt-get install -y xvfb xauth',
    );
    return;
  }
  const result = spawnSync(
    xvfb,
    ['-a', '-s', SCREEN, process.execPath, process.argv[1], ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, [ALREADY_WRAPPED]: '1' } },
  );
  process.exit(result.status == null ? 1 : result.status);
}

module.exports = {
  displayAvailable,
  xvfbRunPath,
  wrapCommand,
  reexecUnderXvfb,
  SCREEN,
  ALREADY_WRAPPED,
};
