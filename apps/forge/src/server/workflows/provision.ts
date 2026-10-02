import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  completeRepositoryImport,
  completeSessionFork,
  failRepositoryImport,
  launchCloudSession,
} from "@gitflare/artifacts";
import { ForgeError, type ProvisionParams } from "@gitflare/core";
import { schema } from "@gitflare/db";
import { prepareWorkspace } from "@gitflare/sandbox";
import setupScript from "../../../containers/workspace/setup.sh?raw";
import { getServices, type Services } from "../services";

/** Where the Workflow gets its services. A worker test points it at fakes. */
export const provisionRuntime: { create: () => Services } = {
  create: () => getServices(),
};

// Copying a repository is slow and occasionally fails outright, so each kind
// of work is one step that is retried with a growing delay.
const patient = {
  retries: { limit: 8, delay: "5 seconds", backoff: "exponential" },
  timeout: "10 minutes",
} as const;

/**
 * The slow work that must not run while a person waits: forking a repository
 * for a session and launching a hosted one on it, importing one, and
 * preparing the workspace sandboxes boot from. Started through the
 * `provisioning` port. All the logic is in the packages; this class only
 * makes each call a retried Workflow step.
 */
export class ProvisionWorkflow extends WorkflowEntrypoint<Env, ProvisionParams> {
  async run(event: WorkflowEvent<ProvisionParams>, step: WorkflowStep): Promise<void> {
    const params = event.payload;
    const services = provisionRuntime.create();

    if (params.kind === "fork") {
      await step.do("fork the repository", patient, async () => {
        await completeSessionFork(services, params.sessionId);
      });
      // Its own step, so a retried launch does not fork again. It does
      // nothing for a local session.
      await step.do("launch the hosted session", patient, async () => {
        await launchCloudSession(services, params.sessionId);
      });
      return;
    }

    if (params.kind === "import") {
      try {
        await step.do("import the repository", patient, async () => {
          await completeRepositoryImport(services, params.repositoryId, params.url);
        });
      } catch (error) {
        // Out of retries: the repository must say so, or it is importing forever.
        const reason = error instanceof Error ? error.message : String(error);
        await step.do("record the failed import", async () => {
          await failRepositoryImport(
            services,
            params.repositoryId,
            `The import did not finish: ${reason}`,
          );
        });
      }
      return;
    }

    try {
      await step.do("prepare the workspace", patient, async () => {
        const [organisation] = await services.db.select().from(schema.organisations).limit(1);
        if (!organisation) throw new ForgeError("not_found", "No organisation to prepare.");
        const { image } = organisation.settings.workspace;
        const snapshot = await prepareWorkspace(services, { image, setupScript });
        // Without `preparation`: nothing is under way and nothing failed.
        await services.db
          .update(schema.organisations)
          .set({ settings: { ...organisation.settings, workspace: { image, snapshot } } });
      });
    } catch (error) {
      // Out of retries: the settings page must stop waiting for it.
      const reason = error instanceof Error ? error.message : String(error);
      await step.do("record the failed preparation", async () => {
        const [organisation] = await services.db.select().from(schema.organisations).limit(1);
        if (!organisation) return;
        const { workspace } = organisation.settings;
        const preparation = {
          state: "failed",
          failedAt: services.clock.now(),
          error: reason,
        } as const;
        await services.db.update(schema.organisations).set({
          settings: { ...organisation.settings, workspace: { ...workspace, preparation } },
        });
      });
    }
  }
}
