/**
 * The intent prompt. Its one output is the paragraph a reviewer reads before
 * anything else on a change: kept in its own file so it can be read and
 * revised without reading the stage logic around it.
 */

/** Matches the prototype's cap (`prototypes/derivation/src/cli.ts`, `MAX_DIFF_CHARS`). */
export const MAX_DIFF_CHARS = 100_000;

export interface IntentPromptInput {
  changeTitle: string;
  /** The condensed capture, or null when nothing was captured for this change. */
  transcript: string | null;
  diffText: string;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[… diff truncated, ${text.length - maxChars} chars omitted …]`;
}

export function buildIntentPrompt(input: IntentPromptInput): string {
  const instruction = `You write the "intent" statement for a code review platform: one paragraph, shown above everything else on a change page, before the reviewer has looked at the diff. State what the change was FOR — the purpose it serves — not a list of what it touched. Write it so a reviewer who has not read the diff yet knows what question to bring to it. At most 60 words, plain prose, no preamble.`;

  const diffText = truncate(input.diffText, MAX_DIFF_CHARS);
  const material = input.transcript
    ? `## The agent session that produced this change

${input.transcript}

## Diff

${diffText}`
    : `No agent session transcript is available for this change. Derive the intent from the diff alone.

## Diff

${diffText}`;

  return `${instruction}

---

# Change: ${input.changeTitle}

${material}

Respond with a single JSON object and nothing else — no preamble, no code fence:
{"statement": string}`;
}
