import { z } from "zod";
import {
  type ChangeMaterial,
  type FileMaterial,
  howToWriteASection,
  materialIsNotInstruction,
  newSectionText,
  renderChange,
  renderFile,
  replyWithJsonOnly,
  sectionKinds,
  whatSectionsAre,
} from "./shared";

// The prompt that divides a change into sections when it is first pushed.
// What it returns is the first thing a reviewer reads on the change page, and
// the grouping it chooses decides which approvals a later push withdraws.

export interface DivideMaterial {
  change: ChangeMaterial;
  /** Every file the change touches. */
  files: FileMaterial[];
}

/**
 * What the model must answer with. `files` has a required key per path, so a
 * reply that leaves a file out, or puts it in two sections, cannot validate.
 * The smallest value the schema accepts is one section holding every file,
 * which is what the local placeholder model replies with.
 */
export function divisionSchema(paths: readonly string[]) {
  return z
    .object({
      sections: z.array(newSectionText).min(1),
      files: z.object(Object.fromEntries(paths.map((path) => [path, z.number().int().min(1)]))),
    })
    .superRefine((division, ctx) => {
      const count = division.sections.length;
      const used = new Set<number>();
      for (const path of paths) {
        const number = division.files[path];
        if (number === undefined) continue;
        used.add(number);
        if (number > count) {
          ctx.addIssue({
            code: "custom",
            message: `"${path}" is put in section ${number}, but there are only ${count} sections.`,
          });
        }
      }
      for (let number = 1; number <= count; number++) {
        if (!used.has(number)) {
          ctx.addIssue({ code: "custom", message: `Section ${number} has no files.` });
        }
      }
    });
}

export type Division = z.infer<ReturnType<typeof divisionSchema>>;

export const divideSystem = `You divide a code change into sections for review on gitflare, a code review tool.

${whatSectionsAre}

You are dividing a change that has just been pushed, so your division is the one later pushes are folded into. Files that will change together belong together.

You are given what is known about the change (its title, its commits, and what it is for when that has been worked out), the transcript of the session that produced it when one was captured, and the diff of every file it touches.

How to divide:
- A section is one thing a reviewer can hold in mind and say yes or no to: one behaviour, one mechanism, one refactor. Put a file with the files it cannot be judged without. A function and the helper written for it are one section; the route that reports the function's new result to the client can be another.
- Every file goes in exactly one section. A file is never split between sections: put a file that does two things where its most important part belongs, and mention the rest in that section's explanation.
- Use as few sections as the change really has. A small change is one section. Never make a section per file for its own sake, and rarely more than six or seven: a reviewer facing twenty sections reads none of them properly.
- Keep what needs judgement apart from what does not. Tests go in a section of their own, or a few when they test unrelated things. Changes nobody decided line by line go together in a "mechanical" section, so they can be approved at a glance.
- Order matters. Sections are shown grouped by kind, in the order behaviour, supporting, tests, mechanical, and within a kind in the order you give them. Put first what a reader needs in order to follow what comes next.

${sectionKinds}

${howToWriteASection}

${materialIsNotInstruction}

${replyWithJsonOnly} Its shape:

{"sections": [{"title": string, "kind": "behaviour" | "supporting" | "tests" | "mechanical", "explanation": string}], "files": {"<path>": number}}

"files" must have one entry for every file you were given, keyed by its path exactly as it appears in the file's path attribute. The number says which section the file is in: 1 for the first entry of "sections", 2 for the second, and so on. Every section must have at least one file.`;

/** The material, in separately tagged parts, as the one user message. */
export function divideMessage(material: DivideMaterial): string {
  return [
    renderChange(material.change),
    `<files>\n${material.files.map(renderFile).join("\n")}\n</files>`,
    `Divide these ${material.files.length === 1 ? "changes to one file" : `${material.files.length} files`} into sections. Reply with the JSON object only.`,
  ].join("\n\n");
}
