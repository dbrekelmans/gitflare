// @gitflare/sessions — hosted sessions: the same coding agent a developer runs
// locally, in a sandbox on the deployment's own account. The workspace image
// carries the agent and the capture client with hooks installed, so a cloud
// session produces the same commits, trailers and checkpoints as a local one
// and everything after the push is identical. Model calls and git leave the
// sandbox only through egress grants. Build task: `cloud-sessions`.

export { agentCommand } from "./agent";
export { createCloudSessions, type SessionsDeps } from "./cloud-sessions";
export { parseAgentEvents } from "./events";
