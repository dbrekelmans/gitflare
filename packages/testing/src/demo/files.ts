// The demo repository's files at three points: the base the session forked
// from, the first push of change #12, and its head after the second push.
// Section diffs in the fixture are computed from these, and the fake git host
// is loaded with the same contents, so the two cannot drift apart.

const sendInviteBase = `import { queueInviteEmail } from "./email";
import type { Env } from "../env";

export async function sendInvite(env: Env, workspaceId: string, email: string) {
  const invite = await env.DB.prepare(
    "insert into invites (workspace_id, email) values (?, ?) returning id",
  )
    .bind(workspaceId, email)
    .first<{ id: string }>();
  await queueInviteEmail(env, invite!.id);
  return { limited: false as const, id: invite!.id };
}
`;

const sendInviteHead = `import { queueInviteEmail } from "./email";
import { takeInviteSlot } from "./rate-limit";
import type { Env } from "../env";

export async function sendInvite(env: Env, workspaceId: string, email: string) {
  const slot = await takeInviteSlot(env, workspaceId);
  if (!slot.allowed) return { limited: true as const, retryAfter: slot.retryAfter };

  const invite = await env.DB.prepare(
    "insert into invites (workspace_id, email) values (?, ?) returning id",
  )
    .bind(workspaceId, email)
    .first<{ id: string }>();
  await queueInviteEmail(env, invite!.id);
  return { limited: false as const, id: invite!.id };
}
`;

const rateLimitRev1 = `import type { Env } from "../env";

const WINDOW_SECONDS = 3600;
const LIMIT = 20;

export interface InviteSlot {
  allowed: boolean;
  /** Seconds until the window resets. */
  retryAfter: number;
}

/** A fixed window: at most LIMIT invites per hour. */
export async function takeInviteSlot(env: Env, workspaceId: string): Promise<InviteSlot> {
  const window = Math.floor(Date.now() / 1000 / WINDOW_SECONDS);
  const counter = env.INVITE_COUNTERS.getByName(\`invites:\${window}\`);
  const count = await counter.increment();
  const retryAfter = (window + 1) * WINDOW_SECONDS - Math.floor(Date.now() / 1000);
  return { allowed: count <= LIMIT, retryAfter };
}
`;

const rateLimitHead = `import type { Env } from "../env";

const WINDOW_SECONDS = 3600;
const LIMIT = 20;

export interface InviteSlot {
  allowed: boolean;
  /** Seconds until the window resets. */
  retryAfter: number;
}

/** A fixed window: at most LIMIT invites per workspace per hour. */
export async function takeInviteSlot(env: Env, workspaceId: string): Promise<InviteSlot> {
  const window = Math.floor(Date.now() / 1000 / WINDOW_SECONDS);
  const counter = env.INVITE_COUNTERS.getByName(\`invites:\${workspaceId}:\${window}\`);
  const count = await counter.increment();
  const retryAfter = (window + 1) * WINDOW_SECONDS - Math.floor(Date.now() / 1000);
  return { allowed: count <= LIMIT, retryAfter };
}
`;

const routeBase = `import { sendInvite } from "../invites/send-invite";
import type { Env } from "../env";

export async function postInvite(request: Request, env: Env, workspaceId: string) {
  const { email } = await request.json<{ email: string }>();
  const result = await sendInvite(env, workspaceId, email);
  return Response.json({ id: result.id }, { status: 201 });
}
`;

const routeHead = `import { sendInvite } from "../invites/send-invite";
import type { Env } from "../env";

export async function postInvite(request: Request, env: Env, workspaceId: string) {
  const { email } = await request.json<{ email: string }>();
  const result = await sendInvite(env, workspaceId, email);
  if (result.limited) {
    return Response.json(
      { error: "Too many invites. Try again later." },
      { status: 429, headers: { "Retry-After": String(result.retryAfter) } },
    );
  }
  return Response.json({ id: result.id }, { status: 201 });
}
`;

