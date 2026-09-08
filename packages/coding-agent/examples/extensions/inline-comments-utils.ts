import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

function normalizeRenderedText(text: string): string {
	return text.normalize().replaceAll(/\s+/g, " ").trim();
}

export function findAssistantEntryId(ctx: ExtensionContext, quote: string): string | undefined {
	const normalizedQuote = normalizeRenderedText(quote);
	let latestAssistantId: string | undefined;
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		latestAssistantId ??= entry.id;
		const text = entry.message.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		if (normalizeRenderedText(text).includes(normalizedQuote)) return entry.id;
	}

	// Fullscreen selections contain rendered Markdown rather than the source
	// message. If formatting changed the text, the selected quote remains the
	// durable anchor and the latest assistant entry supplies context.
	return latestAssistantId;
}
