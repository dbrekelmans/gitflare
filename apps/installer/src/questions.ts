import type { z } from "zod";
import { InstallAnswers } from "./answers.ts";
import type { Prompter } from "./plan.ts";

const fields = InstallAnswers.shape;

/**
 * Asks for whatever the saved answers do not already hold, so an upgrade asks
 * nothing. An answer that does not validate is asked again.
 */
export async function askAnswers(
  prompt: Prompter,
  saved: Partial<InstallAnswers> | null,
  defaults: { accountId?: string } = {},
): Promise<InstallAnswers> {
  async function answer<S extends z.ZodType>(
    key: keyof InstallAnswers,
    schema: S,
    ask: () => Promise<unknown>,
  ): Promise<z.infer<S>> {
    const kept = schema.safeParse(saved?.[key]);
    if (saved?.[key] !== undefined && kept.success) return kept.data;
    for (;;) {
      const parsed = schema.safeParse(await ask());
      if (parsed.success) return parsed.data;
      prompt.note(`That will not do: ${parsed.error.issues[0]?.message ?? "invalid"}.`);
    }
  }

  return {
    accountId: await answer("accountId", fields.accountId, () =>
      prompt.text("Cloudflare account id", { default: defaults.accountId }),
    ),
    organisationName: await answer("organisationName", fields.organisationName, () =>
      prompt.text("Your organisation's name"),
    ),
    domain: await answer("domain", fields.domain, async () => {
      const host = await prompt.text(
        "Hostname for the forge, on a domain in this account (leave empty to use workers.dev)",
      );
      return host.trim() === "" ? null : host.trim().toLowerCase();
    }),
    jurisdiction: await answer("jurisdiction", fields.jurisdiction, () =>
      prompt.select("Where must the data be kept? This cannot be changed later.", [
        { value: "eu", label: "In the European Union" },
        { value: "us", label: "In the United States" },
        { value: "unrestricted", label: "Anywhere" },
      ]),
    ),
    access: await answer("access", fields.access, async () =>
      parseAccess(
        await prompt.text(
          "Who may log in? Email domains and addresses, separated by commas (the first administrator always may)",
        ),
      ),
    ),
    firstAdminEmail: await answer("firstAdminEmail", fields.firstAdminEmail, async () =>
      (await prompt.text("The first administrator's email address")).trim(),
    ),
    monthlyBudgetUsd: await answer("monthlyBudgetUsd", fields.monthlyBudgetUsd, async () =>
      Number(await prompt.text("Budget for models, in US dollars per month", { default: "200" })),
    ),
    billing: await answer("billing", fields.billing, () =>
      prompt.select("How are models paid for?", [
        { value: "unified", label: "Prepaid credits on the Cloudflare account" },
        { value: "byok", label: "Your own Anthropic key, stored in the gateway" },
      ]),
    ),
  };
}

/** `acme.example, @acme.example` are domains; anything with a name before the `@` is an address. */
export function parseAccess(text: string): InstallAnswers["access"] {
  const entries = text
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return {
    emailDomains: entries.filter((e) => e.lastIndexOf("@") <= 0).map((e) => e.replace(/^@/, "")),
    emails: entries.filter((e) => e.lastIndexOf("@") > 0),
  };
}
