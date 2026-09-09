/**
 * Inline transcript comments.
 *
 * Fullscreen mode owns transcript selection, so this extension can open an
 * editor beside the selected range without polling the system clipboard.
 * Comments are staged and packaged with the next normal user prompt.
 *
 * Usage:
 *   /inline-comments         Toggle selection commenting
 *   /inline-comments:open    Open inline comment for last selected assistant text (optionally: /inline-comments:open "<selected text>")
 *   /inline-comments:send    Send staged inline comments without another request
 *   /inline-comments:clear   Discard staged comments
 *
 * After staging a comment, press Enter with an empty input to send the staged feedback.
 *
 * Shortcut:
 *   Alt+E (preferred) / Alt+Shift+E (fallback)
 *   Add a comment to the last selected assistant text
 */

import {
	type ExtensionAPI,
	type ExtensionContext,
	ExtensionEditorComponent,
	type TranscriptSelection,
} from "@earendil-works/pi-coding-agent";
import { HStack, Key, MouseRegion, Text, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import {
	createTranscriptAnnotations,
	findAssistantEntryId,
	INLINE_COMMENT_STATE_TYPE,
	type InlineCommentTranscriptAnnotation,
	restoreInlineCommentState,
} from "./inline-comments-utils.ts";

interface StagedComment {
	entryId: string;
	quote: string;
	comment: string;
	selection?: TranscriptSelection;
}

interface PendingSelectionComment {
	entryId: string;
	quote: string;
	selection: TranscriptSelection;
}

/** Selection APIs were added after older Pi releases; keep manual comments working there. */
interface TranscriptSelectionUI {
	onTranscriptSelection?: (listener: (selection: TranscriptSelection) => void) => () => void;
	getTranscriptSelection?: () => TranscriptSelection | undefined;
	setTranscriptAnnotations?: (
		key: string,
		annotations: readonly InlineCommentTranscriptAnnotation[] | undefined,
	) => void;
}

function getSelectionUI(ctx: ExtensionContext): TranscriptSelectionUI {
	// SAFETY: Pi's UI object is structurally compatible when these optional APIs exist.
	return ctx.ui as unknown as TranscriptSelectionUI;
}

interface PersistedInlineCommentState {
	version: 1;
	comments: readonly StagedComment[];
}

function packageComments(request: string, comments: readonly StagedComment[]): string {
	const sections = comments.map(
		(comment, index) =>
			`Comment ${index + 1} on assistant entry ${comment.entryId}:\n` +
			`> ${comment.quote.replaceAll("\n", "\n> ")}\n\n${comment.comment}`,
	);
	const trimmedRequest = request.trim();
	const requestSection = trimmedRequest ? `Request:\n${request}\n\n` : "";
	return `${requestSection}Inline feedback:\n\n${sections.join("\n\n---\n\n")}`;
}

export default function inlineComments(pi: ExtensionAPI) {
	let enabled = false;
	let dialogOpen = false;
	let comments: StagedComment[] = [];
	let pendingSelection: PendingSelectionComment | undefined;
	let lastSelection: TranscriptSelection | undefined;
	let unsubscribeSelection: (() => void) | undefined;
	let supportsTranscriptSelection = false;
	let openCommentIndex: number | undefined;

	function persistComments(): void {
		pi.appendEntry<PersistedInlineCommentState>(INLINE_COMMENT_STATE_TYPE, {
			version: 1,
			comments,
		});
	}

	async function editComment(
		index: number,
		ctx: ExtensionContext,
		selectionOverride?: TranscriptSelection,
	): Promise<void> {
		const existing = comments[index];
		if (!existing || dialogOpen || !ctx.isIdle()) return;
		openCommentIndex = index;
		refresh(ctx);
		dialogOpen = true;
		const selectionForOverlay = selectionOverride ?? existing.selection;
		try {
			const result = await ctx.ui.custom<string | undefined>(
				(tui, _theme, keybindings, done) =>
					new ExtensionEditorComponent(
						tui,
						keybindings,
						`Selected text:\n${existing.quote}\n\nEdit comment ${index + 1}:`,
						existing.comment,
						(value) => done(value),
						() => done(undefined),
					),
				{
					overlay: true,
					...(selectionForOverlay
						? {
								overlayOptions: {
									row: selectionForOverlay.viewport.end.row + 1,
									col: selectionForOverlay.viewport.start.column,
									width: "60%",
									maxHeight: "50%",
								},
							}
						: { overlayOptions: { width: "70%", maxHeight: "70%", anchor: "center" } }),
				},
			);
			const updated = result?.trim();
			if (updated && comments[index]) {
				comments[index] = { ...existing, comment: updated };
				persistComments();
			}
		} finally {
			dialogOpen = false;
			openCommentIndex = undefined;
			refresh(ctx);
		}
	}

	function refresh(ctx: ExtensionContext): void {
		ctx.ui.setStatus("inline-comments", enabled ? `inline comments: ${comments.length} staged` : undefined);
		getSelectionUI(ctx).setTranscriptAnnotations?.(
			"inline-comments",
			createTranscriptAnnotations(
				comments,
				(index, selection) => void editComment(index, ctx, selection),
				openCommentIndex,
			),
		);
		ctx.ui.setWidget(
			"inline-comments",
			comments.length === 0
				? undefined
				: (_tui, theme) =>
						new HStack(
							comments.map((_comment, index) => {
								const label = `🫧${index + 1}`;
								const width = visibleWidth(label);
								return {
									component: new MouseRegion(
										new Text(theme.bold(theme.fg("accent", label)), 0, 0),
										(event: TuiMouseEvent) => {
											if (event.button !== "left") return undefined;
											if (event.type === "press") return { handled: true, render: false };
											if (event.type !== "click") return undefined;
											void editComment(index, ctx);
											return { handled: true };
										},
									),
									basis: width,
									minSize: width,
									maxSize: width,
									grow: 0,
									shrink: 0,
								};
							}),
							{ gap: 1, align: "start" },
						),
		);
	}

	async function openCommentEditor(
		selection: TranscriptSelection | undefined,
		entryId: string,
		quote: string,
		ctx: ExtensionContext,
	): Promise<boolean> {
		if (dialogOpen || !ctx.isIdle()) return false;
		dialogOpen = true;
		try {
			const result = await ctx.ui.custom<string | undefined>(
				(tui, _theme, keybindings, done) =>
					new ExtensionEditorComponent(
						tui,
						keybindings,
						`Comment on: ${quote.replaceAll("\n", " ").slice(0, 80)}`,
						undefined,
						(value) => done(value),
						() => done(undefined),
					),
				{
					overlay: true,
					...(selection
						? {
								overlayOptions: {
									row: selection.viewport.end.row + 1,
									col: selection.viewport.start.column,
									width: "60%",
									maxHeight: "50%",
								},
							}
						: {}),
				},
			);
			const comment = result?.trim();
			if (!comment) return false;
			comments.push({ entryId, quote, comment, selection });
			persistComments();
			refresh(ctx);
			return true;
		} finally {
			dialogOpen = false;
		}
	}

	function stageSelection(selection: TranscriptSelection, ctx: ExtensionContext, notifyOnFailure = false): boolean {
		const quote = selection.text.trim();
		if (!quote) {
			pendingSelection = undefined;
			return false;
		}
		const entryId = findAssistantEntryId(ctx, quote, selection.sourceId);
		if (!entryId) {
			pendingSelection = undefined;
			if (notifyOnFailure) {
				ctx.ui.notify("Selection is not within any assistant message.", "warning");
			}
			return false;
		}
		pendingSelection = { selection, entryId, quote };
		return true;
	}

	async function openPendingComment(
		ctx: ExtensionContext,
		selectionText?: string,
		requireEnabled = true,
	): Promise<void> {
		if (requireEnabled && !enabled) {
			ctx.ui.notify("Enable /inline-comments to use the shortcut key flow.", "info");
			return;
		}
		if (!pendingSelection && !selectionText) {
			ctx.ui.notify(
				"No selected assistant text to comment. Select text in agent output first, or pass /inline-comments:open <text>.",
				"warning",
			);
			return;
		}

		if (!ctx.isIdle()) {
			ctx.ui.notify("Wait until the assistant is idle before opening the comment editor.", "warning");
			return;
		}

		if (!pendingSelection && selectionText) {
			const quote = selectionText.trim();
			if (!quote) {
				ctx.ui.notify("No selected assistant text to comment. Enter text after the command.", "warning");
				return;
			}
			const entryId = findAssistantEntryId(ctx, quote);
			if (!entryId) {
				ctx.ui.notify("Unable to attach comment to an assistant message. Try after a response appears.", "warning");
				return;
			}
			await openCommentEditor(undefined, entryId, quote, ctx);
			refresh(ctx);
			return;
		}

		if (!pendingSelection) return;
		const { selection, entryId, quote } = pendingSelection;
		const staged = await openCommentEditor(selection, entryId, quote, ctx);
		// A cancel keeps the staged selection so the next Alt+E re-opens the same
		// editor instead of reporting a missing selection; a new selection replaces it.
		if (staged) pendingSelection = undefined;
		refresh(ctx);
	}

	function sendComments(ctx: ExtensionContext): void {
		if (comments.length === 0) {
			ctx.ui.notify("No inline comments are staged.", "info");
			return;
		}
		const message = packageComments("", comments);
		comments = [];
		openCommentIndex = undefined;
		persistComments();
		refresh(ctx);
		if (ctx.isIdle()) pi.sendUserMessage(message);
		else pi.sendUserMessage(message, { deliverAs: "followUp" });
	}

	pi.on("session_start", (_event, ctx) => {
		unsubscribeSelection?.();
		pendingSelection = undefined;
		lastSelection = undefined;
		openCommentIndex = undefined;
		comments = restoreInlineCommentState(ctx);
		const selectionUI = getSelectionUI(ctx);
		supportsTranscriptSelection = typeof selectionUI.getTranscriptSelection === "function";
		unsubscribeSelection =
			typeof selectionUI.onTranscriptSelection === "function"
				? selectionUI.onTranscriptSelection((selection) => {
						lastSelection = selection;
						if (enabled) stageSelection(selection, ctx);
					})
				: undefined;
		refresh(ctx);
	});

	pi.on("session_shutdown", () => {
		unsubscribeSelection?.();
		unsubscribeSelection = undefined;
		pendingSelection = undefined;
		lastSelection = undefined;
		openCommentIndex = undefined;
		dialogOpen = false;
	});

	pi.on("input", (event, ctx) => {
		if (event.source !== "extension") lastSelection = undefined;
		if (event.source === "extension" || comments.length === 0) return;
		const pending = comments;
		comments = [];
		openCommentIndex = undefined;
		persistComments();
		refresh(ctx);
		return {
			action: "transform",
			text: packageComments(event.text, pending),
			images: event.images,
		};
	});

	pi.registerCommand("inline-comments", {
		description: "Toggle inline commenting for fullscreen transcript selections",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (!enabled) {
				pendingSelection = undefined;
				openCommentIndex = undefined;
			} else {
				const selection = getSelectionUI(ctx).getTranscriptSelection?.() ?? lastSelection;
				if (selection) stageSelection(selection, ctx, true);
			}
			refresh(ctx);
			ctx.ui.notify(`Inline commenting ${enabled ? "enabled" : "disabled"}.`, "info");
		},
	});

	pi.registerCommand("inline-comments:send", {
		description: "Send staged inline comments without another request",
		handler: async (_args, ctx) => sendComments(ctx),
	});

	const openPendingShortcut = async (ctx: ExtensionContext) => {
		const activeSelection = getSelectionUI(ctx).getTranscriptSelection?.();
		if (pendingSelection || activeSelection || lastSelection) {
			if (!enabled) {
				ctx.ui.notify("Enable /inline-comments to use the shortcut key flow.", "info");
				return;
			}
			// Prefer the already staged selection; otherwise recover from the live
			// highlight or the last completed selection (a click after a dialog can
			// clear the TUI's active selection without producing a new one).
			if (!pendingSelection) {
				const selection = activeSelection ?? lastSelection;
				if (selection && !stageSelection(selection, ctx, true)) return;
			}
		} else if (!supportsTranscriptSelection) {
			ctx.ui.notify(
				"This Pi version cannot read transcript selections. Use /inline-comments:open <quoted text>.",
				"warning",
			);
			return;
		}
		await openPendingComment(ctx, undefined, true);
	};

	pi.registerShortcut(Key.alt("e"), {
		description: "Open inline comment for selected assistant text",
		handler: (ctx) => openPendingShortcut(ctx),
	});

	pi.registerShortcut(Key.altShift("e"), {
		description: "Open inline comment for selected assistant text",
		handler: (ctx) => openPendingShortcut(ctx),
	});

	pi.registerCommand("inline-comments:open", {
		description: "Open inline comment editor for the last selected assistant text or provided text",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const selection = getSelectionUI(ctx).getTranscriptSelection?.();
			if (selection && enabled) stageSelection(selection, ctx);
			await openPendingComment(ctx, trimmed ? trimmed : undefined, false);
		},
	});

	pi.registerCommand("inline-comments:edit", {
		description: "Review or edit a staged inline comment by number",
		handler: async (args, ctx) => {
			const number = Number.parseInt(args.trim(), 10);
			if (!Number.isInteger(number) || number < 1 || number > comments.length) {
				ctx.ui.notify(`Enter a comment number from 1 to ${comments.length || 0}.`, "warning");
				return;
			}
			await editComment(number - 1, ctx);
		},
	});

	pi.registerCommand("inline-comments:clear", {
		description: "Discard staged inline comments",
		handler: async (_args, ctx) => {
			comments = [];
			openCommentIndex = undefined;
			persistComments();
			refresh(ctx);
			ctx.ui.notify("Staged inline comments discarded.", "info");
		},
	});
}
