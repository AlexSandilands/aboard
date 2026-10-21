# Releases

Publishing a release on GitHub builds the desktop app for Windows and Linux, attaches the installers to the
release and updates the AUR package. Nothing is built or published from a developer's machine.

## How it works

### Cutting a release

1. On GitHub, **Releases → Draft a new release**.
2. **Choose a tag** and type a new one named for today's date, with no leading zeros: `v2026.10.21`, or
   `v2026.10.5` rather than `v2026.10.05`. Target `main`.
3. **Generate release notes**, edit them if you like, and **Publish release**.

Publishing starts `.github/workflows/release.yml`. When it finishes, the release has:

| File                                    | For                                                       |
| --------------------------------------- | --------------------------------------------------------- |
| `Aboard-Setup-<version>.exe`            | Windows: per-user installer, no admin rights needed       |
| `Aboard-<version>-x86_64.AppImage`      | Any Linux distro: `chmod +x` and run                      |
| `aboard_<version>_amd64.deb`            | Debian, Ubuntu, Mint                                      |
| `aboard-<version>.x86_64.rpm`           | Fedora, openSUSE                                          |
| `aboard-<version>-linux-x64.tar.gz`     | The unpacked app; the AUR package installs this           |
| `SHA256SUMS-windows.txt`, `SHA256SUMS-linux.txt` | Checksums of the files above                     |

and the AUR has `aboard-bin` at the new version, so `paru -Syu` picks it up.

### Versions

A release's version is its tag without the `v`. `scripts/release-version.ts` checks the tag is a real date
in that form and writes the version into the root `package.json` on the runner only; the committed version stays
`0.1.0`, which marks a build from source. BRAND reads it from there, so the app's health endpoint, the installer
names and the AUR package all agree.

A tag that isn't a date (`v1.2`, `v2026.10.05`, `v2026.2.30`) fails the build before anything is packaged. Delete
the release and its tag, and publish again with a valid one.

### The workflow

`package` runs on `windows-latest` and `ubuntu-latest` side by side. Each checks out the tag, stamps the
version, runs `pnpm desktop:package` (which builds the targets for the runner's OS, see
`apps/desktop/scripts/package.ts`) and uploads the results with `gh release upload --clobber`. Ubuntu
installs `rpm` first, for rpmbuild.

`aur` runs once both have finished. It downloads the Linux tarball from the release, writes `PKGBUILD` and
`.SRCINFO` for that version and the tarball's checksum (`scripts/aur-package.ts`) and pushes them to
`ssh://aur@aur.archlinux.org/aboard-bin.git`. The AUR's host key is pinned in the workflow. Without the
`AUR_SSH_PRIVATE_KEY` secret the job logs a notice and skips; the release itself is unaffected.

The release doesn't run `pnpm check`: CI already ran it on the commit when it reached `main`.

To rebuild a release's files, for example after a runner failure: **Actions → Release → Run workflow** with
its tag. Uploads replace files of the same name, and the AUR step does nothing when the package already has
that version and checksum.

### The AUR package

`aboard-bin` repackages the release tarball: the app, with its own Electron, goes in `/opt/aboard`, with
`/usr/bin/aboard`, a desktop entry, the SVG icon in the hicolor theme and the license. Its dependencies are the
libraries the bundled Electron links against, the same set as the .deb.

After changing `scripts/aur-package.ts`, check that its `.SRCINFO` still matches what makepkg derives from the
`PKGBUILD`, on an Arch machine with a tarball from `pnpm desktop:package tar.gz`:

```sh
node scripts/aur-package.ts 0.1.0 "$(sha256sum apps/desktop/release/*-linux-x64.tar.gz | cut -d' ' -f1)" /tmp/aur
cp apps/desktop/release/*-linux-x64.tar.gz /tmp/aur/ && cd /tmp/aur
diff <(makepkg --printsrcinfo) .SRCINFO && makepkg -f   # no diff, then a package that builds
```

### One-time setup

- **The repo must be public.** The AUR package, and anyone downloading an installer without signing in,
  fetch the files anonymously from the release.
- **An AUR account** with an SSH key on it (**My Account → SSH Public Key**). Use a key made for this, not a
  personal one, then add its private half as the repo secret `AUR_SSH_PRIVATE_KEY`
  (**Settings → Secrets and variables → Actions**). The first release then creates `aboard-bin` on the AUR.

## Decisions

- **Releases start from GitHub's release page.** Writing the notes, choosing the tag and publishing happen in
  one place, and the notes come from GitHub's generator. The cost is that the release is visible for a few
  minutes before its files are attached.
- **Date versions, one release a day.** `vYYYY.M.D` says when a build is from. Without leading zeros it is
  valid semver, which electron-builder requires, and a valid pacman version. A second release on the same day
  has to wait for the next day's tag.
- **The version lives in the tag, not in a commit.** Nothing has to be bumped and merged before a release.
- **A `-bin` AUR package with its own Electron.** It runs exactly the Electron that CI built and tested, and
  installs in seconds. Arch's `electron` packages move to new versions on their own schedule.
- **.SRCINFO written in Node, not by makepkg.** The AUR job then needs no Arch container, and it's covered by
  the makepkg check above instead.
- **The installer isn't signed.** Signing needs a paid certificate; until then SmartScreen warns on first run.

## Alternatives considered

| Option                                       | Why not chosen                                                                                |
| -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Release on pushing a tag, with a draft made by CI | Two steps (tag, then edit the draft) instead of one page                                 |
| Building Windows on Linux with Wine          | Saves a runner but needs Wine for the executable's icon and version info, and isn't tested on Windows |
| `YYYY.M.N`, a counter within the month       | Any number of releases a day, but the version no longer says the date                        |
| An AUR package built from source             | Every install would download the dependencies and build the web app; slow, and not what CI tested |

## Code map

| File                                 | What it does                                                         |
| ------------------------------------ | -------------------------------------------------------------------- |
| `.github/workflows/release.yml`      | Packages on Windows and Linux, uploads to the release, updates the AUR |
| `scripts/release-version.ts`         | Checks the tag and stamps the version into `package.json`            |
| `scripts/aur-package.ts`             | Writes the AUR package's `PKGBUILD` and `.SRCINFO`                   |
| `apps/desktop/scripts/package.ts`    | electron-builder config and the targets for each OS                  |
