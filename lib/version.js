/**
 * Single source of truth for the plugin version at runtime.
 *
 * `package.json` carries the same value; `npm run lint` fails when the two
 * drift apart, so a release only needs one edit plus the changelog.
 */
export const VERSION = '1.0.0'

/** npm package name; used by the health endpoint and diagnostics. */
export const PLUGIN_NAME = 'dsh-prompt-enhance'
