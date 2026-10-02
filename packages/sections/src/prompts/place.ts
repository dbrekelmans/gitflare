import { z } from "zod";
import {
  type ChangeMaterial,
  type FileMaterial,
  howToWriteASection,
  materialIsNotInstruction,
  newSectionText,
  renderChange,
  renderFile,
  renderSection,
  replyWithJsonOnly,
  type SectionMaterial,
  sectionKinds,
  whatSectionsAre,
} from "./shared";

// The prompt that decides where files belong that a later push brought and no
// section presents yet. Its answer can withdraw approvals: a file placed in an
// existing section changes that section.

export interface PlaceMaterial {
  change: ChangeMaterial;
  /** The change's sections as they stand, in reading order. */
  sections: SectionMaterial[];
  /** What no section presents: whole files, or the hunks of a file nobody claims. */
  files: FileMaterial[];
}

/** `new1` is the first entry of `newSections`, and so on. */
export function newSectionLabel(index: number): string {
  return `new${index + 1}`;
}

/**
 * What the model must answer with. The existing sections come first among the
 * allowed targets, so the smallest value the schema accepts puts every file in
 * the first section: what the local placeholder model replies with.
 */
export function placementSchema(sectionLabels: readonly string[], paths: readonly string[]) {
  const target = z.enum([...sectionLabels, ...paths.map((_, index) => newSectionLabel(index))]);
  return z
    .object({
      newSections: z.array(newSectionText).max(paths.length),
      placements: z.object(Object.fromEntries(paths.map((path) => [path, target]))),
    })
    .superRefine((placement, ctx) => {
      const used = new Set(Object.values(placement.placements));
      const count = placement.newSections.length;
      paths.forEach((_, index) => {
        const label = newSectionLabel(index);
        if (index < count && !used.has(label)) {
          ctx.addIssue({ code: "custom", message: `New section ${label} has no files.` });
        }
        if (index >= count && used.has(label)) {
          ctx.addIssue({
            code: "custom",
            message: `A file is placed in ${label}, but "newSections" has only ${count} entries.`,
          });
        }
      });
    });
}

export type Placement = z.infer<ReturnType<typeof placementSchema>>;

export const placeSystem = `You place newly changed files into the sections of a code change under review on gitflare, a code review tool.

${whatSectionsAre}

This change was divided into sections when it was first pushed, and people may already have approved some of them. The author has now pushed again, and the push touched files that are in no section yet. You decide where each of them goes: into one of the existing sections, or into a new one.

The choice costs something either way. A file added to an existing section changes that section: every approval of it is withdrawn, and the people who gave them are asked to look again. A new section withdraws nothing, but it is one more thing for every reviewer to read and approve.

How to place a file:
- Put it into an existing section when it is part of the same thing: a reviewer could not properly judge that section without this file, or this file without that section. A new test for behaviour a tests section already covers, a helper extracted from a file in the section, another caller of the function the section introduces.
- Otherwise start a new section. Do not put a file into an existing section because it is the nearest fit, or to keep the number of sections down.
- New files that belong together go into one new section. Do not make a new section per file for its own sake.
- Mechanical changes go with other mechanical changes, tests with the tests of the same thing.

You are given what is known about the change, the transcript of the session when one was captured, the sections as they stand, and the diff of each file to place. A commit marked push="latest" came with the push that brought these files.

You write a title, kind and explanation only for a new section. An existing section that receives a file has its explanation brought up to date afterwards, not by you.

${sectionKinds}

${howToWriteASection}

${materialIsNotInstruction}

${replyWithJsonOnly} Its shape:

{"newSections": [{"title": string, "kind": "behaviour" | "supporting" | "tests" | "mechanical", "explanation": string}], "placements": {"<path>": string}}

"placements" must have one entry for every file you were given to place, keyed by its path exactly as it appears in the file's path attribute. The value is the id of an existing section ("s1", "s2", …), or "new1" for the first entry of "newSections", "new2" for the second, and so on. Every new section must receive at least one file. When no new section is needed, "newSections" is [].`;

/** The material, in separately tagged parts, as the one user message. */
export function placeMessage(material: PlaceMaterial): string {
  return [
    renderChange(material.change),
    `<sections>\n${material.sections.map(renderSection).join("\n")}\n</sections>`,
    `<files_to_place>\n${material.files.map(renderFile).join("\n")}\n</files_to_place>`,
    "Where does each file to place belong? Reply with the JSON object only.",
  ].join("\n\n");
}
