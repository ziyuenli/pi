import { describe, expect, it } from "vitest";
import {
	createTranscriptAnnotations,
	findAssistantEntryId,
	INLINE_COMMENT_STATE_TYPE,
	restoreInlineCommentState,
} from "../examples/extensions/inline-comments-utils.ts";
import type { ExtensionContext, TranscriptSelection } from "../src/core/extensions/index.ts";

function contextWithAssistants(messages: Array<{ id: string; text: string }>): ExtensionContext {
	return {
		sessionManager: {
			getBranch: () =>
				messages.map(({ id, text }) => ({
					type: "message",
					id,
					message: {
						role: "assistant",
						stopReason: "stop",
						content: [{ type: "text", text }],
					},
				})),
		},
	} as unknown as ExtensionContext;
}

describe("inline comments", () => {
	it("creates a numbered annotation that keeps the selected range and opens its comment", () => {
		const selection: TranscriptSelection = {
			text: "beta",
			document: { start: { row: 1, column: 0 }, end: { row: 1, column: 4 } },
			viewport: { start: { row: 1, column: 0 }, end: { row: 1, column: 4 } },
		};
		const opened: number[] = [];
		const annotations = createTranscriptAnnotations(
			[{ entryId: "assistant-entry", quote: "beta", comment: "test", selection }],
			(index) => opened.push(index),
		);

		expect(annotations).toHaveLength(1);
		expect(annotations[0]).toMatchObject({
			id: "inline-comment-1",
			marker: "🫧1",
			selection,
			open: false,
		});
		annotations[0]?.onOpen(selection);
		expect(opened).toEqual([0]);
	});

	it("matches an older assistant entry after fullscreen line wrapping", () => {
		const ctx = contextWithAssistants([
			{ id: "selected-entry", text: "This assistant response wraps between two words." },
			{ id: "newer-entry", text: "A later response that should not be selected." },
		]);

		expect(findAssistantEntryId(ctx, "This assistant response wraps\nbetween two words.")).toBe("selected-entry");
	});

	it("matches rendered Markdown without guessing an unrelated assistant entry", () => {
		const ctx = contextWithAssistants([
			{ id: "assistant-entry", text: "The **important** result." },
			{ id: "newer-entry", text: "A different response." },
		]);

		expect(findAssistantEntryId(ctx, "The important result.")).toBe("assistant-entry");
		expect(findAssistantEntryId(ctx, "not present anywhere")).toBeUndefined();
	});

	it("uses the rendered source ID for every visible line, even when Markdown changes its text", () => {
		const ctx = contextWithAssistants([
			{ id: "older-entry", text: "Older response." },
			{ id: "selected-entry", text: "**Source text** that renders differently." },
		]);

		for (const renderedLine of ["Source text", "rendered table cell", "a line with a visual border"]) {
			expect(findAssistantEntryId(ctx, renderedLine, "selected-entry")).toBe("selected-entry");
		}
		expect(findAssistantEntryId(ctx, "Source text", "missing-entry")).toBeUndefined();
	});

	it("matches ordinary text mixed with rendered inline-code text", () => {
		const ctx = contextWithAssistants([
			{
				id: "selected-entry",
				text: [
					"已完成并推送：",
					"",
					"- TUI 按渲染组件边界识别 assistant response，提供 `sourceId`。",
					"- `npm run check`：通过",
					"- Pi：`a3a915f7e`",
					"- Extensions：`3ea5132`",
				].join("\n"),
			},
		]);

		const renderedSelection = [
			"已完成并推送：",
			"- TUI 按渲染组件边界识别 assistant response，提供 sourceId。",
			"- npm run check：通过",
			"- Pi：a3a915f7e",
			"- Extensions：3ea5132",
		].join("\n");

		expect(findAssistantEntryId(ctx, renderedSelection)).toBe("selected-entry");
	});

	it("restores only the latest valid state entry from the active session branch", () => {
		const ctx = {
			sessionManager: {
				getBranch: () => [
					{
						type: "custom",
						customType: INLINE_COMMENT_STATE_TYPE,
						data: { version: 1, comments: [{ entryId: "a", quote: "beta", comment: "Keep it." }] },
					},
					{
						type: "custom",
						customType: INLINE_COMMENT_STATE_TYPE,
						data: { version: 1, comments: [{ entryId: "b", quote: "gamma", comment: "Change it." }] },
					},
				],
			},
		} as unknown as ExtensionContext;

		expect(restoreInlineCommentState(ctx)).toEqual([{ entryId: "b", quote: "gamma", comment: "Change it." }]);
	});
});
