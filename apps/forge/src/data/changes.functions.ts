import {
  ChangeRef,
  CiStepRef,
  ListChangesInput,
  RerunStageInput,
  SectionRef,
} from "@gitflare/core/api";
import { createServerFn } from "@tanstack/react-start";
import { forgeApi } from "@/server/api";
import { authed } from "./fn";

export const listChanges = createServerFn()
  .middleware([authed])
  .validator(ListChangesInput)
  .handler(({ context, data }) => forgeApi().changes.list(context, data));

export const getChange = createServerFn()
  .middleware([authed])
  .validator(ChangeRef)
  .handler(({ context, data }) => forgeApi().changes.get(context, data));

export const getSectionDiff = createServerFn()
  .middleware([authed])
  .validator(SectionRef)
  .handler(({ context, data }) => forgeApi().changes.sectionDiff(context, data));

export const approveSection = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(SectionRef)
  .handler(({ context, data }) => forgeApi().changes.approveSection(context, data));

export const revokeApproval = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(SectionRef)
  .handler(({ context, data }) => forgeApi().changes.revokeApproval(context, data));

export const rerunStage = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(RerunStageInput)
  .handler(({ context, data }) => forgeApi().changes.rerunStage(context, data));

export const mergeChange = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(ChangeRef)
  .handler(({ context, data }) => forgeApi().changes.merge(context, data));

export const closeChange = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(ChangeRef)
  .handler(({ context, data }) => forgeApi().changes.close(context, data));

export const getChangeCi = createServerFn()
  .middleware([authed])
  .validator(ChangeRef)
  .handler(({ context, data }) => forgeApi().changes.ci(context, data));

export const getCiLog = createServerFn()
  .middleware([authed])
  .validator(CiStepRef)
  .handler(({ context, data }) => forgeApi().changes.ciLog(context, data));
