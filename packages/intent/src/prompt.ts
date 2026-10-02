/**
 * The intent prompt. Its one output is the paragraph a reviewer reads before
 * anything else on a change: kept in its own file so it can be read and
 * revised without reading the stage logic around it.
 */

export interface IntentPromptInput {
  changeTitle: string;
  /** The condensed capture, or null when nothing was captured for this change. */
  transcript: string | null;
  diffText: string;
}

export function buildIntentPrompt(input: IntentPromptInput): string {
  const instruction = `You write the "intent" statement for a code review platform: one paragraph, shown above everything else on a change page, before the reviewer has looked at the diff. State what the change was FOR — the purpose it serves — not a list of what it touched. Write it so a reviewer who has not read the diff yet knows what question to bring to it. At most 60 words, plain prose, no preamble.`;

  const material = input.transcript
    ? `## The agent session that produced this change

${input.transcript}

## Diff

${input.diffText}`
    : `No agent session transcript is available for this change. Derive the intent from the diff alone.

## Diff

${input.diffText}`;

  return `${instruction}

---

# Change: ${input.changeTitle}

${material}

Respond with a single JSON object and nothing else — no preamble, no code fence:
{"statement": string}`;
}
