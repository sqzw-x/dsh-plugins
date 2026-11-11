/**
 * The two model-facing tools of `dsh-notes-context`.
 *
 * - `context_notes` — read, replace, or clear the persistent notebook.
 * - `context_history` — read the ACTIVE session's raw transcript back by stable
 *   sequence range, including the compaction/rollover boundaries in it.
 *
 * Registration is an effect: `registerTools` is called from the plugin's `apply`
 * and Cordis removes both tools when the fiber disposes. Nothing here mutates
 * module-level state, and every tunable comes from {@link Config}.
 *
 * @module dsh-notes-context/tools
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MessageSource } from '@deepseek-ai/dsh-llm/message'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from './config.ts'
import {
	CONTEXT_NOTES_TOOL_NAME,
	NotebookTooLargeError,
	latestNotebook,
	markNotebookWriteRejected,
	notebookBytes,
	writeNotebook,
} from './notebook.ts'
import { NOTEBOOK_SOURCE_KIND, REMINDER_SOURCE_KIND } from './inject.ts'

/**
 * Model-facing name of the notebook tool.
 *
 * Re-exported from `notebook.ts` rather than declared here: the log-recovery arm
 * there has to recognize this tool's `tool/call` events, so the name is part of
 * the storage contract.
 */
export const CONTEXT_NOTES_TOOL = CONTEXT_NOTES_TOOL_NAME

/** Model-facing name of the raw-history tool. */
export const CONTEXT_HISTORY_TOOL = 'context_history'

/**
 * Event-type prefix for the log events a compaction transaction emits. Matched
 * by prefix rather than against a closed union on purpose: this package does not
 * declare the `compaction/*` session events (they belong to
 * `@deepseek-ai/dsh-compaction`), so switching on those literals would be a
 * non-exhaustive comparison against `SessionEventMap` from here.
 */
const BOUNDARY_EVENT_PREFIX = 'compaction/'

/**
 * Whether one log event marks a rollover/compaction boundary.
 *
 * Two shapes count, because the boundary is visible on two different surfaces:
 *
 * 1. The `compaction/*` transaction events, from the raw log.
 * 2. The REPLACEMENT `user/message` the backend publishes as the boundary's
 *    model-visible record — recognized by its `compact-checkpoint` source using
 *    the backend-independent predicate `isCompactCheckpointSource`
 *    (`@deepseek-ai/dsh-compaction`, `lib/types/checkpoint.d.ts:37`, runtime at
 *    `lib/index.js:128-130`). Checking the source rather than the event type is
 *    what makes this work for every backend, and it is the shape this plugin's
 *    own notebook has to survive.
 *
 * @param event - one session log entry.
 * @returns whether the event is a rollover/compaction boundary.
 */
function isBoundaryEvent(event: SessionEvent): boolean {
	if (event.type.startsWith(BOUNDARY_EVENT_PREFIX)) return true
	if (event.type !== 'user/message') return false
	const data: unknown = event.data
	if (!isRecord(data)) return false
	const source = data['source']
	return isRecord(source) && isCompactCheckpointSource(source as MessageSource)
}

/** Whether a value is a non-null object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Resolve the live session a tool call runs against.
 *
 * A tool with no active agent (for example an out-of-band protocol invocation)
 * has no session to read or write, so this fails loudly rather than inventing
 * one.
 *
 * @param agent - `exec.agent`, present when the agent loop dispatched the call.
 * @returns the live session.
 * @throws {Error} when the call has no agent or no session.
 */
function requireSession(agent: Agent | undefined): Session {
	if (agent === undefined) throw new Error('this tool requires an active agent session')
	return agent.session
}

/**
 * Truncate a summary to the configured character cap.
 *
 * @param text - the raw summary text.
 * @param cfg - resolved configuration supplying the cap and marker.
 * @returns the possibly-truncated summary.
 */
function truncateSummary(text: string, cfg: Config): string {
	// Read once per operation: a live settings write between two reads of the same
	// field would otherwise produce a summary truncated by one cap and suffixed by
	// another configuration's marker.
	const cap = cfg.historySummaryMaxChars.get()
	if (text.length <= cap) return text
	return text.slice(0, cap) + cfg.summaryTruncationMarker.get()
}

/**
 * Extract the readable text of a message-shaped payload.
 *
 * @param message - candidate message record.
 * @returns the concatenated text blocks, or `undefined` when none are present.
 */
