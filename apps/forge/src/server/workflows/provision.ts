import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { completeRepositoryImport, completeSessionFork } from "@gitflare/artifacts";
import { ForgeError, type ProvisionParams } from "@gitflare/core";
import { schema } from "@gitflare/db";
import { prepareWorkspace } from "@gitflare/sandbox";
import setupScript from "../../../containers/workspace/setup.sh?raw";
import { getServices } from "../services";

// Copying a repository is slow and occasionally fails outright, so each kind
// of work is one step that is retried with a growing delay.
const patient = {
  retries: { limit: 8, delay: "5 seconds", backoff: "exponential" },
  timeout: "10 minutes",
} as const;

/**
 * The slow work that must not run while a person waits: forking a repository
 * for a session, importing one, and preparing the workspace sandboxes boot
 * from. Started through the `provisioning` port. All the logic is in the
 * packages; this class only makes each call a retried Workflow step. It is
 * complete as it stands: no build task owns it.
 */
export class ProvisionWorkflow extends WorkflowEntrypoint<Env, ProvisionParams> {
  async run(event: WorkflowEvent<ProvisionParams>, step: WorkflowStep): Promise<void> {
    const params = event.payload;
    const services = getServices();

    if (params.kind === "fork") {
      await step.do("fork the repository", patient, async () => {
        await completeSessionFork(services, params.sessionId);
      });
      return;
    }

    if (params.kind === "import") {
      await step.do("import the repository", patient, async () => {
        await completeRepositoryImport(services, params.repositoryId, params.url);
      });
      return;
    }

    await step.do("prepare the workspace", patient, async () => {
      const [organisation] = await services.db.select().from(schema.organisations).limit(1);
      if (!organisation) throw new ForgeError("not_found", "No organisation to prepare.");
      const { image } = organisation.settings.workspace;
      const snapshot = await prepareWorkspace(services, { image, setupScript });
      await services.db
        .update(schema.organisations)
        .set({ settings: { ...organisation.settings, workspace: { image, snapshot } } });
    });
  }
}
