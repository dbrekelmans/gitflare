import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scriptedPrompter } from "./fakes.ts";
import { askAnswers, parseAccess } from "./questions.ts";
import { createFileAnswerStore } from "./store.ts";

const replies = [
  "", // account id: the default
  "Acme",
  "", // hostname: workers.dev
  "eu",
  "acme.example, @partner.example guest@other.example",
  "ada@acme.example",
  "", // budget: the default
  "unified",
];

const expected = {
  accountId: "acct1",
  organisationName: "Acme",
  domain: null,
  jurisdiction: "eu",
  access: { emailDomains: ["acme.example", "partner.example"], emails: ["guest@other.example"] },
  firstAdminEmail: "ada@acme.example",
  monthlyBudgetUsd: 200,
  billing: "unified",
};

describe("the questions", () => {
  it("asks everything on a first run", async () => {
    const { prompt, asked } = scriptedPrompter([...replies]);
    expect(await askAnswers(prompt, null, { accountId: "acct1" })).toEqual(expected);
    expect(asked).toHaveLength(8);
  });

  it("asks again when an answer does not validate", async () => {
    const withMistakes = [...replies];
    withMistakes.splice(5, 0, "not an address");
    withMistakes.splice(2, 0, "not a hostname");
    const { prompt, notes } = scriptedPrompter(withMistakes);
    expect(await askAnswers(prompt, null, { accountId: "acct1" })).toEqual(expected);
    expect(notes).toHaveLength(2);
  });

  it("asks nothing when every answer is saved, and re-asks a saved answer that is no longer valid", async () => {
    const none = scriptedPrompter();
    expect(await askAnswers(none.prompt, expected as never)).toEqual(expected);

    const one = scriptedPrompter(["us"]);
    const answers = await askAnswers(one.prompt, { ...expected, jurisdiction: "mars" } as never);
    expect(answers.jurisdiction).toBe("us");
    expect(one.asked).toHaveLength(1);
  });

  it("tells domains from addresses", () => {
    expect(parseAccess("Acme.Example,  ada@acme.example\n@b.example")).toEqual({
      emailDomains: ["acme.example", "b.example"],
      emails: ["ada@acme.example"],
    });
  });
});

describe("the answer store", () => {
  it("has nothing before the first run, then returns what was saved", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "create-gitflare-")), "nested", "answers.json");
    const store = createFileAnswerStore(path);
    expect(await store.load()).toBeNull();
    await store.save(expected as never);
    expect(await createFileAnswerStore(path).load()).toEqual(expected);
    expect(Object.keys(JSON.parse(await readFile(path, "utf8"))).sort()).toEqual(
      Object.keys(expected).sort(),
    );
  });
});
