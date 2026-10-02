#!/usr/bin/env node

// create-gitflare: asks its questions, creates every resource the forge
// needs in the user's own Cloudflare account, and deploys a prebuilt release.
// `--dry-run` prints the plan and touches nothing. Build task: `installer`.
// Facts it rests on: spec/research/installer.md.

const dryRun = process.argv.includes("--dry-run");
process.stderr.write(
  `create-gitflare: not implemented${dryRun ? " (the dry run prints the install plan)" : ""}\n`,
);
process.exitCode = 1;
