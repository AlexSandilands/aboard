# Releases

Publishing a release on GitHub builds the desktop app for Windows and Linux, attaches the installers to the
release, and updates the board's own pacman repo for Arch Linux. Nothing is built or published from a developer's
machine.

## How it works

### Cutting a release

1. On GitHub, **Releases → Draft a new release**.
2. **Choose a tag** and type a new one named for today's date, with no leading zeros: `v2026.10.21`, or
   `v2026.10.5` rather than `v2026.10.05`. Target `main`.
3. **Generate release notes**, edit them if you like, and **Publish release**. If the generator offers the
   `pacman` release as the previous tag, pick the last dated one instead.

Publishing starts `.github/workflows/release.yml`. When it finishes, the release has:

| File                                             | For                                                 |
| ------------------------------------------------ | --------------------------------------------------- |
| `Aboard-Setup-<version>.exe`                     | Windows: per-user installer, no admin rights needed |
| `Aboard-<version>-x86_64.AppImage`               | Any Linux distro: `chmod +x` and run                |
| `aboard_<version>_amd64.deb`                     | Debian, Ubuntu, Mint                                |
| `aboard-<version>.x86_64.rpm`                    | Fedora, openSUSE                                    |
| `aboard-<version>-linux-x64.tar.gz`              | The unpacked app; the Arch package installs this    |
| `SHA256SUMS-windows.txt`, `SHA256SUMS-linux.txt` | Checksums of the files above                        |

and the pacman repo serves the new version, so `pacman -Syu` picks it up.

### Versions

A release's version is its tag without the `v`. `scripts/release-version.ts` checks the tag is a real date
in that form and writes the version into the root `package.json` on the runner only; the committed version stays
`0.1.0`, which marks a build from source. BRAND reads it from there, so the app's health endpoint, the installer
names and the Arch package all agree.

A tag that isn't a date (`v1.2`, `v2026.10.05`, `v2026.2.30`) fails the build before anything is packaged. Delete
the release and its tag, and publish again with a valid one.

### The workflow

`package` runs on `windows-latest` and `ubuntu-latest` side by side. Each checks out the tag, stamps the
version, runs `pnpm desktop:package` (which builds the targets for the runner's OS, see
`apps/desktop/scripts/package.ts`) and uploads the results with `gh release upload --clobber`. Ubuntu
installs `rpm` first, for rpmbuild.

Once both have finished, `pacman` and `aur` update the Arch packages from the release's Linux tarball, each
skipping with a notice when its secret is missing. The release itself is unaffected either way.

The release doesn't run `pnpm check`: CI already ran it on the commit when it reached `main`.

To rebuild a release's files, for example after a runner failure: **Actions → Release → Run workflow** with
its tag. Uploads replace files of the same name. The pacman job won't move the repo back to an older version,
and the AUR step does nothing when the package already has that version and checksum.

### The pacman repo

The repo is a GitHub release of its own, tagged `pacman` and marked as a pre-release so it's never "Latest". Its
files are what pacman fetches from a `Server`:

| File                                 | What                                           |
| ------------------------------------ | ---------------------------------------------- |
| `aboard.db`, `aboard.files`          | The repo database, listing only the newest package |
| `aboard-<version>-1-x86_64.pkg.tar.zst` | The package                                 |
| `*.sig`                              | A detached signature for each of the above     |

The `pacman` job runs in an `archlinux:base-devel` container. `.github/scripts/pacman-repo.sh` writes the
`PKGBUILD` (`scripts/arch-package.ts`, package name `aboard`), builds it with makepkg from the downloaded
tarball, signs the package and a fresh database with `repo-add --sign`, and checks every signature. The job then
creates the `pacman` release if it doesn't exist, uploads the package before the database that lists it, and
deletes the previous version's files.

Everything is signed with a key that exists only for this repo, held in the `PACMAN_GPG_PRIVATE_KEY` secret.
Its public half is `packaging/pacman-signing-key.asc`, fingerprint
`FB7D A6AA C8D1 5679 BE55 1C58 71CE 5664 96A2 6F6B`. With the key trusted, pacman refuses a package or database
that the key didn't sign, so the files in the release can't be swapped without the secret.

To try a change to the script before a release, run it in a container the way CI does, from the repo root and
with a tarball from `pnpm desktop:package tar.gz`:

```sh
docker run --rm -v "$PWD":/src:ro -v /tmp/repo:/out -e PACMAN_GPG_PRIVATE_KEY="$(cat private.asc)" \
  archlinux:base-devel bash -c 'pacman -Syu --noconfirm nodejs && cd /src &&
  .github/scripts/pacman-repo.sh 0.1.0 apps/desktop/release/aboard-0.1.0-linux-x64.tar.gz /out'
```