const envBase = `export interface Env {
  DB: D1Database;
  INVITE_EMAILS: Queue<{ inviteId: string }>;
}
`;

const envHead = `import type { InviteCounter } from "./invites/counter";

export interface Env {
  DB: D1Database;
  INVITE_EMAILS: Queue<{ inviteId: string }>;
  INVITE_COUNTERS: DurableObjectNamespace<InviteCounter>;
}
`;

const counterHead = `import { DurableObject } from "cloudflare:workers";

/** One counter per workspace and window. It is never read after its window ends. */
export class InviteCounter extends DurableObject {
  async increment(): Promise<number> {
    const count = (this.ctx.storage.kv.get<number>("count") ?? 0) + 1;
    this.ctx.storage.kv.put("count", count);
    return count;
  }
}
`;

const testRev1 = `import { expect, it } from "vitest";
import { takeInviteSlot } from "../../src/invites/rate-limit";
import { testEnv } from "../env";

it("allows twenty invites and refuses the twenty-first", async () => {
  const env = testEnv();
  for (let i = 0; i < 20; i++) {
    expect((await takeInviteSlot(env, "ws_1")).allowed).toBe(true);
  }
  const refused = await takeInviteSlot(env, "ws_1");
  expect(refused.allowed).toBe(false);
  expect(refused.retryAfter).toBeGreaterThan(0);
});
`;

const testHead = `${testRev1}
it("counts each workspace separately", async () => {
  const env = testEnv();
  for (let i = 0; i < 20; i++) await takeInviteSlot(env, "ws_1");
  expect((await takeInviteSlot(env, "ws_2")).allowed).toBe(true);
});
`;

const wranglerBase = `{
  "name": "atlas-web",
  "main": "src/index.ts",
  "queues": { "producers": [{ "binding": "INVITE_EMAILS", "queue": "invite-emails" }] }
}
`;

const wranglerHead = `{
  "name": "atlas-web",
  "main": "src/index.ts",
  "queues": { "producers": [{ "binding": "INVITE_EMAILS", "queue": "invite-emails" }] },
  "durable_objects": {
    "bindings": [{ "name": "INVITE_COUNTERS", "class_name": "InviteCounter" }]
  },
  "exports": { "InviteCounter": { "type": "durable-object", "storage": "sqlite" } }
}
`;

const shared = {
  "README.md": "# atlas-web\n\nThe customer portal.\n",
  ".gitflare/ci.yml": `setup: pnpm install --frozen-lockfile
steps:
  - name: typecheck
    run: pnpm typecheck
  - name: lint
    run: pnpm lint
  - name: test
    run: pnpm test
`,
  "src/invites/email.ts": `import type { Env } from "../env";

export async function queueInviteEmail(env: Env, inviteId: string) {
  await env.INVITE_EMAILS.send({ inviteId });
}
`,
};

export const demoFiles = {
  base: {
    ...shared,
    "src/env.ts": envBase,
    "src/invites/send-invite.ts": sendInviteBase,
    "src/routes/invites.ts": routeBase,
    "wrangler.jsonc": wranglerBase,
  } as Record<string, string>,
  rev1: {
    ...shared,
    "src/env.ts": envHead,
    "src/invites/counter.ts": counterHead,
    "src/invites/rate-limit.ts": rateLimitRev1,
    "src/invites/send-invite.ts": sendInviteHead,
    "src/routes/invites.ts": routeHead,
    "test/invites/rate-limit.test.ts": testRev1,
    "wrangler.jsonc": wranglerHead,
  } as Record<string, string>,
  head: {
    ...shared,
    "src/env.ts": envHead,
    "src/invites/counter.ts": counterHead,
    "src/invites/rate-limit.ts": rateLimitHead,
    "src/invites/send-invite.ts": sendInviteHead,
    "src/routes/invites.ts": routeHead,
    "test/invites/rate-limit.test.ts": testHead,
    "wrangler.jsonc": wranglerHead,
  } as Record<string, string>,
};