function messageText(message: Record<string, unknown>): string | undefined {
	const content = message['content']
	if (!Array.isArray(content)) return undefined
	const parts: string[] = []
	for (const block of content) {
		if (!isRecord(block)) continue
		if (block['type'] !== 'text') continue
		const text = block['text']
		if (typeof text === 'string') parts.push(text)
	}
	return parts.length === 0 ? undefined : parts.join('\n')
}

/**
 * The full, untruncated account of one log event.
 *
 * This is what a search matches against, so a phrase past the summary cap is
 * still findable; a matching entry is rendered as a snippet around the hit
 * rather than as the head of the body.
 *
 * @param event - one session log entry.
 * @returns the body text, never truncated.
 */
function fullEventText(event: SessionEvent): string {
	const data: unknown = event.data
	if (!isRecord(data)) return ''
	switch (event.type) {
		// A `user/message` event carries the message itself; every other
		// message-shaped event wraps it in `message` (`dsh-session`
		// `lib/types/types.d.ts:300-389`). Rendering the wrapper for a
		// `tool/result` used to yield an empty body, which made tool output
		// invisible to both a range read and a search.
		case 'user/message':
			return messageText(data) ?? ''
		case 'system/message':
		case 'tool/result':
		case 'assistant/message':
			return wrappedMessageText(data) ?? ''
		case 'developer/message':
			return `turn ${String(data['turn'])} step ${String(data['step'])} ${wrappedMessageText(data) ?? ''}`
		case 'tool/call':
			return `${String(data['name'])} ${JSON.stringify(data['arguments'] ?? null)}`
		default:
			return JSON.stringify(data)
	}
}

/**
 * Extract the text of an event whose payload wraps its message in `message`.
 *
 * @param data - the event payload.
 * @returns the concatenated text blocks, or `undefined` when there are none.
 */
function wrappedMessageText(data: Record<string, unknown>): string | undefined {
	const message = data['message']
	return isRecord(message) ? messageText(message) : undefined
}

/**
 * Build a compact, one-line-ish account of one log event for the model.
 *
 * The projection is lossy by design — {@link CONTEXT_HISTORY_TOOL} exists so the
 * model can pull any exact range it still needs, `raw: true` returns the original
 * JSON for a single call, and a search returns a snippet around the hit.
 *
 * @param event - one session log entry.
 * @param cfg - resolved configuration supplying the cap and marker.
 * @returns the summary string.
 */
function summarizeEvent(event: SessionEvent, cfg: Config): string {
	return truncateSummary(fullEventText(event), cfg)
}

/** One returned transcript entry with its stable sequence identity. */
export interface HistoryEntry {
	/** Stable session sequence number, usable as `from`/`to` on a later call. */
	readonly seq: number
	/** Session event type. */
	readonly type: string
	/** Compact account of the event. */
	readonly summary: string
}

/** Canonical value returned by {@link CONTEXT_HISTORY_TOOL}. */
export interface HistoryValue {
	/** Returned entries in ascending sequence order. */
	readonly entries: HistoryEntry[]
	/** Rendered transcript text. */
	readonly text: string
	/** Total events in the session log, before range filtering and limits. */
	readonly total: number
}

/** Which events a read or search may return. */
export type HistoryScope = 'all' | 'user' | 'assistant' | 'tool_call' | 'tool_result'

/** The values {@link HistoryScope} accepts, in the order the tool advertises them. */
const HISTORY_SCOPES = ['all', 'user', 'assistant', 'tool_call', 'tool_result'] as const satisfies readonly HistoryScope[]

/** Longest accepted search pattern, in characters. */
const MAX_QUERY_CHARS = 200

/** Characters of context kept on each side of a snippet hit. */
const SNIPPET_CONTEXT_CHARS = 60

/** Hits rendered inside one entry's snippet before it stops widening. */
const SNIPPET_MAX_WINDOWS = 3

/**
 * The scope one event belongs to.
 *
 * The plugin's own notebook and reminder messages are user-shaped but are not
 * user input: they are excluded from `user` so "what did the user say" cannot
 * match the model's own notes, and stay reachable through `all`.
 *
 * @param event - one session log entry.
 * @returns its scope, or `other` for events no scope names.
 */
