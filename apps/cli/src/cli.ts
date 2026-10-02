#!/usr/bin/env node
import { run } from "./run.ts";
import { createSystemContext } from "./system.ts";

process.exitCode = await run(createSystemContext(), process.argv.slice(2));
