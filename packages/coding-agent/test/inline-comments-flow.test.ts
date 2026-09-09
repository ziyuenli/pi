import { describe, expect, it, vi } from "vitest";
import inlineComments from "../examples/extensions/inline-comments.ts";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	TranscriptSelection,
} from "../src/core/extensions/index.ts";

vi.mock("@earendil-works/pi-coding-agent", () => ({ ExtensionEditorComponent: class {} }));

const LONG_RESPONSE = [
	"## Overview",
	"",
	"This assistant response spans many lines. It opens with a summary paragraph that wraps across the terminal width.",
	"",
	"- First bullet point with detail",
	"- Second bullet point with detail",
	"",
	"```ts",
	"const middle = computeValue(input);",
	"```",
	"",
	"The middle part has more words and continues the explanation with another wrapping paragraph.",
	"",
	"**Bold conclusion.** The tail ends here.",
].join("\n");

function harness(
	options: { customResults?: Array<string | undefined>; activeSelection?: () => TranscriptSelection | undefined } = {},
) {
	const handlers = new Map<string, (e: never, ctx: ExtensionContext) => unknown>();
	const commands = new Map<string, { handler: (a: string, c: ExtensionCommandContext) => Promise<void> }>();
	let select: ((s: TranscriptSelection) => void) | undefined;
	const notify = vi.fn();
	const custom = vi.fn();
	for (const result of options.customResults ?? []) custom.mockResolvedValueOnce(result);
	const ctx = {
		sessionManager: {
			getBranch: () => [
				{ type: "message", id: "user-1", message: { role: "user", content: [{ type: "text", text: "question" }] } },
				{
					type: "message",
					id: "assistant-1",
					message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: LONG_RESPONSE }] },
				},
			],
		},
		isIdle: () => true,
		ui: {
			notify,
			custom,
			setStatus: vi.fn(),
			setWidget: vi.fn(),
			setTranscriptAnnotations: vi.fn(),
			getTranscriptSelection: options.activeSelection ?? (() => undefined),
			onTranscriptSelection: (cb: typeof select) => {
				select = cb;
				return () => {};
			},
		},
	} as unknown as ExtensionCommandContext;
	inlineComments({
		on: (n: string, h: (e: never, ctx: ExtensionContext) => unknown) => handlers.set(n, h),
		registerCommand: (n: string, c: { handler: (a: string, c: ExtensionCommandContext) => Promise<void> }) =>
			commands.set(n, c),
		registerShortcut: vi.fn(),
		appendEntry: vi.fn(),
		sendUserMessage: vi.fn(),
	} as unknown as ExtensionAPI);
	const emit = (n: string, e: Record<string, unknown> = {}) => handlers.get(n)?.(e as never, ctx);
	const command = async (n: string, a = "") => {
		const registered = commands.get(n);
		if (!registered) throw new Error(`Missing command: ${n}`);
		await registered.handler(a, ctx);
	};
	emit("session_start");
	const selectText = (text: string) => {
		select?.({
			text,
			document: { start: { row: 0, column: 0 }, end: { row: 0, column: text.length } },
			viewport: { start: { row: 0, column: 0 }, end: { row: 0, column: text.length } },
		});
	};
	return { emit, command, selectText, custom, notify, ctx };
}

describe("long-response continuous commenting", () => {
	it("front, middle and tail selections of one response each open the editor", async () => {
		const h = harness({ customResults: [undefined, undefined, undefined] });
		await h.command("inline-comments");
		for (const part of ["This assistant response spans", "The middle part has more words", "The tail ends here"]) {
			h.selectText(part);
			await h.command("inline-comments:open");
		}
		expect(h.custom).toHaveBeenCalledTimes(3);
		expect(h.notify).not.toHaveBeenCalledWith(expect.anything(), "warning");
	});

	it("after canceling an editor, selecting another part still opens", async () => {
		const h = harness({ customResults: [undefined, "keep", undefined] });
		await h.command("inline-comments");
		h.selectText("This assistant response spans");
		await h.command("inline-comments:open"); // canceled (undefined)
		expect(h.custom).toHaveBeenCalledTimes(1);
		h.selectText("The tail ends here");
		await h.command("inline-comments:open");
		expect(h.custom).toHaveBeenCalledTimes(2);
	});

	it("Alt+E style open without an active selection falls back to the last completed selection", async () => {
		// getTranscriptSelection stays undefined: selection highlight was cleared by a click.
		const h = harness({ customResults: [undefined, "saved"], activeSelection: () => undefined });
		await h.command("inline-comments");
		h.selectText("The middle part has more words"); // onSelection fired earlier
		await h.command("inline-comments:open");
		expect(h.custom).toHaveBeenCalledTimes(1);
	});

	it("a canceled editor can be reopened with the shortcut without a new selection", async () => {
		const h = harness({ customResults: [undefined, "saved"] });
		await h.command("inline-comments");
		h.selectText("The middle part has more words");
		await h.command("inline-comments:open"); // canceled
		expect(h.custom).toHaveBeenCalledTimes(1);
		// Active selection is gone (click cleared it); pending selection survives.
		await h.command("inline-comments:open");
		expect(h.custom).toHaveBeenCalledTimes(2);
	});

	it("a selection that matches no assistant entry reports the real reason instead of 'no selection'", async () => {
		const h = harness();
		await h.command("inline-comments");
		h.selectText("footer status text");
		await h.command("inline-comments:open");
		expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("assistant"), "warning");
	});

	it("disable, response, enable keeps commenting working", async () => {
		const h = harness({ customResults: ["note"] });
		await h.command("inline-comments"); // enable
		await h.command("inline-comments"); // disable
		h.selectText("The tail ends here"); // selection happens while disabled
		await h.command("inline-comments"); // enable again
		await h.command("inline-comments:open");
		expect(h.custom).toHaveBeenCalledTimes(1);
	});
});
