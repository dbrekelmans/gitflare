# Working on gitflare

Gitflare is an open-source, agent-native git forge that an organisation deploys to its own Cloudflare account. This repository is **public**.

## Where the context is

- `CONTEXT.md` and everything under `docs/` — private working notes, gitignored, copied into your worktree. Start with `CONTEXT.md`, `docs/concept.md` and `docs/research.md`. The MVP is the set of `docs/concept.md` entries marked "decided 2026-10-02"; everything listed as deferred there is out of scope. Never commit anything from `CONTEXT.md` or `docs/`, and never paste their strategy or competitor analysis into tracked files.
- `spec/architecture.md` — the tracked system design: package ownership, contracts, data model. Once it exists it outranks your own preferences; if it is wrong, say so in your task comment rather than silently diverging.
- `spec/research/` — tracked, dated, source-linked facts about the Cloudflare APIs this is built on (present once the research tasks have merged).
- `docs/mvp/design/` — the style guide screenshots and logo. The design source of truth is the Paper file (Paper MCP tools); in code it is `packages/ui`.

## Cloudflare APIs postdate your training data

Artifacts, Sandbox SDK 1.0, `@cloudflare/ci`, Worker Previews and much of AI Gateway are newer than what you remember. Before writing code against one, check `spec/research/` and the live docs (the `search_cloudflare_documentation` MCP tool where your thread has it, otherwise fetch developers.cloudflare.com directly). Do not write a signature from memory. When something cannot be verified, keep it behind a port/interface, and list it under "Unverified" in your task comment.

## Hard limits

- Do not deploy, and do not create, modify or delete resources in any Cloudflare account.
- Do not open issues or pull requests on repositories other than `dbrekelmans/gitflare`.
- Never push to `main`, never merge a pull request, never force-push, never pass `--no-verify`, never `git add -f`. To pick up changes from `main`, merge it into your branch rather than rebasing.
- Do not touch files outside the paths your task owns. If you need a change elsewhere (a shared contract, a root config), make the smallest possible edit and call it out in the PR description.

## Delivering a task

1. Work on the branch of your worktree. Commit in small, coherent steps.
2. Run the checks your task names (at minimum typecheck and tests for what you touched). Report failures as failures, with the output.
3. Push the branch and open a pull request against `main` with `gh pr create`; the title starts with the task key (e.g. `GF-12: …`). `git commit` (commits are signed through the 1Password agent socket), `git push` and `gh` all fail inside the command sandbox. The project owner has authorised exactly three things outside the sandbox for this repository: `git commit`, `git push origin <your branch>`, and `gh pr create` / `gh pr view` / `gh pr edit` on your own pull request. Run those, and nothing else, outside the sandbox; never disable commit signing to get around it. If they are still refused, leave the work in the worktree and put the worktree's absolute path and branch name in your task comment so it is not lost.
4. Do not merge. The orchestrating thread reviews and merges.
5. Post one task comment: what was built, what validation ran and its result, what is unverified or risky. Then set the task to `in_review`.

## Design rules that apply to every screen

- One accent (flare orange); status colours are never a second accent. Neutrals are warm, not grey.
- Two type families. Monospace marks content a machine authored or verified — never decoration, never an eyebrow label.
- Claim on the left, evidence on the right; the right column is narrower and quieter.
- Hairlines, not boxes. Exactly one elevated surface per view (the floating card); no other shadows, glows, or gradients.
- Avoid template patterns: rows of identical bordered cards, icons in tinted circles, paired pill buttons, blocks with a rounded left accent bar, centred-everything layouts.
