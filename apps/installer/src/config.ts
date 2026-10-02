/**
 * The placeholders in `apps/forge/wrangler.deploy.jsonc`, and what fills each.
 * The installer creates the resources, then writes the deployed config by
 * replacing every placeholder. A test keeps this list and that file in step.
 */
export const deployPlaceholders = [
  "ACCESS_TEAM_DOMAIN",
  "ACCESS_AUDIENCE",
  "FIRST_ADMIN_EMAIL",
  "ORGANISATION_NAME",
  "AI_GATEWAY_ID",
  "ARTIFACTS_NAMESPACE",
  "D1_DATABASE_NAME",
  "D1_DATABASE_ID",
] as const;

export type DeployPlaceholder = (typeof deployPlaceholders)[number];
export type DeployValues = Record<DeployPlaceholder, string>;

/**
 * Fills the template, and sets where the Worker is reachable besides its
 * routes: `workers_dev`, and `preview_urls` always off. Throws if a
 * placeholder is left over or a value is missing.
 */
export function renderDeployConfig(
  template: string,
  values: DeployValues,
  routing: { workersDev: boolean },
): string {
  if (/"(workers_dev|preview_urls)"\s*:/.test(template)) {
    throw new Error("the deploy config sets workers_dev or preview_urls; the installer sets them");
  }
  const rendered = template.replace(/__([A-Z0-9_]+?)__/g, (match, name: string) => {
    const value = values[name as DeployPlaceholder];
    if (value === undefined) throw new Error(`no value for ${match} in the deploy config`);
    // Values land inside JSON strings.
    return JSON.stringify(value).slice(1, -1);
  });
  return rendered.replace(
    /^\{/m,
    `{\n  "workers_dev": ${routing.workersDev},\n  "preview_urls": false,`,
  );
}
