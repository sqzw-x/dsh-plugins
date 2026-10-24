/**
 * Registers the stored sections into the harness prompt registry.
 *
 * ## Scope
 *
 * Registration happens on the HOST context (`apply`'s own `ctx`), which puts every
 * section in the global layer. That is deliberate: the global layer is merged into
 * every agent's assembly, so one row covers the Web session, subagents and
 * workflow children alike — and a preset cannot shadow it, because shadowing is
 * keyed by section NAME and our names (`user:system-prompt-insertion:<id>`) are never used
 * by the harness or by a preset's persona row.
 *
 * The one exception is a preset that mounts `dsh-persona` with `complete: true`
 * (the built-in `minimal` preset): the registry restores that single section as
 * the whole prompt, so nothing can be appended. The UI reports that case from the
 * preview instead of pretending the text is live.
 *
 * ## Live text vs. live structure
 *
 * Each registered section's `text` is a provider, so editing a body takes effect
 * on the next assembly with no re-registration. Adding, removing, re-ordering or
 * disabling a section changes the *plan*, which is fixed at registration time;
 * {@link SectionRegistrar.sync} rebuilds it, and a file watcher calls `sync` when
 * the store changes underneath us.
 *
 * @module dsh-system-prompt-insertion/register
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { FALLBACK_TAIL_BASE, planRegistrations, type OrderBases } from './orders.ts'
import { SECTION_PREFIX, type LayerState } from './types.ts'
import type { PromptStore, StoreLogger } from './store.ts'

/** Read the host's own last built-in section order at runtime. */
export function resolveOrderBases(ctx: Context): OrderBases {
  const suffix: unknown = ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX')
  return { tailBase: typeof suffix === 'number' && Number.isFinite(suffix) ? suffix : FALLBACK_TAIL_BASE }
}

/** Diagnostics surface (a subset of `ctx.logger`). */
export type RegistrarLogger = StoreLogger

/** Owns the registered sections of one plugin instance. */
export class SectionRegistrar {
  private readonly ctx: Context
  private readonly store: PromptStore
  private readonly logger: RegistrarLogger
  private readonly prefix: string
  private disposers: Array<() => void> = []
  private names: string[] = []
  private orderByName = new Map<string, number>()
  private bases: OrderBases

  constructor(ctx: Context, store: PromptStore, logger: RegistrarLogger, prefix: string = SECTION_PREFIX) {
    this.ctx = ctx
    this.store = store
    this.logger = logger
    this.prefix = prefix
    this.bases = resolveOrderBases(ctx)
  }

  /** The band bases currently in use (also reported to the preview). */
  orderBases(): OrderBases {
    return this.bases
  }

  /** Names of the sections currently registered, for diagnostics and the preview. */
  registeredNames(): string[] {
    return [...this.names]
  }

  /** The concrete order each registered section was placed at. */
  registeredOrders(): ReadonlyMap<string, number> {
    return this.orderByName
  }

  /**
   * Rebuild the registration plan from the store.
   *
   * Registration is idempotent per plan: the previous plan is disposed first, so a
   * removed section cannot linger. A section whose registration throws (a name
   * collision with another plugin) is reported and skipped instead of taking the
   * whole plugin down.
   *
   * @returns the state that was planned from.
   */
  sync(): LayerState {
    this.dispose()
    this.bases = resolveOrderBases(this.ctx)
    const state = this.store.current()
    const plan = planRegistrations(state, this.bases, this.prefix)
    for (const entry of plan) {
      const { section } = entry
      try {
        const dispose = this.ctx.systemPrompt.section({
          name: entry.name,
          order: entry.order,
          // The provider reads the store on every assembly: a body edit is live
          // even before the watcher notices the file and rebuilds the plan.
          text: () => {
            const current = this.store.current().sections.find((candidate) => candidate.id === section.id)
            return current?.text ?? ''
          },
          ...section.interpolate ? {} : { interpolate: false },
        })
        this.disposers.push(dispose)
        this.names.push(entry.name)
        this.orderByName.set(entry.name, entry.order)
      } catch (error) {
        this.logger.warn(
          `system-prompt-insertion: cannot register "${section.id}" at order ${entry.order}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    return state
  }

  /** Dispose every registration this instance owns. */
  dispose(): void {
    this.names.splice(0)
    this.orderByName.clear()
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // A failed disposer must not keep the rest mounted.
      }
    }
  }
}
