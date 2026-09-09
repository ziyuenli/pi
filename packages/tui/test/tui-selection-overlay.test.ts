import assert from "node:assert";
import { describe, it } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import type { TuiTextSelection } from "../src/tui-alt-screen.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const LINES = Array.from({ length: 30 }, (_, index) => `line-${index + 1}`).join("\n");

describe("transcript selection across overlay lifecycle", () => {
	it("keeps reporting selections after an overlay is shown and hidden", async () => {
		const terminal = new VirtualTerminal(30, 8);
		const selections: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copyOnSelect: false,
			onSelection: (selection: TuiTextSelection) => selections.push(selection.text),
		});
		const scrollView = new ScrollView(new Text(LINES, 0, 0), { primary: true });
		tui.setLayoutRoot(scrollView);
		tui.start();
		await terminal.waitForRender();

		// 1. Select the tail (visible rows are the last lines of the document).
		terminal.sendInput("\x1b[<0;1;2M");
		terminal.sendInput("\x1b[<32;8;3M");
		terminal.sendInput("\x1b[<0;8;3m");
		await terminal.waitForRender();
		assert.ok(selections.length > 0, "first selection must fire");
		const first = selections[selections.length - 1];
		assert.ok(first.includes("line-"), `unexpected text: ${first}`);

		// 2. Simulate the comment editor overlay: show, focus, then cancel (hide).
		const overlay = tui.showOverlay(new Text("editor", 0, 0), {
			row: 1,
			col: 1,
			width: 10,
			maxHeight: 1,
		});
		overlay.focus();
		await terminal.waitForRender();
		assert.strictEqual(tui.hasOverlay(), true);
		overlay.hide();
		await terminal.waitForRender();
		assert.strictEqual(tui.hasOverlay(), false);

		// 3. Select a different row range of the same transcript (no re-scroll needed;
		// the point is that the overlay lifecycle did not break selection handling).
		terminal.sendInput("\x1b[<0;1;5M");
		terminal.sendInput("\x1b[<32;8;6M");
		terminal.sendInput("\x1b[<0;8;6m");
		await terminal.waitForRender();

		assert.ok(selections.length > 1, `second selection must fire; got ${JSON.stringify(selections)}`);
		const second = selections[selections.length - 1];
		assert.notStrictEqual(second, first, "second selection should capture new text");
		assert.ok(second.includes("line-"), `unexpected text: ${second}`);

		tui.stop();
	});
});
