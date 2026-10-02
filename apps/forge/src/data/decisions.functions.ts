import {
  CreateDecisionInput,
  DecisionRef,
  EditDecisionInput,
  ListDecisionsInput,
  RevertDecisionInput,
} from "@gitflare/core/api";
import { createServerFn } from "@tanstack/react-start";
import { forgeApi } from "@/server/api";
import { authed } from "./fn";

export const listDecisions = createServerFn()
  .middleware([authed])
  .validator(ListDecisionsInput)
  .handler(({ context, data }) => forgeApi().decisions.list(context, data));

export const getDecision = createServerFn()
  .middleware([authed])
  .validator(DecisionRef)
  .handler(({ context, data }) => forgeApi().decisions.get(context, data));

export const createDecision = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(CreateDecisionInput)
  .handler(({ context, data }) => forgeApi().decisions.create(context, data));

export const editDecision = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(EditDecisionInput)
  .handler(({ context, data }) => forgeApi().decisions.edit(context, data));

export const revertDecision = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(RevertDecisionInput)
  .handler(({ context, data }) => forgeApi().decisions.revert(context, data));

export const reviveDecision = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(DecisionRef)
  .handler(({ context, data }) => forgeApi().decisions.revive(context, data));
