import { readStepLog } from "@gitflare/ci";
import type { ForgeApi } from "@gitflare/core/api";
import {
  approveSection,
  changeDetail,
  ciView,
  closeChange,
  listChanges,
  mergeChange,
  rerunStage,
  revokeApproval,
  sectionDiff,
} from "@gitflare/pipeline";
import type { Services } from "../services";

/**
 * Changes: the list, the change page's read model, section approval, re-running a stage, merging and closing.
 * Build task: `pipeline`.
 */
export function changesApi(services: Services): ForgeApi["changes"] {
  return {
    list: (ctx, input) => listChanges(services, ctx.user, input),
    get: (_ctx, input) => changeDetail(services, input.changeId),
    sectionDiff: (_ctx, input) => sectionDiff(services, input.changeId, input.sectionId),
    async approveSection(ctx, input) {
      await approveSection(services, ctx.user, input.changeId, input.sectionId);
      return changeDetail(services, input.changeId);
    },
    async revokeApproval(ctx, input) {
      await revokeApproval(services, ctx.user, input.changeId, input.sectionId);
      return changeDetail(services, input.changeId);
    },
    async rerunStage(ctx, input) {
      await rerunStage(services, ctx.user, input.changeId, input.stage);
      return changeDetail(services, input.changeId);
    },
    async merge(ctx, input) {
      await mergeChange(services, ctx.user, input.changeId);
      return changeDetail(services, input.changeId);
    },
    async close(ctx, input) {
      await closeChange(services, ctx.user, input.changeId);
      return changeDetail(services, input.changeId);
    },
    ci: (_ctx, input) => ciView(services, input.changeId),
    ciLog: (_ctx, input) => readStepLog(services, input.stepId),
  };
}