function scopeOfEvent(event: SessionEvent): Exclude<HistoryScope, 'all'> | 'other' {
	switch (event.type) {
		case 'tool/call':
			return 'tool_call'
		case 'tool/result':
			return 'tool_result'
		case 'assistant/message':
			return 'assistant'
		case 'user/message': {
			const data: unknown = event.data
			const source = isRecord(data) && isRecord(data['source']) ? data['source'] : undefined
			const kind = source === undefined ? undefined : source['kind']
			if (kind === NOTEBOOK_SOURCE_KIND || kind === REMINDER_SOURCE_KIND) return 'other'
			return 'user'
		}
		default:
			return 'other'
	}
}

/** The body text a read renders and a search matches. */
function bodyOf(event: SessionEvent, raw: boolean): string {
	if (!raw) return fullEventText(event)
	const data: unknown = event.data
	const json = JSON.stringify(data)
	return json === undefined ? '' : json
}

/**
 * Build the matcher for one search.
 *
 * A literal query is escaped, so `a.b` means those four characters; `regex: true`
 * compiles it as written, and an invalid pattern fails the call with the engine's
 * own message instead of silently matching nothing.
 *
 * @param query - the pattern as the model wrote it.
 * @param regex - whether the pattern is a regular expression.
 * @param caseSensitive - whether matching is case-sensitive.
 * @returns a global regex usable with `matchAll` and `search`.
 * @throws when the pattern is too long or does not compile.
 */
function buildMatcher(query: string, regex: boolean, caseSensitive: boolean): RegExp {
	if (query.length > MAX_QUERY_CHARS) {
		throw new Error(`${CONTEXT_HISTORY_TOOL}: query must be at most ${String(MAX_QUERY_CHARS)} characters`)
	}
	const source = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	try {
		return new RegExp(source, caseSensitive ? 'g' : 'gi')
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error)
		throw new Error(`${CONTEXT_HISTORY_TOOL}: ${regex ? 'invalid regular expression' : 'invalid query'}: ${reason}`)
	}
}

/**
 * Render the windows around the first few hits in one body.
 *
 * A match past the summary cap would otherwise be invisible: the model would see
 * an entry reported as a hit and a summary that does not contain the phrase. The
 * windows carry the hit itself, bounded by {@link SNIPPET_MAX_WINDOWS} so one
 * chatty entry cannot consume the whole byte budget.
 *
 * @param text - the body the matcher was tested against.
 * @param matcher - a global regex, as {@link buildMatcher} returns.
 * @returns the snippet, or `undefined` when nothing matched.
 */
function snippetFor(text: string, matcher: RegExp): string | undefined {
	const parts: string[] = []
	for (const match of text.matchAll(matcher)) {
		const index = match.index ?? 0
		const start = Math.max(0, index - SNIPPET_CONTEXT_CHARS)
		const end = Math.min(text.length, index + match[0].length + SNIPPET_CONTEXT_CHARS)
		parts.push(`${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`)
		if (parts.length >= SNIPPET_MAX_WINDOWS) break
	}
	return parts.length === 0 ? undefined : parts.join(' … ')
}

/** One read or search request against the session log. */
export interface HistoryReadOptions {
	/** Inclusive lower bound; defaults to the start of the log. */
	readonly from?: number
	/** Inclusive upper bound; defaults to the newest event. */
	readonly to?: number
	/** Emit raw event JSON instead of compact summaries. */
	readonly raw?: boolean
	/** Pattern to search for; omitted means "read the range" instead. */
	readonly query?: string
	/** Treat {@link query} as a regular expression rather than literal text. */
	readonly regex?: boolean
	/** Match case-sensitively. Defaults to false. */
	readonly caseSensitive?: boolean
	/** Restrict which events may be returned. Defaults to `all`. */
	readonly scope?: HistoryScope
}

/** Internal transcript projection, before it is split into entries. */
interface HistoryTranscript {
	/** One rendered line per returned event, in ascending sequence order. */
	readonly lines: readonly string[]
	/** The joined transcript text, with header. */
	readonly text: string
	/** Total events in the session log, before range filtering and limits. */
	readonly total: number
}

/**
 * Assemble the rendered transcript, optionally filtered to search hits.
 *
 * Selection keeps the NEWEST events: with no explicit range a bounded sliding
 * window over the newest `historyDefaultLimit` events is taken, and with an
 * explicit range the newest `maxHistoryEntries` within that range are taken.
 * Either way the oldest events are the ones dropped, so a limit never hides
 * recent work. The same ceiling applies to search results, oldest dropped first.
 *
 * Rendering then walks NEWEST to OLDEST, so the UTF-8 byte budget
 * (`maxHistoryBytes`) also cuts the tail last. An entry that would exceed the
 * budget is dropped whole rather than split, so every returned `seq` is a range
 * the model can re-read exactly. Lines are finally reversed into ascending
 * sequence order for readability.
 *
 * @param session - the live session to read.
 * @param options - range, projection, search pattern, and scope.
 * @param cfg - resolved configuration supplying every limit.
 * @param signal - caller-owned cancellation.
 * @returns the rendered transcript.
 */
