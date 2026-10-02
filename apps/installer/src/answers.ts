import { z } from "zod";

/**
 * Everything the installer asks: only what cannot be defaulted or changed
 * later. Answers are saved, without secrets, so an upgrade does not ask again.
 */
export const InstallAnswers = z.object({
  accountId: z.string().min(1),
  organisationName: z.string().trim().min(1).max(80),
  /** A hostname on a zone in the account, or null for the account's workers.dev address. */
  domain: z.string().nullable(),
  /** Fixed when the Artifacts namespace is created; it cannot be changed afterwards. */
  jurisdiction: z.enum(["eu", "us", "unrestricted"]),
  /** Who may log in: whole email domains, individual addresses, or both. */
  access: z.object({
    emailDomains: z.array(z.string()),
    emails: z.array(z.email()),
  }),
  firstAdminEmail: z.email(),
  monthlyBudgetUsd: z.number().positive(),
  /** Models billed through Cloudflare, or through the deployer's own provider key. */
  billing: z.enum(["unified", "byok"]),
});
export type InstallAnswers = z.infer<typeof InstallAnswers>;
