/**
 * Test-only ESM loader: resolve @deepseek-ai/* from an installed DSH tree so
 * the test imports the same package instances as the running Harness.
 *
 * Roots, in order:
 *   1. DSH_PACKAGES_DIR
 *   2. DSH_INSTALL_DIR/../.. (a normal install's node_modules)
 *   3. NODE_PATH entries
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'

const roots = [
  process.env.DSH_PACKAGES_DIR,
  process.env.DSH_INSTALL_DIR === undefined ? undefined : resolvePath(process.env.DSH_INSTALL_DIR, '../..'),
  ...(process.env.NODE_PATH ?? '').split(':'),
].filter(root => typeof root === 'string' && root.length > 0)

function packageDir(name) {
  for (const root of roots) {
    const candidate = join(root, name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

export async function resolve(specifier, context, next) {
  if (!specifier.startsWith('@deepseek-ai/')) return next(specifier, context)
  const name = specifier.split('/').slice(0, 2).join('/')
  const dir = packageDir(name)
  if (dir === undefined) {
    throw new Error(
      'test loader: cannot resolve ' + specifier
      + '; set DSH_PACKAGES_DIR to a node_modules directory containing @deepseek-ai/*',
    )
  }
  const require = createRequire(join(dir, 'package.json'))
  return next(pathToFileURL(require.resolve(specifier)).href, context)
}
