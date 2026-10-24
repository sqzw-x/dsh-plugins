/**
 * `dsh-system-prompt-insertion` — user-owned text injected into the DeepSeek
 * Harness system prompt.
 *
 * ## What it adds
 *
 * The harness assembles one system prompt per model step from ordered sections
 * contributed by plugins. This plugin lets the USER inject their own text as
 * those sections: written in the Web editor (or a JSON file), placed at the head,
 * the middle, or the very tail of that prompt, and rendered on every step with
 * no restart.
 *
 * A "section" is the harness's own unit of prompt composition, so user text lands
 * in the same layer as the platform's own instructions — unlike `AGENTS.md`, which
 * arrives as a *user-role* message whose frame explicitly says it does not
 * override system instructions.
 *
 * ## Composition
 *
 * One profile row mounts both halves:
 *
 * 1. the host half loads the state file, registers one prompt section per enabled
 *    entry, and (when `ctx.webServer` exists) serves the editor's JSON routes;
 * 2. the browser half registered by this package's `./client` export draws a
 *    left-column sidebar panel and talks to those routes.
 *
 * Nothing here is coupled to a specific agent preset: registration happens on the
 * host context, so the global layer covers Web sessions, subagents and workflow
 * children. A preset that takes over the whole prompt (`complete: true`, e.g. the
 * built-in `minimal`) cannot be appended to, and the editor says so.
 *
 * ## Configuration
 *
 * The row's `config` holds deployment switches only — never prompt text — so the
 * editor and a hand-edited file cannot disagree about what is live.
 *
 * @module dsh-system-prompt-insertion
 */
import { watchFile, unwatchFile } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { dshHomePath, expandHomePath } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { PromptStore } from './store.ts'
import { SectionRegistrar } from './register.ts'
import { buildPreview } from './preview.ts'
import { registerRoutes } from './routes.ts'

/** Cordis plugin name. */
export const name = 'system-prompt-insertion'

/** The prompt registry must exist before a section can be registered. */
export const inject: string[] = ['systemPrompt']

/** How long to coalesce filesystem change notifications. */
const WATCH_DEBOUNCE_MS = 60

/** How often the state file is polled for out-of-band edits. */
const WATCH_INTERVAL_MS = 1000

/** The profile row's configuration. */
export interface Config {
  /** Master switch: `false` registers nothing and serves no routes. */
  enabled: boolean
  /** State file override; empty uses `$DSH_HOME/system-prompt-insertion.json`. */
  storeFile: string
  /** Soft per-section size cap reported by the editor. */
  maxSectionBytes: number
}

/** Schema for {@link Config}. */
export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true)
    .description('Add the stored text to the system prompt as sections.'),
  storeFile: Schema.string().default('')
    .description('Path of the state file. Empty uses $DSH_HOME/system-prompt-insertion.json.'),
  maxSectionBytes: Schema.number().default(8192)
    .description('Soft per-section size cap the editor reports; nothing is truncated.'),
})

/** Options resolved from {@link Config}. */
export interface ResolvedOptions {
  /** Absolute path of the state document. */
  storeFile: string
  /** Soft per-section size cap. */
  maxSectionBytes: number
}

/**
 * Resolve the row configuration into absolute options.
 *
 * @param config - the row configuration.
 * @returns the paths and limits the plugin runs with.
 */
export function resolveOptions(config: Config): ResolvedOptions {
  const configured = config.storeFile.trim()
  return {
    storeFile: configured === '' ? dshHomePath('system-prompt-insertion.json') : expandHomePath(configured),
    maxSectionBytes: Number.isFinite(config.maxSectionBytes) && config.maxSectionBytes > 0
      ? config.maxSectionBytes
      : 8192,
  }
}

/**
 * Mount the user-owned system-prompt text and its editor.
 *
 * @param ctx - the profile row's context.
 * @param config - the validated row configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger
  if (!config.enabled) {
    logger.info('system-prompt-insertion: disabled by configuration')
    return
  }

  const options = resolveOptions(config)
  const store = new PromptStore({ path: options.storeFile, logger })
  const registrar = new SectionRegistrar(ctx, store, logger)

  ctx.effect(() => () => registrar.dispose(), 'system-prompt-insertion: registrations')

  // Out-of-band edits (vim, another tool, a restored backup) change the PLAN as
  // well as the text: a reordered or disabled section only moves when the plan is
  // rebuilt. The watcher is the trigger; `sync()` re-reads the file itself.
  ctx.effect(() => {
    let timer: NodeJS.Timeout | undefined
    const onChange = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        try {
          registrar.sync()
          logger.info(`system-prompt-insertion: reloaded ${registrar.registeredNames().length} section(s) after a file change`)
        } catch (error) {
          logger.warn(`system-prompt-insertion: reload failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }, WATCH_DEBOUNCE_MS)
      timer.unref?.()
    }
    watchFile(options.storeFile, { interval: WATCH_INTERVAL_MS }, onChange)
    return () => {
      if (timer !== undefined) clearTimeout(timer)
      unwatchFile(options.storeFile, onChange)
    }
  }, 'system-prompt-insertion: state watcher')

  registerRoutes(ctx, {
    store,
    registrar,
    logger,
    preview: () => buildPreview({ ctx, store, registrar, maxSectionBytes: options.maxSectionBytes }),
  })

  const state = registrar.sync()
  logger.info(
    `system-prompt-insertion: ${registrar.registeredNames().length} of ${state.sections.length} section(s) registered from ${store.displayPath()}`,
  )
}

export { PromptStore, displayPath } from './store.ts'
export { SectionRegistrar, resolveOrderBases } from './register.ts'
export { buildPreview } from './preview.ts'
export { ROUTE_PREFIX, MAX_BODY_BYTES, registerRoutes } from './routes.ts'
export {
  emptyState,
  normalizeState,
  StateValidationError,
  POSITIONS,
  SECTION_ID,
  SECTION_PREFIX,
  MAX_SECTIONS,
  MAX_TEXT_BYTES,
  type LayerState,
  type Position,
  type SectionSpec,
} from './types.ts'
export {
  BODY_BASE,
  FALLBACK_TAIL_BASE,
  HEAD_BASE,
  SECTION_STEP,
  TAIL_GAP,
  planRegistrations,
  resolveSectionOrder,
  type OrderBases,
} from './orders.ts'
