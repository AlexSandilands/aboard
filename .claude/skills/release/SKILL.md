---
name: release
description: Draft the next release of this repo on GitHub, with user-facing Highlights above the generated list of changes, for the user to review and publish. Use when asked to cut, prepare, draft or write the notes for a release, or "what would go in the next release".
---

# Release: draft the next release

The user publishes releases on GitHub; publishing starts the build (docs/features/releases.md). This skill does
everything before that: picks the version, writes the notes and creates a **draft** release. It never publishes,
never pushes a tag and never edits a published release.

The desktop app reads the body of every release and shows it after an update (docs/features/desktop.md#release-notes),
so the body has a fixed shape:

```markdown
## Highlights

### New

- **Saved views in the board header.** Save the filters you use and switch between them from the header.

### Improved

- Jobs on a machine pick up where they left off after the board restarts.

### Fixed

- The tray icon stays after a theme change.

## Details

<GitHub's generated list of pull requests, grouped>
```

The app splits the body at `## Details` (or the older `## What's Changed`): what comes before is shown, the rest is
folded away. Keep the two `##` headings exactly as written and use no other `##` heading.

## Steps

1. **Read the names.** The repo and product come from the root `package.json`; never type them:

   ```sh
   node -p "const p=require('./package.json'); [p.displayName, p.repository.url].join(' ')"
   ```

   `gh` works on the current repo, so `gh api repos/{owner}/{repo}/...` fills them in.

2. **Find the last release.** The newest published `vX.Y.Z` tag. Skip drafts, prereleases and the `pacman` release
   (the Arch repo, not a version):

   ```sh
   gh release list --exclude-drafts --exclude-pre-releases --limit 20 --json tagName,isLatest
   ```

   If a draft for the next version exists already, say so and ask whether to update it instead
   (`gh release edit <tag> --notes-file`).

3. **List what merged since.** PR titles follow Conventional Commits:

   ```sh
   gh pr list --state merged --base main --search "merged:>$(gh release view <last> --json publishedAt -q .publishedAt)" \
     --limit 200 --json number,title,labels,body
   ```

4. **Suggest the version**, by the rules in docs/features/releases.md (Cutting a release): patch for fixes only,
   minor when something was added (`feat`), major when something people or agents rely on breaks (an MCP tool or
   argument removed, a `!` after the type, `BREAKING CHANGE` in a body). Say which PRs decided it.

5. **Get the Details.** GitHub generates them, grouped by `.github/release.yml`:

   ```sh
   gh api repos/{owner}/{repo}/releases/generate-notes -f tag_name=v<next> -f target_commitish=main \
     -f previous_tag_name=<last> -q .body
   ```

   Pass `previous_tag_name` every time: GitHub would otherwise pick its own, sometimes `pacman`. Drop the
   generator's own `## What's Changed` heading. Most PRs carry no label, so everything lands in "Other changes":
   move each line under `### Features` (`feat`), `### Fixes` (`fix`) or `### Other changes` by its title's type,
   keeping the lines as GitHub wrote them, and keep the `**Full Changelog**` line at the end.

6. **Draft the Highlights** from the PRs (titles, bodies, linked tasks), for someone who uses the app, not someone
   who reads the code:
   - Group under `### New`, `### Improved` and `### Fixed`, leaving out a group with nothing in it.
   - One bullet per change a user would notice; fold small related PRs into one bullet. Leave out refactors, CI,
     docs, tests and dependency bumps.
   - Lead a New bullet with what it is in bold, then one sentence on what it lets you do. Plain words, no PR
     numbers, no type prefixes, no internal names (tool, file or component names).
   - A release with nothing user-facing gets a one-line Highlights saying so ("Fixes and upkeep; nothing new to
     try."), not an empty section.

7. **Show the whole body to the user** (both parts, as it will be published) with the version and why, and ask
   for changes. Don't create anything until they approve.

8. **Create the draft** from a file in your scratchpad:

   ```sh
   gh release create v<next> --draft --target main --title "<displayName> v<next>" --notes-file <file>
   ```

   The title follows the earlier releases ("Aboard v0.11.0"), with the name from step 1.

9. **Hand over** the draft's URL (`gh release view v<next> --json url -q .url`) and what's left to the user: read it
   on GitHub, tick **Set as the latest release**, and **Publish release**. Publishing creates the tag and starts the
   build.

## Rules

- Never publish, never `git push` a tag, never use `--latest` or edit a published release: publishing is the
  user's step, and it ships the app.
- The tag is `v` and three numbers, nothing after them (scripts/release-version.ts refuses anything else).
- The Details are GitHub's text. Reorder them, don't rewrite them: the Highlights are where the wording is yours.
