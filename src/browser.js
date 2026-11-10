/**
 * Playwright launch defaults that work on a desktop, in a container, and on
 * hardened servers.
 *
 * Chromium's sandbox has two failure modes in the wild:
 *
 *   - it refuses to start as root ("Running as root without --no-sandbox is
 *     not supported") - container hosts run as root;
 *   - it aborts on Ubuntu 23.10+ and other AppArmor-hardened distros that
 *     disable unprivileged user namespaces ("No usable sandbox!") - there the
 *     kernel refuses what Chromium's sandbox needs, and only --no-sandbox
 *     works (this is what an Azure Ubuntu VM hits).
 *
 * Both are decided here instead of crashing into them: explicit env overrides
 * win first, then root, then the kernel's own restriction knob. A desktop
 * keeps the sandbox on - nothing about the gate requires it off.
 */
const fs = require('fs');

const APPARMOR_USERNS_RESTRICTION = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns';

function sandboxEnabled() {
  const override = process.env.DRAGONSTATS_NO_SANDBOX;
  if (override === '1') return false;
  if (override === '0') return true;
  if (process.env.PLAYWRIGHT_NO_SANDBOX === '1') return false;
  if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) {
    return false;
  }
  if (process.platform === 'linux') {
    try {
      if (fs.readFileSync(APPARMOR_USERNS_RESTRICTION, 'utf8').trim() === '1') {
        return false;
      }
    } catch {
      // The distro does not expose the knob - keep the normal decision.
    }
  }
  return true;
}

/** `chromium.launch` options with the sandbox decision applied. */
function launchOptions(extra = {}) {
  return { chromiumSandbox: sandboxEnabled(), ...extra };
}

module.exports = { sandboxEnabled, launchOptions };
