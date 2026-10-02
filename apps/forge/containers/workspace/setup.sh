#!/bin/sh
# Prepares the workspace every CI run and hosted session starts from.
#
# The forge runs on Cloudflare's managed base image, so deploying it needs no
# Docker. That image is Node on Debian and has no git. This script is run once,
# as root, in a container with Internet access, and the result is saved as a
# snapshot; every sandbox after that starts from the snapshot, offline, in
# about half a second.
#
# It leaves the container with: git, the runtimes CI steps need, the coding
# agent, and the Entire CLI. Nothing here may write a credential to disk: a
# snapshot carries whatever was written.
# Facts: spec/research/sandbox-ci.md and spec/research/live/container-git.md.
set -eu

# Pinned: the agent's flags and event format change between releases, and the
# capture format is tied to the CLI that wrote it. pnpm to the release too: a
# major alone is whatever was newest the day the workspace was prepared.
CLAUDE_CODE_VERSION=2.1.280
ENTIRE_VERSION=0.11.3
PNPM_VERSION=11.12.0

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y --no-install-recommends \
	bash ca-certificates curl git jq procps python3 ripgrep unzip xz-utils
rm -rf /var/lib/apt/lists/*

npm install --global --no-audit --no-fund \
	"@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "pnpm@${PNPM_VERSION}"

# The Entire CLI is one static binary per platform, published with checksums.
arch=$(dpkg --print-architecture)
archive="entire_linux_${arch}.tar.gz"
release="https://github.com/entireio/cli/releases/download/v${ENTIRE_VERSION}"
scratch=$(mktemp -d)
curl -fsSL -o "${scratch}/checksums.txt" "${release}/checksums.txt"
curl -fsSL -o "${scratch}/${archive}" "${release}/${archive}"
(cd "${scratch}" && grep " ${archive}\$" checksums.txt | sha256sum -c -)
tar -xzf "${scratch}/${archive}" -C "${scratch}"
install -m 0755 "${scratch}/entire" /usr/local/bin/entire
rm -rf "${scratch}"

# Entire's hooks are per repository: the agent's are committed to the main
# repository, and the first prompt in a clone installs git's. Only the binary
# has to be here.

# Every process in a sandbox is root, whoever owns the checkout.
git config --system safe.directory '*'
git config --system init.defaultBranch main

mkdir -p /workspace

# Fail the preparation, not the first CI run, if something is missing.
for tool in git node npm pnpm claude entire rg jq python3; do
	command -v "${tool}" >/dev/null || {
		echo "workspace setup: ${tool} is not on PATH" >&2
		exit 1
	}
done
git --version
node --version

sync
