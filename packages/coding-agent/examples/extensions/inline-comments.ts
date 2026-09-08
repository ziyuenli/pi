/**
 * Inline transcript comments.
 *
 * Fullscreen mode owns transcript selection, so this extension can open an
 * editor beside the selected range without polling the system clipboard.
 * Comments are staged and packaged with the next normal user prompt.
 *
 * Usage:
 *   /inline-comments         Toggle selection commenting
 *   /inline-comments:send    Send staged comments without another request
 *   /inline-comments:clear   Discard staged comments
 */

import {
	type ExtensionAPI,
	type ExtensionContext,
	ExtensionEditorComponent,
	type TranscriptSelection,
} from "@earendil-works/pi-coding-agent";
import { findAssistantEntryId } from "./inline-comments-utils.ts";

interface StagedComment {
	entryId: string;
	quote: string;
	comment: string;
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
	let unsubscribeSelection: (() => void) | undefined;

	function refresh(ctx: ExtensionContext): void {
		ctx.ui.setStatus("inline-comments", enabled ? `inline comments: ${comments.length} staged` : undefined);
		ctx.ui.setWidget(
			"inline-comments",
			comments.length > 0
				? [
						`${comments.length} inline comment${comments.length === 1 ? "" : "s"} staged`,
						...comments.map((comment, index) => `${index + 1}. ${comment.comment.replaceAll("\n", " ")}`),
						"Submit your main prompt to send them together.",
					]
				: undefined,
		);
	}

	async function captureSelection(selection: TranscriptSelection, ctx: ExtensionContext): Promise<void> {
		if (!enabled || dialogOpen || !ctx.isIdle()) return;
		const quote = selection.text.trim();
		if (!quote) return;
		const entryId = findAssistantEntryId(ctx, quote);
		if (!entryId) {
			ctx.ui.notify("Selection is not contained in one completed assistant response.", "warning");
			return;
		}

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
					overlayOptions: {
						row: selection.viewport.end.row + 1,
						col: selection.viewport.start.column,
						width: "60%",
						maxHeight: "50%",
					},
				},
			);
			const comment = result?.trim();
			if (!comment) return;
			comments.push({ entryId, quote, comment });
			refresh(ctx);
		} finally {
			dialogOpen = false;
		}
	}

	function sendComments(ctx: ExtensionContext): void {
		if (comments.length === 0) {
			ctx.ui.notify("No inline comments are staged.", "info");
			return;
		}
		const message = packageComments("", comments);
		comments = [];
		refresh(ctx);
		if (ctx.isIdle()) pi.sendUserMessage(message);
		else pi.sendUserMessage(message, { deliverAs: "followUp" });
	}

	pi.on("session_start", (_event, ctx) => {
		unsubscribeSelection?.();
		unsubscribeSelection = ctx.ui.onTranscriptSelection((selection) => {
			void captureSelection(selection, ctx);
		});
		refresh(ctx);
	});

	pi.on("session_shutdown", () => {
		unsubscribeSelection?.();
		unsubscribeSelection = undefined;
		dialogOpen = false;
	});

	pi.on("input", (event, ctx) => {
		if (comments.length === 0) return;
		const pending = comments;
		comments = [];
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
			refresh(ctx);
			ctx.ui.notify(`Inline commenting ${enabled ? "enabled" : "disabled"}.`, "info");
		},
	});

	pi.registerCommand("inline-comments:send", {
		description: "Send staged inline comments without another request",
		handler: async (_args, ctx) => sendComments(ctx),
	});

	pi.registerCommand("inline-comments:clear", {
		description: "Discard staged inline comments",
		handler: async (_args, ctx) => {
			comments = [];
			refresh(ctx);
			ctx.ui.notify("Staged inline comments discarded.", "info");
		},
	});
}
