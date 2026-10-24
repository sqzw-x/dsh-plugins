# omp (`can1357/oh-my-pi`) — Context Compaction & Context Window: Source-Verified Report

Method: full recursive tree via `gh api .../git/trees/main?recursive=1` (8,964 blobs, `truncated: false`),
then the source tarball `https://codeload.github.com/can1357/oh-my-pi/tar.gz/refs/heads/main` extracted
locally for exhaustive grep. Every citation below is a `raw.githubusercontent.com/can1357/oh-my-pi/main/...`
URL; line numbers were verified by comparing `curl | wc -l` against the local extraction.

---

## 0. Bottom line: plugin field → upstream reality

| Plugin field (host framework) | omp upstream equivalent | Verdict |
|---|---|---|
| `thresholdRatio` (0.8) | No ratio key. `compaction.thresholdPercent` (**ratio**, default `-1`) or reserve-derived threshold. Reserve policy is effectively **85%** for windows above ~109k | **No `0.8` anywhere.** Closest real ratio default is a 15% reserve floor |
| `headroomTokens` (65536) | `compaction.reserveTokens` (**absolute**, default **unset** → `16384` floor, or 15% of window, whichever is larger) | Real key, **wrong default value**; 65536 not found in any compaction path |
| `retainRatio` (0.16) | — | **NOT FOUND.** omp has no ratio for retained history |
| `retainTokens` (absolute) | `compaction.keepRecentTokens` (**absolute**, default `20000`) — scaled down at runtime by a measured usage ratio | Real key |
| `maxTokens` | `MAX_SUMMARY_TOKENS = 16384` (hard cap on generated summary, derived: `min(floor(0.8 × reserve), 16384)`); `compaction.v2RetainedMessageBudget` = `64000` | **No user-facing `maxTokens` compaction setting exists** |
| `modelPolicies[]` | `compaction.modelThresholds` (**record**, default `{}`) + `task.agentCompactionThresholdOverrides` | Real concept, different name |
| `reminderLeadRatio` (0.125) | `SPECULATION_LEAD_FRACTION = 0.125` | **GENUINE UPSTREAM** — exact value |
| `reminderLeadMinTokens` (8192) | `SPECULATION_LEAD_MIN_TOKENS = 8_192` | **GENUINE UPSTREAM** — exact value |
| `reminderLeadMaxTokens` (32000) | `SPECULATION_LEAD_MAX_TOKENS = 32_000` | **GENUINE UPSTREAM** — exact value |
| `rolloverText` | `prompts/system/experimental-context-rollover.md` | Real, hard-coded prompt (not a config key) |
| `notebookSummaryMaxChars` (2048) | — | **NOT FOUND** as a notebook/summary bound |
| `maxNotebookBytes` (16384) | `MAX_CONTEXT_NOTES_BYTES = 16_384` | **GENUINE UPSTREAM** — exact value |

**Headline answer to Q3:** the `ratio + lower bound + upper bound` triple is **not** a plugin invention.
It exists verbatim upstream as the *speculation lead*, and the SAME function governs the model-facing
notebook reminder. The plugin renamed it `reminderLead*`, which happens to be the more accurate name for
the reminder use, but the triple and all three constants are upstream.

---

## 1. Compaction config

All compaction settings are registered in one file, `packages/coding-agent/src/session/context-settings.ts`
(not `packages/coding-agent/src/config/` — that directory only holds the *parsers*).

Source: https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/session/context-settings.ts

### Defaults (verbatim from source)

