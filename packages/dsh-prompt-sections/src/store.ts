/**
 * The persisted section list: one JSON file, re-read when it changes on disk.
 *
 * ## Why a file rather than the profile entry's `config`
 *
 * The editor writes on every save, and a profile patch is a YAML document shared
 * with every other plugin in the layer — rewriting it from a plugin is a hostile
 * thing to do. A dedicated file also means a hand edit (`vim`) and the Web editor
 * are the same source of truth, and the prompt picks the edit up on the next
 * step, with no reload.
 *
 * ## Change detection
 *
 * `current()` stats the file on every call. A section's text is a provider that
 * runs at each assembly, so this is what makes an out-of-band edit visible
 * without a restart — and the stat is cached by modification time, so the common
 * case is one `statSync` per assembly, not per section.
 *
 * A file that fails to parse is NOT treated as empty: the last good state stays
 * live (wiping someone's prompt because they were mid-save in an editor would be
 * worse than serving a slightly stale one), and the parse error is surfaced to
 * the UI through {@link PromptStore.lastError}.
 *
 * @module dsh-prompt-sections/store
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { dshHomeDisplay, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { emptyState, normalizeState, StateValidationError, type LayerState } from './types.ts'

/** The logging surface this module needs (a subset of `ctx.logger`). */
export interface StoreLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** Where the current state came from, for the UI's status line. */
export type StoreSource = 'memory' | 'file' | 'missing' | 'unreadable'

/** Constructor options. */
export interface PromptStoreOptions {
  /** Absolute path of the JSON document. */
  path: string
  /** Logger used for load/save diagnostics. */
  logger: StoreLogger
}

/** One file stat, as far as change detection cares. */
interface FileStamp {
  mtimeMs: number
  size: number
}

function stampOf(path: string): FileStamp | undefined {
  try {
    const stat = statSync(path)
    return { mtimeMs: stat.mtimeMs, size: stat.size }
  } catch {
    return undefined
  }
}

function sameStamp(a: FileStamp | undefined, b: FileStamp | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return a.mtimeMs === b.mtimeMs && a.size === b.size
}

/**
 * Render a path for the UI without leaking a machine-specific home directory.
 *
 * @param path - absolute path.
 * @returns `~/.dsh/...` for paths under the default home, `$DSH_HOME/...` for a
 *   configured one, and the path unchanged otherwise.
 */
export function displayPath(path: string): string {
  const home = resolveDshHome()
  const prefix = home.endsWith('/') ? home : `${home}/`
  if (path === home) return dshHomeDisplay(home)
  if (path.startsWith(prefix)) return `${dshHomeDisplay(home)}${path.slice(home.length)}`
  return path
}

/** The section store. */
export class PromptStore {
  private readonly path: string
  private readonly logger: StoreLogger
  private state: LayerState = emptyState()
  private stamp: FileStamp | undefined
  private source: StoreSource = 'missing'
  private error: string | undefined
  private loaded = false

  constructor(options: PromptStoreOptions) {
    this.path = options.path
    this.logger = options.logger
  }

  /** Absolute path of the JSON document. */
  file(): string {
    return this.path
  }

  /** Display form of {@link file} for user-facing text. */
  displayPath(): string {
    return displayPath(this.path)
  }

  /** Where the current state came from. */
  origin(): StoreSource {
    return this.source
  }

  /** The last load or parse error, if the file could not be read. */
  lastError(): string | undefined {
    return this.error
  }

  /**
   * The current state, re-reading the file when it changed on disk.
   *
   * @returns a frozen view; callers must not mutate it.
   */
  current(): LayerState {
    if (!this.loaded) {
      // The first read stats the file: passing `undefined` here would mean "the
      // file is missing" and silently ignore a state document that already
      // exists on disk.
      this.loaded = true
      this.reload(stampOf(this.path))
      return this.state
    }
    const stamp = stampOf(this.path)
    if (!sameStamp(stamp, this.stamp)) this.reload(stamp)
    return this.state
  }

  /**
   * Validate, persist, and publish a new state.
   *
   * @param input - the candidate state (already parsed JSON).
   * @returns the normalized state that was stored.
   * @throws StateValidationError when the candidate is not acceptable.
   */
  save(input: unknown): LayerState {
    const next = normalizeState(input)
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${process.pid}.tmp`
    try {
      writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      renameSync(temporary, this.path)
    } catch (error) {
      try {
        unlinkSync(temporary)
      } catch {
        // The temporary file never appeared, or the rename already consumed it.
      }
      throw error
    }
    try {
      chmodSync(this.path, 0o600)
    } catch {
      // A filesystem without POSIX modes (or a Windows share) still stores the file.
    }
    this.state = next
    this.stamp = stampOf(this.path)
    this.source = 'memory'
    this.error = undefined
    this.loaded = true
    return next
  }

  /** Re-read the file. A failed read keeps the previous state live. */
  private reload(stamp: FileStamp | undefined): void {
    if (stamp === undefined) {
      this.state = emptyState()
      this.stamp = undefined
      this.source = 'missing'
      this.error = undefined
      return
    }
    try {
      const text = readFileSync(this.path, 'utf8')
      this.state = normalizeState(JSON.parse(text))
      this.stamp = stamp
      this.source = 'file'
      this.error = undefined
    } catch (error) {
      this.stamp = stamp
      this.source = 'unreadable'
      this.error = error instanceof StateValidationError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error)
      this.logger.warn(`prompt-sections: cannot read ${displayPath(this.path)} (${this.error}); keeping the previous state`)
    }
  }
}

export { StateValidationError }
