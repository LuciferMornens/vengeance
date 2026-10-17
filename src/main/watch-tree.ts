import { EventEmitter } from 'node:events'
import { existsSync, lstatSync, readdirSync, watch, type FSWatcher, type WatchEventType } from 'node:fs'
import { join, sep } from 'node:path'

/** What a caller keeps of a folder-tree watch: Node's FSWatcher, or the Linux stand-in below. */
export interface TreeWatcher {
  close(): void
  on(event: 'error', listener: (error: Error) => void): this
}

/** `filename` is relative to the watched root (platform separators), null when the system does not say. */
export type TreeListener = (event: WatchEventType, filename: string | null) => void

/**
 * fs.watch over a folder and its subfolders. Windows and macOS watch whole trees natively. Linux has no recursive
 * inotify: Node walks the tree with one watch per folder, and when it cannot add one for a folder created later
 * (ENOSPC once fs.inotify.max_user_watches is used up) it throws from inside its own event callback, where nothing can
 * catch it. So Linux watches the root and the subfolders `descend` picks (path segments below the root), one by one.
 * Throws like fs.watch when the tree cannot be watched; a folder that cannot be watched later ends the whole watch
 * with an 'error' event, as a failing native watch does, and so does a removed root after a last `rename` event.
 */
export function watchTree(
  root: string,
  descend: (segments: string[]) => boolean,
  listener: TreeListener
): TreeWatcher {
  if (process.platform !== 'linux') {
    return watch(root, { recursive: true, persistent: false }, listener)
  }
  return new FolderTreeWatcher(root, descend, listener)
}

function isGone(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function isFolder(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false
}

/** Linux: a non-recursive watch per picked folder, following folders as they appear and disappear. */
class FolderTreeWatcher extends EventEmitter implements TreeWatcher {
  /** Watched folders by path relative to the root ('' is the root). */
  private readonly folders = new Map<string, FSWatcher>()
  private closed = false

  constructor(
    private readonly root: string,
    private readonly descend: (segments: string[]) => boolean,
    private readonly listener: TreeListener
  ) {
    super()
    try {
      this.add('', true)
    } catch (error) {
      this.close()
      throw error
    }
  }

  close(): void {
    this.closed = true
    for (const watcher of this.folders.values()) watcher.close()
    this.folders.clear()
  }

  /**
   * Watch `folder`, then the subfolders below it that `descend` picks. A folder found after the start reports its
   * entries, which may have been written before its watch existed.
   */
  private add(folder: string, initial: boolean): void {
    const path = join(this.root, folder)
    const watcher = watch(path, { persistent: false }, (event, name) =>
      this.changed(folder, event, name)
    )
    watcher.on('error', (error) => this.fail(error))
    this.folders.set(folder, watcher)
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (this.closed) return
      const child = folder ? join(folder, entry.name) : entry.name
      if (!initial) this.listener('rename', child)
      if (entry.isDirectory() && this.descend(child.split(sep))) this.follow(child, initial)
    }
  }

  /** `add` for a subfolder; one that is gone again is dropped (its parent reports the removal). */
  private follow(folder: string, initial: boolean): void {
    try {
      this.add(folder, initial)
    } catch (error) {
      if (isGone(error)) this.forget(folder)
      else if (initial) throw error
      else this.fail(error as Error)
    }
  }

  private changed(folder: string, event: WatchEventType, name: string | null): void {
    if (this.closed) return
    if (event === 'rename' && !existsSync(join(this.root, folder))) {
      // The folder itself went away. A subfolder's parent reports that; the root says so and ends the watch.
      if (folder) {
        this.forget(folder)
        return
      }
      this.listener(event, null)
      this.fail(new Error(`${this.root} was removed`))
      return
    }
    const path = name === null ? null : folder ? join(folder, name) : name
    this.listener(event, path)
    if (event !== 'rename' || path === null) return
    if (!isFolder(join(this.root, path))) this.forget(path)
    else if (!this.folders.has(path) && this.descend(path.split(sep))) this.follow(path, false)
  }

  /** Stop watching `folder` and everything below it. */
  private forget(folder: string): void {
    for (const [path, watcher] of this.folders) {
      if (path !== folder && !path.startsWith(`${folder}${sep}`)) continue
      watcher.close()
      this.folders.delete(path)
    }
  }

  private fail(error: Error): void {
    if (this.closed) return
    this.close()
    this.emit('error', error)
  }
}
