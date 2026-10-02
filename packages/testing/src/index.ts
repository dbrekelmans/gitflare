import type { Identity } from "@gitflare/core";
import type { Ports } from "@gitflare/core/ports";
import { z } from "zod";
import { demo } from "./demo";
import { buildDemoGit } from "./demo/git";
import { FakeGit } from "./fakes/git";
import { FakeCapture, FakeDecisions, FakeDiffs } from "./fakes/internal";
import { FakeModelGateway, placeholderResponder } from "./fakes/models";
import {
  FakeCloudSessions,
  FakeIdentity,
  FakeThreads,
  ManualClock,
  RecordingLive,
  RecordingPipeline,
  RecordingProvisioner,
  SequentialIds,
} from "./fakes/runtime";
import { FakeSandboxHost } from "./fakes/sandbox";

export { diffFiles, lineDiff } from "./demo/diff";
export * from "./fakes/git";
export * from "./fakes/internal";
export * from "./fakes/models";
export * from "./fakes/runtime";
export * from "./fakes/sandbox";

/** `Ports`, with every member typed as its fake so a test can script and inspect it. */
export interface FakePorts extends Ports {
  git: FakeGit;
  gitWriter: FakeGit;
  sandboxes: FakeSandboxHost;
  models: FakeModelGateway;
  identity: FakeIdentity;
  live: RecordingLive;
  pipeline: RecordingPipeline;
  provisioning: RecordingProvisioner;
  threads: FakeThreads;
  cloudSessions: FakeCloudSessions;
  capture: FakeCapture;
  diffs: FakeDiffs;
  decisions: FakeDecisions;
  clock: ManualClock;
  ids: SequentialIds;
}

export const testIdentity: Identity = {
  subject: "test|someone",
  email: "someone@example.com",
  name: "Someone",
};

/**
 * A complete set of fakes, sharing one clock. The git host starts empty and
 * the caller is signed in as `testIdentity`; pass overrides for anything a
 * test wants to supply itself.
 */
export function createFakePorts(overrides: Partial<FakePorts> = {}): FakePorts {
  const clock = overrides.clock ?? new ManualClock();
  const ids = overrides.ids ?? new SequentialIds();
  const git = overrides.git ?? new FakeGit(clock);
  return {
    git,
    gitWriter: git,
    sandboxes: new FakeSandboxHost(),
    models: new FakeModelGateway(),
    identity: new FakeIdentity(testIdentity),
    live: new RecordingLive(),
    pipeline: new RecordingPipeline(),
    provisioning: new RecordingProvisioner(),
    threads: new FakeThreads(clock, ids),
    cloudSessions: new FakeCloudSessions(clock),
    capture: new FakeCapture(clock),
    diffs: new FakeDiffs(git),
    decisions: new FakeDecisions(clock, ids),
    clock,
    ids,
    ...overrides,
  };
}

/**
 * The fakes local development runs on: the demo's repositories in the git
 * host, the demo's "now" on the clock, and every request signed in as the
 * demo's viewer. The model fake answers every call with a placeholder, so the
 * pipeline can run without a model. Pair it with `seedDemo` for the database.
 */
export function createDemoPorts(): FakePorts {
  const clock = new ManualClock(demo.now);
  const { subject, email, name } = demo.viewer;
  const ports = createFakePorts({
    clock,
    models: new FakeModelGateway().respond(
      placeholderResponder((schema) => z.toJSONSchema(schema)),
    ),
    git: buildDemoGit().git,
    identity: new FakeIdentity({ subject, email, name }),
  });
  for (const session of demo.capturedSessions) {
    ports.capture.set({
      changeId: session.changeId,
      sessions: [session],
      missingCheckpointIds: [],
    });
  }
  ports.decisions.add(...structuredClone(demo.decisions));
  return ports;
}
