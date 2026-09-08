import { describe, expect, it } from "vitest";
import { findAssistantEntryId } from "../examples/extensions/inline-comments-utils.ts";
import type { ExtensionContext } from "../src/core/extensions/index.ts";

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
	it("matches an older assistant entry after fullscreen line wrapping", () => {
		const ctx = contextWithAssistants([
			{ id: "selected-entry", text: "This assistant response wraps between two words." },
			{ id: "newer-entry", text: "A later response that should not be selected." },
		]);

		expect(findAssistantEntryId(ctx, "This assistant response wraps\nbetween two words.")).toBe("selected-entry");
	});

	it("falls back to the latest completed assistant when rendering changes the source text", () => {
		const ctx = contextWithAssistants([{ id: "assistant-entry", text: "The **important** result." }]);

		expect(findAssistantEntryId(ctx, "The important result.")).toBe("assistant-entry");
	});
});