| Key | Default | Unit | Line |
|---|---|---|---|
| `compaction.enabled` | `true` | bool | 106 |
| `compaction.experimentalContextManagement` | `false` | bool | 118 |
| `compaction.midTurnEnabled` | `true` | bool | 130 |
| `compaction.methodOrder` | `[...DEFAULT_COMPACTION_METHOD_ORDER]` → `[remote, snapcompact, handoff, shake, soft]` | array | 143 |
| `compaction.thresholdPercent` | `-1` | **RATIO (percent)**; `-1` = legacy reserve-based | 158 |
| `compaction.thresholdTokens` | `-1` | **ABSOLUTE tokens**; `>0` wins over percent | 185 |
| `compaction.modelThresholds` | `{}` | record | 217 |
| `compaction.modelThresholdsEnabled` | `true` | bool | 229 |
| `compaction.handoffSaveToDisk` | `false` | bool | 235 |
| `compaction.remoteStreamingV2Enabled` | `true` | bool | 247 |
| `compaction.asyncEnabled` | `true` | bool | 259 |
| `compaction.reserveTokens` | **`undefined` (unset)** | **ABSOLUTE tokens** | 276 |
| `compaction.keepRecentTokens` | `20000` | **ABSOLUTE tokens** | 282 |
| `compaction.autoContinue` | `true` | bool | 287 |
| `compaction.remoteEndpoint` | `undefined` | string | 290 |
| `compaction.v2RetainedMessageBudget` | `64000` | **ABSOLUTE tokens** | 296 |
| `compaction.idleEnabled` | `false` | bool | 303 |
| `compaction.idleThresholdTokens` | `200000` | **ABSOLUTE tokens** | 315 |
| `compaction.idleTimeoutSeconds` | `300` | seconds | 338 |
| `compaction.supersedeReads` | `true` | bool | 358 |
| `compaction.dropUseless` | `true` | bool | 370 |

The three key ones, quoted in full:

```ts
export const cfgCompactionThresholdPercent = register({
	id: "compaction.thresholdPercent",
	type: "number",
	default: -1,
	ui: {
		tab: "context",
		group: "Compaction",
		label: "Compaction Threshold",
		description: "Percent threshold for context maintenance; set to Default to use legacy reserve-based behavior",
		options: [
			{ value: "default", label: "Default", description: "Legacy reserve-based threshold" },
			...
			{ value: "80", label: "80%", description: "Typical threshold" },
			...
		],
	},
});
```

```ts
export const cfgCompactionReserveTokens = register({
	id: "compaction.reserveTokens",
	type: "number",
	default: undefined,
});
```
Preceded by this comment (lines 270-274) — which explains why there is no materialized `16384` default:

```ts
// No default: an unset reserve tells the compaction layer the user never
// chose one, so small-window recovery may swap in the proportional reserve
// (see resolveBudgetReserveTokens). A materialized 16384 here would make
// every session look explicitly configured.
```

```ts
export const cfgCompactionKeepRecentTokens = register({
	id: "compaction.keepRecentTokens",
	type: "number",
	default: 20000,
});
```

### Threshold resolution math

Source: https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/agent/src/compaction/compaction.ts

```ts
/** Reserve applied when {@link CompactionSettings.reserveTokens} is unset. */
export const DEFAULT_RESERVE_TOKENS = 16384;
```
(line 193)

```ts
export const MAX_SUMMARY_TOKENS = DEFAULT_RESERVE_TOKENS;   // line 205
```

```ts
/**
 * Effective reserve: at least 15% of context window or the configured floor
 * (defaulting to {@link DEFAULT_RESERVE_TOKENS} when unset), whichever is larger.
 */
export function effectiveReserveTokens(contextWindow: number, settings: CompactionSettings): number {
	return Math.max(Math.floor(contextWindow * 0.15), settings.reserveTokens ?? DEFAULT_RESERVE_TOKENS);
}
```
(line 315)

```ts
export function resolveThresholdTokens(contextWindow: number, settings: CompactionSettings): number {
	// Fixed token limit takes priority over percentage, and is checked against
	// the real window: `baseWindowTokens` only rescales the policies below.
	const thresholdTokens = settings.thresholdTokens;
	if (typeof thresholdTokens === "number" && Number.isFinite(thresholdTokens) && thresholdTokens > 0) {
		if (thresholdTokens >= contextWindow) return promptBudgetTokens(contextWindow, settings);
		return Math.min(contextWindow - 1, Math.max(1, thresholdTokens));
	}
	const baseWindowTokens = settings.baseWindowTokens;
	if (typeof baseWindowTokens === "number" && Number.isFinite(baseWindowTokens) && baseWindowTokens > 0) {
		contextWindow = Math.min(contextWindow, baseWindowTokens);
	}
	const thresholdPercent = settings.thresholdPercent;
	if (typeof thresholdPercent !== "number" || !Number.isFinite(thresholdPercent) || thresholdPercent <= 0) {
		return promptBudgetTokens(contextWindow, settings);
	}
	const clampedThresholdPercent = Math.min(99, Math.max(1, thresholdPercent));
	return Math.floor(contextWindow * (clampedThresholdPercent / 100));
}
```
(lines 376-408)

