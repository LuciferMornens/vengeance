/**
 * Package sources the Engine cannot install. Pure — the install box checks while the user types, and the
 * main process refuses the same sources before it runs the Engine.
 */

/**
 * A packed `.tgz` / `.tar.gz`. The Engine has no tarball source: it would load the file as a single-file
 * extension, and every engine start then fails.
 */
export function isTarballSource(source: string): boolean {
  return /\.(tgz|tar\.gz)$/i.test(source.trim())
}

export const TARBALL_HINT = 'A packed tarball can’t be installed. Unpack it, then install the folder.'
