#!/bin/sh
# usage: scripts/run.sh BOX SCRIPT_FILE [stream]  — runs a shell script inside the box's container.
# EXTRA_ENV='{"REPO":"..."}' adds variables. $H inside the script is the Artifacts git host; it is read from .env and never committed.
cd "$(dirname "$0")/.." || exit 1
. ./.env
box=$1; file=$2; op=${3:-exec}
body=$(node -e 'console.log(JSON.stringify({cmd: require("fs").readFileSync(process.argv[1],"utf8"), env: {H: process.argv[2], ...JSON.parse(process.env.EXTRA_ENV || "{}")}}))' "$file" "$ARTIFACTS_HOST")
scripts/call.sh POST "/box/$box/$op" "$body" 2>&1 | node -e '
let s=require("fs").readFileSync(0,"utf8").replace(/[0-9a-f]{32}(?=\.artifacts)/g,"<account-id>");
const i=s.lastIndexOf("\nHTTP "); try { const r=JSON.parse(s.slice(0,i)); if (r.stdout!==undefined) { console.log(r.stdout.trimEnd()); if (r.stderr) console.log("--- stderr ---\n"+r.stderr.trimEnd()); console.log(`--- exit=${r.exitCode} ms=${r.ms}`); } else console.log(JSON.stringify(r)); } catch { console.log(s.slice(0,i)); }
console.log(s.slice(i+1).trim());'