Any throwaway key works (`gpg --quick-generate-key test ed25519 sign never`).

### The AUR package

The `aur` job pushes the same package as `aboard-bin` (which `provides` and `conflicts` with `aboard`) to
`ssh://aur@aur.archlinux.org/aboard-bin.git`. It writes `PKGBUILD` and `.SRCINFO` with `scripts/arch-package.ts`
and needs the `AUR_SSH_PRIVATE_KEY` secret, an SSH key on an AUR account (**My Account → SSH Public Key**). The
AUR's host key is pinned in the workflow. No AUR account exists yet, so the job skips.

After changing `scripts/arch-package.ts`, check that its `.SRCINFO` still matches what makepkg derives from the
`PKGBUILD`, on an Arch machine with a tarball from `pnpm desktop:package tar.gz`:

```sh
node scripts/arch-package.ts aboard-bin 0.1.0 "$(sha256sum apps/desktop/release/*-linux-x64.tar.gz | cut -d' ' -f1)" /tmp/aur
cp apps/desktop/release/*-linux-x64.tar.gz /tmp/aur/ && cd /tmp/aur
diff <(makepkg --printsrcinfo) .SRCINFO && makepkg -f   # no diff, then a package that builds
```

### What both Arch packages install

The tarball, with its own Electron, goes in `/opt/aboard`, plus `/usr/bin/aboard`, a desktop entry, the SVG
icon in the hicolor theme and the license. The dependencies are the libraries the bundled Electron links
against: the same set as the .deb, plus `alsa-lib`, which a minimal Arch install lacks.

## Decisions

- **Releases start from GitHub's release page.** Writing the notes, choosing the tag and publishing happen in
  one place, and the notes come from GitHub's generator. The cost is that the release is visible for a few
  minutes before its files are attached.
- **Date versions, one release a day.** `vYYYY.M.D` says when a build is from. Without leading zeros it is
  valid semver, which electron-builder requires, and a valid pacman version. A second release on the same day
  has to wait for the next day's tag.
- **The version lives in the tag, not in a commit.** Nothing has to be bumped and merged before a release.
- **Our own pacman repo, hosted in a release.** The AUR wasn't taking new accounts. A release holds files of
  any size without growing the git history, which 100 MB packages on a `gh-pages` branch would. The repo keeps
  only the newest version, so there's no downgrading through pacman.
- **A signed repo.** pacman expects signatures, and a key only CI holds means a compromised GitHub session
  alone can't ship a package. The cost is one `pacman-key` step per machine.
- **Packages with their own Electron.** They run exactly the Electron that CI built and tested, and install in
  seconds. Arch's `electron` packages move to new versions on their own schedule.
- **The AUR's .SRCINFO written in Node, not by makepkg.** The AUR job then needs no Arch container, and it's
  covered by the makepkg check above instead.
- **The installer isn't signed.** Signing needs a paid certificate; until then SmartScreen warns on first run.

## Alternatives considered

| Option                                            | Why not chosen                                                                                        |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Release on pushing a tag, with a draft made by CI | Two steps (tag, then edit the draft) instead of one page                                              |
| Building Windows on Linux with Wine               | Saves a runner but needs Wine for the executable's icon and version info, and isn't tested on Windows |
| `YYYY.M.N`, a counter within the month            | Any number of releases a day, but the version no longer says the date                                 |
| The pacman repo on GitHub Pages                   | Pages serves a branch, so every package would stay in the git history                                 |
| An unsigned pacman repo (`SigLevel = Never`)      | No key to manage, but pacman would install whatever is at the URL                                     |
| An Arch package built from source                 | Every install would download the dependencies and build the web app; slow, and not what CI tested     |

## Code map

| File                                 | What it does                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------- |
| `.github/workflows/release.yml`      | Packages on Windows and Linux, uploads to the release, updates pacman and the AUR |
| `.github/scripts/pacman-repo.sh`     | Builds and signs the pacman repo's package and database                          |
| `packaging/pacman-signing-key.asc`   | The public key the repo is signed with                                           |
| `scripts/release-version.ts`         | Checks the tag and stamps the version into `package.json`                        |
| `scripts/arch-package.ts`            | Writes the Arch `PKGBUILD` and `.SRCINFO`, for either package name               |
| `apps/desktop/scripts/package.ts`    | electron-builder config and the targets for each OS                              |
