import type { ExtensionContext, TranscriptSelection } from "@earendil-works/pi-coding-agent";

export const INLINE_COMMENT_STATE_TYPE = "inline-comments:state";

export interface InlineCommentAnnotationSource {
	entryId: string;
	quote: string;
	comment: string;
	selection?: TranscriptSelection;
}

export interface InlineCommentTranscriptAnnotation {
	id: string;
	marker: string;
	selection: TranscriptSelection;
	open: boolean;
	onOpen: (selection: TranscriptSelection) => void;
}

export function restoreInlineCommentState(ctx: ExtensionContext): InlineCommentAnnotationSource[] {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "custom" || entry.customType !== INLINE_COMMENT_STATE_TYPE) continue;
		const data = entry.data;
		if (!isRecord(data) || data.version !== 1 || !Array.isArray(data.comments)) continue;
		return data.comments.filter(isInlineCommentAnnotationSource);
	}
	return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isPoint(value: unknown): value is { row: number; column: number } {
	return (
		isRecord(value) &&
		typeof value.row === "number" &&
		Number.isInteger(value.row) &&
		value.row >= 0 &&
		typeof value.column === "number" &&
		Number.isInteger(value.column) &&
		value.column >= 0
	);
}

function isTranscriptSelection(value: unknown): value is TranscriptSelection {
	if (!isRecord(value) || typeof value.text !== "string") return false;
	if (!isRecord(value.document) || !isRecord(value.viewport)) return false;
	return (
		isPoint(value.document.start) &&
		isPoint(value.document.end) &&
		isPoint(value.viewport.start) &&
		isPoint(value.viewport.end)
	);
}

function isInlineCommentAnnotationSource(value: unknown): value is InlineCommentAnnotationSource {
	return (
		isRecord(value) &&
		typeof value.entryId === "string" &&
		typeof value.quote === "string" &&
		typeof value.comment === "string" &&
		(value.selection === undefined || isTranscriptSelection(value.selection))
	);
}

export function createTranscriptAnnotations(
	comments: readonly InlineCommentAnnotationSource[],
	onOpen: (index: number, selection?: TranscriptSelection) => void,
	openIndex?: number,
): InlineCommentTranscriptAnnotation[] {
	return comments.flatMap((comment, index) => {
		if (!comment.selection) return [];
		return [
			{
				id: `inline-comment-${index + 1}`,
				marker: `🫧${index + 1}`,
				selection: comment.selection,
				open: openIndex === index,
				onOpen: (selection) => onOpen(index, selection),
			},
		];
	});
}

function normalizeRenderedText(text: string): string {
	return text.normalize().replaceAll(/\s+/g, " ").trim();
}

// Collapse all whitespace, so a mouse selection that lost a wrap or blank-line
// space still matches the source message text. Selector text is a contiguous
// run of visible characters; after removing whitespace it must appear verbatim.
function collapseWhitespace(text: string): string {
	return text.normalize().replaceAll(/\s+/g, "");
}

function normalizeMarkdownText(text: string): string {
	return normalizeRenderedText(
		text
			.replaceAll(/```[^\n]*\n?/g, "")
			.replaceAll(/`([^`]+)`/g, "$1")
			.replaceAll(/\[([^\]]+)\]\([^)]*\)/g, "$1")
			.replaceAll(/^\s{0,3}#{1,6}\s+/gm, "")
			.replaceAll(/^\s{0,3}>\s?/gm, "")
			.replaceAll(/^\s{0,3}[-*+]\s+/gm, "")
			.replaceAll(/[*_~]/g, ""),
	);
}

export function findAssistantEntryId(ctx: ExtensionContext, quote: string): string | undefined {
	const normalizedQuote = normalizeRenderedText(quote);
	if (!normalizedQuote) return undefined;
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const text = entry.message.content
			.filter(
				(part: { type: string; text?: string }): part is { type: "text"; text: string } =>
					part.type === "text" && typeof part.text === "string",
			)
			.map((part: { text: string }) => part.text)
			.join("\n");
		const plain = normalizeRenderedText(text);
		const markdown = normalizeMarkdownText(text);
		if (plain.includes(normalizedQuote) || markdown.includes(normalizedQuote)) {
			return entry.id;
		}
		// Fall back to whitespace-insensitive matching when the rendered selection
		// lost a wrap or blank-line space the source message keeps.
		const collapsedQuote = collapseWhitespace(normalizedQuote);
		if (
			collapsedQuote.length >= 4 &&
			(collapseWhitespace(plain).includes(collapsedQuote) || collapseWhitespace(markdown).includes(collapsedQuote))
		) {
			return entry.id;
		}
	}

	// Never guess an assistant entry: a wrong attachment is worse than asking
	// the user to retry with a more specific quote.
	return undefined;
}
