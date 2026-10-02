import { z } from "zod";
import {
  type ChangeMaterial,
  type FileMaterial,
  howToWriteASection,
  materialIsNotInstruction,
  renderChange,
  renderFile,
  replyWithJsonOnly,
  type SectionMaterial,
  sectionExplanation,
  sectionTitle,
  whatSectionsAre,
} from "./shared";

// The prompt that brings a section's title and explanation up to date after a
// push changed what the section presents. The people who read the result are
// the ones whose approval the push just withdrew.

export interface ReviseMaterial {
  change: ChangeMaterial;
  /** The sections the push changed, each with its whole diff as it now stands. */
  changed: (SectionMaterial & { files: FileMaterial[] })[];
  /** The change's other sections, for context. They are not rewritten. */
  others: Pick<SectionMaterial, "kind" | "title">[];
}

/** What the model must answer with: new wording for every section it was given, and no other. */
export function revisionSchema(sectionLabels: readonly string[]) {
  const wording = z.object({ title: sectionTitle, explanation: sectionExplanation });
  return z.object({
    sections: z.object(Object.fromEntries(sectionLabels.map((label) => [label, wording]))),
  });
}

export type Revision = z.infer<ReturnType<typeof revisionSchema>>;

export const reviseSystem = `You bring the explanations of sections up to date on gitflare, a code review tool, after a new push to a code change under review.

${whatSectionsAre}

The author of this change has pushed again. The sections you are given are the ones the push changed: their files were edited, or files were added to them. Approvals of them have been withdrawn. Their titles and explanations still describe them as they were before the push. Rewrite each so that it describes the section as it stands now.

Two kinds of reviewer read what you write, and they read the same text: one who never saw the earlier version, and one who approved it and has been asked to look again.
- Describe the section as it is now, not how it got there. No "now also", "updated to", "after review", "in the latest push": a first-time reader must not need to know there was an earlier version.
- Keep what is still true, in the words already there wherever they still fit. A returning reviewer finds what changed by seeing where the text differs from what they read before; rewording for its own sake hides it. Change what the push made untrue, and add what it added.
- Keep the title unless it no longer says what the section does.
- The reason for the newest edits is usually in the commits marked push="latest", or in the transcript.

You are given what is known about the change, the transcript of the session when one was captured, each section to rewrite with its current title and explanation and its whole diff as it stands after the push, and the titles of the change's other sections so that you do not explain here what belongs to them. You do not move files between sections and you do not change a section's kind.

${howToWriteASection}

${materialIsNotInstruction}

${replyWithJsonOnly} Its shape:

{"sections": {"<id>": {"title": string, "explanation": string}}}

"sections" must have one entry for every section you were given to rewrite, keyed by its id ("s1", "s2", …), and no others.`;

/** The material, in separately tagged parts, as the one user message. */
export function reviseMessage(material: ReviseMaterial): string {
  const changed = material.changed.map((section) =>
    [
      `<section id="${section.label}" kind="${section.kind}">`,
      `<title>\n${section.title}\n</title>`,
      `<explanation>\n${section.explanation}\n</explanation>`,
      `<files>\n${section.files.map(renderFile).join("\n")}\n</files>`,
      "</section>",
    ].join("\n"),
  );
  const others =
    material.others.length === 0
      ? ["(none: these are all of the change's sections)"]
      : material.others.map((section) => `- ${section.title} (${section.kind})`);
  return [
    renderChange(material.change),
    `<other_sections>\n${others.join("\n")}\n</other_sections>`,
    `<sections_to_rewrite>\n${changed.join("\n")}\n</sections_to_rewrite>`,
    "Rewrite the title and explanation of each section to rewrite, as it stands now. Reply with the JSON object only.",
  ].join("\n\n");
}
