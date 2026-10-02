#!/bin/sh
# Prepares the workspace every CI run and hosted session starts from.
#
# The forge runs on Cloudflare's managed base image, so deploying it needs no
# Docker. That image has no git. This script is run once, in a container with
# Internet access, and the result is saved as a snapshot; every sandbox after
# that starts from the snapshot, offline, in about half a second.
#
# It must leave the container with: git, the runtimes CI steps need, the coding
# agent, and the Entire CLI with its hooks installed. Build task: `sandbox`.
# Facts: spec/research/sandbox-ci.md and spec/research/live/container-git.md.
set -eu
echo "not implemented: workspace setup" >&2
exit 1