So with all defaults the trigger is `contextWindow − max(floor(window × 0.15), 16384)`:
a 200k window fires at **170,000 tokens (85%)**; a 1M window at **850,000 (85%)**;
a 100k window at **85,000 (85%)**; a 32k window at **27,200 (85%)**.
`0.8` appears nowhere.

**Summary output cap** (this is the closest thing to a `maxTokens`, and it is *derived*, not configured):
```ts
const maxTokens = Math.min(Math.floor(0.8 * reserveTokens), MAX_SUMMARY_TOKENS);   // line 882
```
Also line 2001 (`0.8 × reserve`, same cap) and line 2157 (turn-prefix summary uses `0.5 × reserve`).

**Retained history** is `keepRecentTokens` (absolute), and it is *reduced* at runtime by a measured ratio:
```ts
let keepRecentTokens = settings.keepRecentTokens;
if (lastUsage) {
	const estimatedTokens = tokenizer.countMessages(compactionMessages);
	const promptTokens = calculatePromptTokens(lastUsage);
	const ratio = estimatedTokens > 0 ? promptTokens / estimatedTokens : 0;
	if (Number.isFinite(ratio) && ratio > 1) {
		keepRecentTokens = Math.max(1, Math.floor(keepRecentTokens / ratio));
	}
}
```
(lines 1430-1438, `packages/agent/src/compaction/compaction.ts`)

Docs corroborate the whole section:
https://raw.githubusercontent.com/can1357/oh-my-pi/main/docs/compaction.md#L513-L524 (defaults list) and
https://raw.githubusercontent.com/can1357/oh-my-pi/main/docs/settings.md#L776-L782 (settings table).

---

## 2. Notes mechanism — YES, it exists, and it is exactly notes-backed

omp has an opt-in mode that **replaces** LLM summarization with a model-written persistent notebook plus a
recoverable raw transcript. Gate: `compaction.experimentalContextManagement` (default `false`), labelled
*"Notes-backed context windows (experimental)"*.

The tool the model calls is named **`context_notes`** (read with no args, replace with `text`, clear with
`text: ""`). There is a second tool, **`new_context`**, that requests rollover.

### The 16 KiB bound — confirmed

Source: https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/session/context-notes.ts#L5-L6
```ts
export const CONTEXT_NOTES_ENTRY_TYPE = "experimental_context_notes";
export const MAX_CONTEXT_NOTES_BYTES = 16_384;
```

Enforced on write, in
https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/tools/context-notes.ts#L116-L121
```ts
const bytes = Buffer.byteLength(params.text, "utf8");
if (bytes > MAX_CONTEXT_NOTES_BYTES) {
	throw new ToolError(
		`Context notes are ${bytes} bytes; the limit is ${MAX_CONTEXT_NOTES_BYTES} UTF-8 bytes. Shorten the notebook and use history://current/full to recover raw detail.`,
	);
}
```
and re-validated on read so a malformed journal entry cannot mask a valid one
(`session/context-notes.ts#L32`, `Buffer.byteLength(candidate.text, "utf8") <= MAX_CONTEXT_NOTES_BYTES`).

### What the model is told

`packages/coding-agent/src/prompts/system/context-notes.md` (injected every turn while a notebook exists):
> Keep the notebook a compact, current index: task state, decisions, changed files, evidence, blockers, and
> next steps, one line per item without copied logs or file bodies. Replace stale entries rather than
> appending, so the notebook stays well under its 16 KiB bound.

### `16777216` — NOT FOUND

