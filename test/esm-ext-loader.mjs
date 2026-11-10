/**
 * Lets Node's plain ESM loader understand the extensionless relative imports
 * the Next.js app is written in (`import ... from './insights'`). Next's
 * bundler resolves those itself; this loader does the same for the parity
 * test, which imports the app's module directly. Registered by
 * dashboard-parity.mjs before it imports files.js.
 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    const relative = specifier.startsWith('./') || specifier.startsWith('../');
    const hasExt = /\.[cm]?jsx?$/.test(specifier);
    if (relative && !hasExt) {
      for (const ext of ['.js', '.jsx', '.mjs', '.cjs']) {
        try {
          return await nextResolve(`${specifier}${ext}`, context);
        } catch {
          /* try the next extension */
        }
      }
    }
    throw err;
  }
}