export function readHistory(
	session: Session,
	options: HistoryReadOptions,
	cfg: Config,
	signal: AbortSignal,
): HistoryTranscript {
	const events = session.snapshotEvents()
	const total = events.length
	const lower = options.from ?? 0
	const upper = options.to ?? (total - 1)
	const raw = options.raw === true
	const scope = options.scope ?? 'all'
	const query = options.query
	const matcher =
		query === undefined ? undefined : buildMatcher(query, options.regex === true, options.caseSensitive === true)
	// With an explicit range the caller asked for exactly that window, so the
	// ceiling is the hard cap only. With no range the caller wants "recent
	// history", so a bounded sliding window over the newest events applies —
	// this is what `historyDefaultLimit` configures.
	const callerBounded = options.from !== undefined || options.to !== undefined
	const ceiling = callerBounded
		? cfg.maxHistoryEntries.get()
		: Math.min(cfg.historyDefaultLimit.get(), cfg.maxHistoryEntries.get())
	const byteBudget = cfg.maxHistoryBytes.get()
	const selected: SessionEvent[] = []
	for (const event of events) {
		const seq = Number(event.seq)
		if (seq < lower || seq > upper) continue
		if (scope !== 'all' && scopeOfEvent(event) !== scope) continue
		// `search` ignores `lastIndex`, unlike `test` on a global regex.
		if (matcher !== undefined && bodyOf(event, raw).search(matcher) < 0) continue
		if (selected.length >= ceiling) selected.shift()
		selected.push(event)
	}
	const reversed: string[] = []
	const reversedSeqs: number[] = []
	let bytes = 0
	for (let index = selected.length - 1; index >= 0; index -= 1) {
		if (signal.aborted) throw new Error(`${CONTEXT_HISTORY_TOOL} was cancelled`)
		const event = selected[index]
		if (event === undefined) continue
		const seq = Number(event.seq)
		const boundary = isBoundaryEvent(event) ? ` ${cfg.historyBoundaryMarker.get()}` : ''
		const body = bodyOf(event, raw)
		const rendered =
			matcher === undefined ? truncateSummary(body, cfg) : (snippetFor(body, matcher) ?? truncateSummary(body, cfg))
		const line = `#${seq} ${event.type}${boundary}\n${rendered}`
		const lineBytes = notebookBytes(line)
		if (reversedSeqs.length > 0 && bytes + lineBytes > byteBudget) break
		reversed.push(line)
		reversedSeqs.push(seq)
		bytes += lineBytes
	}
	if (reversedSeqs.length === 0) return { lines: [], text: '', total }
	const newestSeq = reversedSeqs[0] as number
	const oldestSeq = reversedSeqs[reversedSeqs.length - 1] as number
	const span = `entries #${String(oldestSeq)}-#${String(newestSeq)} of ${String(total)} events`
	const header =
		query === undefined
			? `session ${String(session.id)} · ${span}\n\n`
			: `session ${String(session.id)} · ${String(reversedSeqs.length)} matches for "${query.length > 60 ? `${query.slice(0, 60)}…` : query}"${scope === 'all' ? '' : ` in ${scope}`} · ${span}\n\n`
	return { lines: reversed.reverse(), text: header + reversed.join('\n\n'), total }
}

/**
 * Register both tools when the feature is enabled.
 *
 * Call this from `apply`. When `cfg.enabled.get()` is false NEITHER tool is registered,
 * so a disabled plugin leaves the model's tool catalog untouched.
 *
 * @param ctx - plugin context; registration goes through `ctx.tools`.
 * @param cfg - resolved configuration.
 * @returns true when the tools were registered, false when disabled.
 */