16 MiB appears nowhere in omp. Per the plugin brief this was given as "a 16 KiB bound" in decimal-looking
form; the real byte bound is **16,384** (`16 * 1024`) and it is bytes, not chars. `16777216` → negative finding.

### `notebookSummaryMaxChars` (2048) — NOT FOUND

No notebook/summary character bound exists. The nearest `2048` values are unrelated: `thinkingBudgets.low`
default (`packages/coding-agent/src/session/settings.ts:1465`), and a hard-coded `maxTokens: 2048` for
*branch summarization* output (`packages/agent/src/compaction/branch-summarization.ts:349`).

Docs: https://raw.githubusercontent.com/can1357/oh-my-pi/main/docs/compaction.md#L152-L192
("Experimental notes-backed context windows"), and the tool reference
https://raw.githubusercontent.com/can1357/oh-my-pi/main/docs/tools/context-notes.md

---

## 3. Reminder / lead — the ratio+min+max triple IS genuine upstream

Source: https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/session/speculation-lead.ts
(the entire file, 24 lines):

```ts
/**
 * Speculative-compaction lead: how far below the compaction threshold the
 * background summarizer starts. Derived from the threshold instead of a second
 * user-facing knob so the band scales with the window — a fixed percentage gap
 * would be 200k tokens on a 1M model and useless on a 32k one. The floor keeps
 * tiny windows from speculating every turn; the cap bounds how much history the
 * armed summary misses (the kept tail grows by at most ~lead tokens between
 * compute and apply).
 *
 * Shared by the maintenance loop (fire decision) and the status line's
 * annotated context gauge (boundary marker position).
 */
const SPECULATION_LEAD_FRACTION = 0.125;
/** Floor of the speculation band; also the armed-summary refresh budget floor. */
export const SPECULATION_LEAD_MIN_TOKENS = 8_192;
const SPECULATION_LEAD_MAX_TOKENS = 32_000;

/** Tokens the threshold band spans: speculation fires inside `[threshold − lead, threshold)`. */
export function resolveSpeculationLeadTokens(thresholdTokens: number): number {
	return Math.min(
		SPECULATION_LEAD_MAX_TOKENS,
		Math.max(SPECULATION_LEAD_MIN_TOKENS, Math.floor(thresholdTokens * SPECULATION_LEAD_FRACTION)),
	);
}
```

This is **exactly** the plugin's `reminderLeadRatio: 0.125` / `reminderLeadMinTokens: 8192` /
`reminderLeadMaxTokens: 32000`, and it is a **ratio with min and max clamps**. It is **derived, not
configurable** — the doc comment explicitly says it is "derived from the threshold instead of a second
user-facing knob."

### The model-facing reminder uses the same function

Source: https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/session/session-maintenance.ts#L595-L614

```ts
	/**
	 * The notebook prompt is deliberately single-shot per rollover window. It is
	 * injected by the owner at the next normal aside boundary, never by rewriting
	 * a completed provider turn.
	 */
	#maybeQueueExperimentalNotesReminder(contextTokens: number, contextWindow: number): void {
		if (!this.#usesExperimentalContextManagement()) return;
		const settings = this.#compactionSettings;
		if (!settings.enabled || this.isCompacting || this.#host.isGeneratingHandoff()) return;
		const thresholdTokens = resolveThresholdTokens(contextWindow, settings);
		if (contextTokens >= thresholdTokens) return;
		if (thresholdTokens - contextTokens > resolveSpeculationLeadTokens(thresholdTokens)) return;
		const branch = this.#host.sessionManager.getBranch();
		const boundaryId =
			branch.findLast(entry => entry.type === "compaction" || entry.type === "reset_boundary")?.id ??
			branch[0]?.id ??
			"empty";
		if (this.#experimentalNotesReminderBoundaryId === boundaryId) return;
		this.#experimentalNotesReminderBoundaryId = boundaryId;
		this.#host.queueExperimentalContextNotesReminder(experimentalContextNotesReminderPrompt);
	}
```

So the warm band is exactly `[threshold − lead, threshold)`, it is **single-shot per rollover window**
(deduped by `boundaryId`), and it queues the reminder prompt. This is invoked from
`maybeStartSpeculativeCompaction` at line 2090 (when experimental context management is on, the notes
reminder takes the place of speculative summarization):

