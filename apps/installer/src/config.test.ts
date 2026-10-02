import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { InstallAnswers } from "./answers.ts";
import { deployPlaceholders, renderDeployConfig } from "./config.ts";

const template = readFileSync(
  new URL("../../forge/wrangler.deploy.jsonc", import.meta.url),
  "utf8",
);

describe("deploy config", () => {
  it("knows every placeholder in the forge's deploy config, and no others", () => {
    const inTemplate = new Set([...template.matchAll(/__([A-Z0-9_]+?)__/g)].map((m) => m[1]));
    expect([...inTemplate].sort()).toEqual([...deployPlaceholders].sort());
  });

  it("fills the template and leaves nothing behind", () => {
    const values = Object.fromEntries(
      deployPlaceholders.map((name) => [name, `value-of-${name.toLowerCase()}`]),
    ) as Record<(typeof deployPlaceholders)[number], string>;
    values.ORGANISATION_NAME = 'Acme "Web" Studio';
    const rendered = renderDeployConfig(template, values, { workersDev: true });
    expect(rendered).not.toMatch(/__[A-Z0-9_]+__/);
    expect(rendered).toContain('"ORGANISATION_NAME": "Acme \\"Web\\" Studio"');
    expect(() => renderDeployConfig("__UNKNOWN__", values, { workersDev: true })).toThrow(
      /no value/,
    );
    // Still JSONC, with the routing settings inside the object.
    expect(rendered).toMatch(/^\{\n {2}"workers_dev": true,\n {2}"preview_urls": false,$/m);
  });

  it("refuses a template that sets the routing the installer decides", () => {
    expect(() =>
      renderDeployConfig('{ "workers_dev": true }', {} as never, { workersDev: false }),
    ).toThrow(/installer sets them/);
  });

  it("validates the answers it asks for", () => {
    const answers = {
      accountId: "abc",
      organisationName: "Acme",
      domain: null,
      jurisdiction: "eu",
      access: { emailDomains: ["acme.example"], emails: [] },
      firstAdminEmail: "ada@acme.example",
      monthlyBudgetUsd: 200,
      billing: "unified",
    };
    expect(InstallAnswers.safeParse(answers).success).toBe(true);
    expect(InstallAnswers.safeParse({ ...answers, jurisdiction: "mars" }).success).toBe(false);
  });
});