export function registerTools(ctx: Context, cfg: Config): boolean {
	if (!cfg.enabled.get()) return false

	ctx.tools.register(
		defineTool({
			name: CONTEXT_NOTES_TOOL,
			description:
				'Read or replace your persistent notebook. The notebook is a durable, model-written record that survives context rollovers; it is replayed to you at the start of later context windows. Call with no `text` to read the current notebook, with `text` to replace it wholesale, or with an empty `text` to clear it. Keep it short and high-signal: it is a working state record, not a transcript.',
			parameters: {
				text: {
					type: 'string',
					description:
						'Complete replacement notebook text. Omit to read the notebook. Pass an empty string to clear it.',
				},
			},
			output: {
				schema: {
					type: 'object',
					additionalProperties: false,
					properties: {
						present: { type: 'boolean', required: true },
						visible: { type: 'boolean', required: true },
						materialized: { type: 'boolean', required: true },
						revisionTrusted: { type: 'boolean', required: true },
						text: { type: 'string', required: true },
						bytes: { type: 'integer', required: true },
						maxBytes: { type: 'integer', required: true },
						revision: { type: 'integer' },
					},
				},
				/**
				 * Renders the notebook text WITHOUT the untrusted-record wrapper.
				 *
				 * That is deliberate and safe: this is a tool RESULT, which the model
				 * reads as the answer to its own call, not as an instruction. The
				 * wrapper's job is to frame the copy that arrives later as an apparent
				 * user turn, and that copy — the deferred `user/message` — carries it
				 * (see `writeNotebook`). Keeping this render unwrapped is also what lets
				 * a read → edit → write cycle be idempotent, because the model gets back
				 * exactly the text it stored.
				 */
				render: (_args, value) => {
					const remaining = Math.max(0, value.maxBytes - value.bytes)
					if (!value.present) {
						return [
							{
								type: 'text',
								text: `No notebook exists yet. Call ${CONTEXT_NOTES_TOOL} with text to create one (limit ${value.maxBytes} bytes).`,
							},
						]
					}
					return [
						{
							type: 'text',
							text: [
								`Notebook revision ${String(value.revision ?? 0)} — ${String(value.bytes)}/${String(value.maxBytes)} bytes (${String(remaining)} remaining).`,
								value.visible
									? 'This revision is currently in your context.'
									: value.materialized
										? 'NOTE: this revision was dropped from your visible context by a rollover; the text below is read from the log and is authoritative.'
										: 'This revision was accepted and is queued for delivery to you at the next step boundary (it is not in your context yet).',
								'',
								value.text,
							].join('\n'),
						},
					]
				},
			},
			/**
			 * Reads may overlap; a write must not. Revision allocation is a
			 * read-then-write (`(latestNotebook(session)?.revision ?? 0) + 1` in
			 * `writeNotebook`), so two parallel writes would allocate the SAME
			 * revision number and break the `context_notes` read, which is revision-keyed. Only a call
			 * with no `text` — a pure read — is parallel-safe.
			 */
			isConcurrencySafe: (args) => args.text === undefined,
			async execute(args, exec) {
				const session = requireSession(exec.agent)
				// Read live, not at registration: registration is a mount-time effect,
				// but the switch itself is a volatile field, so a settings write that
				// flips it must take effect on the NEXT call rather than at the next
				// app start. The tools stay in the model's catalog until unmount, so
				// this guard — not the registration gate — is what a live `false`
				// actually enforces.
				if (!cfg.enabled.get()) throw new Error(`${CONTEXT_NOTES_TOOL} is disabled by configuration`)
				// One read per call: the byte bound actually enforced and the bound
				// reported back to the model must be the same number, even if a live
				// settings write lands mid-call.
				const maxNotebookBytes = cfg.maxNotebookBytes.get()
				if (exec.signal.aborted) throw new Error(`${CONTEXT_NOTES_TOOL} was cancelled`)
				if (args.text !== undefined) {
					// Validated, revision-allocated, and recorded — but deliberately NOT
					// appended. Appending here would place this user/message on the
					// surface BEFORE the tool result of this very call, and a provider
					// rejects an assistant tool call that is not immediately followed by
					// its result. `deferContext` rides the result instead and is drained
					// only after that result is committed.
					let written
					try {
						written = writeNotebook(session, args.text, { maxNotebookBytes })
					} catch (error) {
						// The rejected text is already in the log as this call's `tool/call`
						// argument, so tell the store not to resurrect it on recovery.
						if (error instanceof NotebookTooLargeError) markNotebookWriteRejected(session, args.text)
						throw error
					}
					exec.deferContext(written.message)
					return {
						present: written.text.length > 0,
						visible: false,
						materialized: false,
						revisionTrusted: true,
						text: written.text,
						bytes: written.bytes,
						maxBytes: maxNotebookBytes,
						revision: written.revision,
					}
				}
				const revision = latestNotebook(session)
				if (revision === undefined) {
					return {
						present: false,
						visible: false,
						materialized: false,
						revisionTrusted: true,
						text: '',
						bytes: 0,
						maxBytes: maxNotebookBytes,
					}
				}
				const present = revision.text.length > 0
				return {
					present,
					visible: present && revision.visible,
					materialized: revision.materialized,
					revisionTrusted: revision.revisionTrusted,
					text: revision.text,
					bytes: revision.bytes,
					maxBytes: maxNotebookBytes,
					revision: revision.revision,
				}
			},
		}),
	)

	ctx.tools.register(
		defineTool({
			name: CONTEXT_HISTORY_TOOL,
			description:
				'Read or search this session\'s raw transcript in the event log. Returns stable `seq` ids, marks rollover/compaction boundaries, and can narrow to one kind of event with `scope`. With `query` it returns the newest matches as snippets around the hit, so use that first when you are looking for a specific phrase, error text, path, or value; use `from`/`to` when you know where in the log to look. Use this whenever a summary, notebook entry, or your own recollection is not enough and you need what was actually said.',
			parameters: {
				from: { type: 'integer', description: 'Inclusive starting seq. Defaults to the start of the log.' },
				to: { type: 'integer', description: 'Inclusive ending seq. Defaults to the newest event.' },
				raw: { type: 'boolean', description: 'Return raw event JSON instead of compact summaries.' },
				query: {
					type: 'string',
					description:
						'Text to search for. Returns the newest matching events as snippets around the hit. Omit to read the range instead. Combine with `from`/`to` to search inside one span.',
				},
				regex: {
					type: 'boolean',
					description: 'Treat `query` as a JavaScript regular expression instead of literal text. Default false.',
				},
				caseSensitive: {
					type: 'boolean',
					description: 'Match case-sensitively. Default false.',
				},
				scope: {
					type: 'string',
					enum: [...HISTORY_SCOPES],
					description:
						'Restrict results to one kind of event: `user` (what the user said), `assistant` (what you said), `tool_call` (tool invocations and their arguments), `tool_result` (tool output), or `all`. Default `all`. Your own notebook and reminder messages are not `user` events viewable here — read them with context_notes.',
				},
			},
			output: {
				schema: {
					type: 'object',
					additionalProperties: false,
					properties: {
						entries: {
							type: 'array',
							required: true,
							items: {
								type: 'object',
								additionalProperties: false,
								properties: {
									seq: { type: 'integer', required: true },
									type: { type: 'string', required: true },
									summary: { type: 'string', required: true },
								},
							},
						},
						text: { type: 'string', required: true },
						total: { type: 'integer', required: true },
					},
				},
				render: (_args, value) => [{ type: 'text', text: value.text }],
			},
			isConcurrencySafe: () => true,
			async execute(args, run) {
				const session = requireSession(run.agent)
				if (!cfg.enabled.get()) throw new Error(`${CONTEXT_HISTORY_TOOL} is disabled by configuration`)
				if (args.from !== undefined && args.to !== undefined && args.from > args.to) {
					throw new Error(`context_history: from (${String(args.from)}) must not exceed to (${String(args.to)})`)
				}
				const transcript = readHistory(
					session,
					{
						...(args.from === undefined ? {} : { from: args.from }),
						...(args.to === undefined ? {} : { to: args.to }),
						...(args.raw === undefined ? {} : { raw: args.raw }),
						...(args.query === undefined ? {} : { query: args.query }),
						...(args.regex === undefined ? {} : { regex: args.regex }),
						...(args.caseSensitive === undefined ? {} : { caseSensitive: args.caseSensitive }),
						...(args.scope === undefined ? {} : { scope: args.scope }),
					},
					cfg,
					run.signal,
				)
				const entries: HistoryEntry[] = []
				for (const line of transcript.lines) {
					const newline = line.indexOf('\n')
					const head = newline === -1 ? line : line.slice(0, newline)
					const body = newline === -1 ? '' : line.slice(newline + 1)
					if (!head.startsWith('#')) continue
					const [seqText, typeText] = head.slice(1).split(' ', 2)
					if (seqText === undefined || typeText === undefined) continue
					entries.push({ seq: Number(seqText), type: typeText, summary: body })
				}
				return { entries, text: transcript.text, total: transcript.total }
			},
		}),
	)

	return true
}

export { NotebookTooLargeError, NOTEBOOK_SOURCE_KIND }