```ts
		if (this.#usesExperimentalContextManagement()) {
			this.#maybeQueueExperimentalNotesReminder(contextTokens, contextWindow);
			return;
		}
```

The prompt itself — https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/prompts/system/experimental-context-notes-reminder.md
(whole file):
```md
<context-window-reminder>
The current context window is nearing its rollover threshold. Before important details fall out of the live tail, use context_notes to save a concise durable notebook: current task state, decisions, changed files, evidence, blockers, and exact next steps. Keep the notebook a compact index with one line per item, no copied logs or file bodies, and replace stale entries instead of appending so it stays well under the 16 KiB cap. Do not call new_context until the notebook is current.
</context-window-reminder>
```

And the rollover prompt (the plugin's `rolloverText`) —
https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/prompts/system/experimental-context-rollover.md
(whole file):
```md
<context-window-rollover>
The earlier raw transcript remains canonical and recoverable at history://current/full. Continue from the persistent notebook, the retained recent tail, and the latest user request or parent assignment, which is retained separately when it falls outside the tail. Earlier task instructions and constraints may still require recovery from raw history. Do not assume this boundary is an LLM summary; use the notebook and raw-history URI when prior details are needed.
</context-window-rollover>
```

Docs state the formula in plain text too — `docs/compaction.md#L513`:
> when context enters the pre-threshold band `[threshold − lead, threshold)` (lead = `clamp(threshold × 0.125, 8192, 32000)`)

and `docs/compaction.md#L173-174`:
> `new_context` requests rollover at the next safe tool-loop boundary. Rollover retains complete recent
> tool-call/result units and the notebook without calling a summarization model. Near the automatic
> threshold, the model receives a once-per-window reminder to save its working state.

---

## 4. Adaptivity and per-model overrides

**Yes on both counts.**

**(a) Ratio-based / window-scaling.** `compaction.thresholdPercent` is a percent of the *active* model's
window, and the reserve fallback is `max(floor(window × 0.15), 16384)`, so one config adapts across 32k →
1M windows. The lead is intentionally derived from the threshold for the same reason ("a fixed percentage
gap would be 200k tokens on a 1M model and useless on a 32k one"). `keepRecentTokens` is additionally
rescaled by the measured prompt/estimate ratio at compaction time (lines 1430-1438 above).

**(b) Per-model override table.** `compaction.modelThresholds` is a record keyed by exact
`provider/model-id` or a `*`-terminated prefix; longest prefix wins.

Source: https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/compaction-threshold.ts
```ts
/**
 * Validate `compaction.modelThresholds`: keys are an exact `provider/model-id`
 * or a `*`-terminated prefix of one (`deepseek/*`, `openrouter/anthropic/*`).
 */
export function validateModelCompactionThresholds(value: unknown): Record<string, CompactionThresholdPair> {
	return validateThresholdMap("compaction.modelThresholds", "model selector", value, {
		checkKey: checkModelThresholdKey,
		allowFixed: true,
	});
}
```
```ts
export type AgentCompactionThresholdOverride = number | string | null;
```
Entry grammar (line 71-72): `a positive integer token count (e.g. 90000), a fixed trigger (e.g. "f90000") or a percentage in (0, 100] (e.g. "80%")`.
There is also a per-*agent* table, `task.agentCompactionThresholdOverrides` (exact agent name → token count or `"80%"`),
which outranks model entries via `compaction.modelThresholdsEnabled`.

Semantics of a token entry (it *stands in for the window* rather than being a literal trigger):
```ts
/**
 * `settings` with one model entry applied. A token entry is the base the
 * configured policy scales (`baseWindowTokens`, standing in for the window:
 * `thresholdPercent` of it, else it minus the reserve) and drops a global fixed
 * `thresholdTokens`; a fixed entry (`"f90000"`) is the exact trigger; a
 * percentage entry replaces both threshold fields.
 */
export function applyCompactionThresholdPair<T extends CompactionThresholdPair & { baseWindowTokens?: number }>(
	settings: T,
	threshold: CompactionThresholdPair,
): T {
	const { thresholdPercent, thresholdTokens, fixed } = threshold;
	return thresholdTokens > 0 && !fixed
		? { ...settings, thresholdTokens: -1, baseWindowTokens: thresholdTokens }
		: { ...settings, thresholdPercent, thresholdTokens };
}
```

Also relevant: `compaction.modelThresholdsEnabled` (default `true`) and the extended-window interaction —
a token base past a model's standard window opts that model into its extended window
(`resolveModelCompactionSettings` / `planModelCompactionEntry` in
https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/session/model-compaction-threshold.ts).

**Negative finding on the plugin's literal field name:** `modelPolicies` does not exist. The only
`modelPolicies`-named symbol in the tree is `ModelRegistry.reapplyModelPolicies`, which is about model
availability/window clamping, **not** compaction — an unrelated name collision.

---

## 5. Explicit negative findings (nothing guessed)

| Searched | Result |
|---|---|
| `thresholdRatio` | NOT FOUND |
| `headroomTokens` / a 65536 headroom | NOT FOUND. The word "headroom" in omp means either image-payload headroom (`ANTHROPIC_IMAGE_PAYLOAD_HEADROOM = 0.9`), credential/rate-limit headroom (`packages/ai/src/auth/*`), or prose in the compaction doc. The compaction analogue is `reserveTokens` |
| `retainRatio` | NOT FOUND |
| `retainTokens` | NOT FOUND by that name (`keepRecentTokens` is the concept) |
| `reminderLead*` | NOT FOUND by that name, but the exact triple exists as `SPECULATION_LEAD_*` |
| `modelPolicies` | NOT FOUND (only the unrelated `reapplyModelPolicies`) |
| `notebookSummaryMaxChars` | NOT FOUND |
| `16777216` | NOT FOUND |
| A user-facing compaction `maxTokens` setting | NOT FOUND. Only the derived `MAX_SUMMARY_TOKENS = 16384` cap and `compaction.v2RetainedMessageBudget = 64000` |
| `0.8` as a compaction threshold | NOT FOUND. `0.8` appears only in summary-budget formulae (`0.8 × reserveToken`) and doc prose |

## 6. Numeric-coincidence note (observation, not a claim about the plugin's source)

The plugin's absolute constants are derivable from omp's, but two do **not** match any omp constant:
- `maxNotebookBytes 16384` == `MAX_CONTEXT_NOTES_BYTES` **and** `DEFAULT_RESERVE_TOKENS` (both 16384 upstream).
- `reminderLead*` == the `SPECULATION_LEAD_*` triple exactly.
- `retainRatio 0.16` × a 200,000 window = 32,000 = `SPECULATION_LEAD_MAX_TOKENS`; 0.16 = 0.8 × 0.2.
- `headroomTokens 65536` = 4 × 16384; it matches **no** omp compaction constant. Upstream 65536 values are
  all model-catalog output caps (Ollama Cloud, Gemini CLI, Fireworks Kimi), unrelated to compaction.

---

## Source index (raw URLs)

- https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/session/context-settings.ts
- https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/session/speculation-lead.ts
- https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/session/session-maintenance.ts
- https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/session/context-notes.ts
- https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/session/model-compaction-threshold.ts
- https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/tools/context-notes.ts
- https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/compaction-threshold.ts
- https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/agent/src/compaction/compaction.ts
- https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/prompts/system/context-notes.md
- https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/prompts/system/experimental-context-notes-reminder.md
- https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/prompts/system/experimental-context-rollover.md
- https://raw.githubusercontent.com/can1357/oh-my-pi/main/docs/compaction.md
- https://raw.githubusercontent.com/can1357/oh-my-pi/main/docs/settings.md
- https://raw.githubusercontent.com/can1357/oh-my-pi/main/docs/tools/context-notes.md
- https://raw.githubusercontent.com/can1357/oh-my-pi/main/docs/tools/new-context.md

Site mirror: https://omp.sh/docs/compaction , https://omp.sh/docs/settings
