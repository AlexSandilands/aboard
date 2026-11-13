# Releases

Publishing a release on GitHub builds the desktop app for Windows and Linux, attaches the installers to the
release, and updates the board's own pacman repo for Arch Linux. Nothing is built or published from a developer's
machine.

## How it works

### Cutting a release

1. On GitHub, **Releases → Draft a new release**.
2. **Choose a tag** and type the next version, `vMAJOR.MINOR.PATCH`: `v1.4.2`. Target `main`. Which number to
   raise, from the last release:
   - **patch** (`v1.4.2` → `v1.4.3`) for fixes only;
   - **minor** (`v1.5.0`) when it adds something;
   - **major** (`v2.0.0`) when it breaks something people or agents rely on: an MCP tool or argument removed, a
     setting that has to be redone.
3. **Generate release notes**, edit them if you like, and **Publish release**. If the generator offers the
   `pacman` release as the previous tag, pick the last version instead.

Publishing starts `.github/workflows/release.yml`. When it finishes, the release has:

| File                                             | For                                                 |
| ------------------------------------------------ | --------------------------------------------------- |
| `Aboard-Setup-<version>.exe`                     | Windows: per-user installer, no admin rights needed |
| `Aboard-<version>-x86_64.AppImage`               | Any Linux distro: `chmod +x` and run                |
| `aboard_<version>_amd64.deb`                     | Debian, Ubuntu, Mint                                |
| `aboard-<version>.x86_64.rpm`                    | Fedora, openSUSE                                    |
| `aboard-<version>-linux-x64.tar.gz`              | The unpacked app; the Arch package installs this    |
| `SHA256SUMS-windows.txt`, `SHA256SUMS-linux.txt` | Checksums of the files above                        |
| `Aboard-Setup-<version>.exe.blockmap`            | Lets the Windows updater fetch only changed blocks  |
| `latest.yml`, `latest-linux.yml`                 | The update feed the installed app reads             |

and the pacman repo serves the new version, so `pacman -Syu` picks it up.

### Versions

A release's version is its tag without the `v`. `scripts/release-version.ts` checks the tag is three numbers
with no leading zeros and nothing after them, and writes the version into the root `package.json` on the runner
only; the committed version stays `0.0.0`, which marks a build from source (the app checks for no updates then,
and `v0.0.0` is refused as a tag). BRAND reads it from there, so the app's health endpoint, the installer names
and the Arch package all agree.

Any other tag (`v1.2`, `v1.02.0`, `v1.2.0-rc.1`, `v1.2.0+1`) fails the build before anything is packaged. Delete
the release and publish again with a valid tag. Release tags can't be deleted or moved while the release tags
ruleset is on ([GitHub setup](github-setup.md#the-release-tags-ruleset)), so the bad tag stays unless you switch it
off first.

The check only looks at the tag's form: it doesn't know the last release, so nothing stops a version lower than
it. The installed apps and pacman would ignore such a release, and the pacman job leaves its repo alone, but
the AUR job has no such check and would set the AUR package to it.

The first releases, `v0.1.0` to `v0.8.0`, were published with date tags (`v2026.10.21` to `v2026.11.13`) and
renamed afterwards; their files still carry the date version
([Switching from date versions](#switching-from-date-versions)).

### The workflow

`package` runs on `windows-latest` and `ubuntu-latest` side by side. Each checks out the tag, stamps the
version, runs `pnpm desktop:package` (which builds the targets for the runner's OS, see
`apps/desktop/scripts/package.ts`) and uploads the results with `gh release upload --clobber`. Ubuntu
installs `rpm` first, for rpmbuild.

Each job uploads in two steps: the installers, the Windows blockmap and the checksums first, then the update
feed (`latest.yml` on Windows, `latest-linux.yml` on Linux). An installed app that reads the feed mid-upload
then finds every file it names already there; one that checks before the feed is up sees the previous version,
or a 404 on the very first release, and tries again within the hour. The checksums cover the installers only.
The AppImage carries its blockmap inside it, so Linux uploads none.

electron-builder writes the feed because `package.ts` gives it a `github` publish config, with the owner and repo
read from the root `package.json` `repository`; it also writes `resources/app-update.yml` into the app, which
is where the updater looks. It never uploads anything itself (`publish: "never"`). How the app uses the feed:
[desktop](desktop.md#updates).

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
| `install-arch.sh`                    | The script users run to add the repo ([below](#the-install-script)) |

The `pacman` job runs in an `archlinux:base-devel` container. `.github/scripts/pacman-repo.sh` writes the
`PKGBUILD` (`scripts/arch-package.ts`, package name `aboard`), builds it with makepkg from the downloaded
tarball, signs the package and a fresh database with `repo-add --sign`, checks every signature, and copies
`packaging/install-arch.sh` in beside them. The job then creates the `pacman` release if it doesn't exist, uploads
the package before the database that lists it, then the install script, and deletes every asset the script's out
folder doesn't hold: the previous version's files. A file the release should serve therefore has to be put in that
folder by `pacman-repo.sh`, or the next release deletes it.

Everything is signed with a key that exists only for this repo, held in the `PACMAN_GPG_PRIVATE_KEY` secret of
the `release` environment, which only `main` and `v*` tags can deploy to
([GitHub setup](github-setup.md#ci-that-the-rules-rely-on)).
Its public half is `packaging/pacman-signing-key.asc`, fingerprint
`FB7D A6AA C8D1 5679 BE55 1C58 71CE 5664 96A2 6F6B`. With the key trusted, pacman refuses a package or database
that the key didn't sign, so the files in the release can't be swapped without the secret.

To try a change to the script before a release, run it in a container the way CI does, from the repo root and
with a tarball from `pnpm desktop:package tar.gz`:

```sh
docker run --rm -v "$PWD":/src:ro -v /tmp/repo:/out -e PACMAN_GPG_PRIVATE_KEY="$(cat private.asc)" \
  archlinux:base-devel bash -c 'pacman -Syu --noconfirm nodejs && cd /src &&
  .github/scripts/pacman-repo.sh 0.0.0 apps/desktop/release/aboard-0.0.0-linux-x64.tar.gz /out'
```

Any throwaway key works (`gpg --quick-generate-key test ed25519 sign never`).

### The install script

`packaging/install-arch.sh` is what the README tells Arch users to run: download it from the `pacman` release, then
`sudo bash install-arch.sh`. It takes no arguments and reads no environment variables. In order:

1. Checks it is root and that `pacman`, `pacman-key`, `pacman-conf`, `curl` and `gpg` exist.
2. Checks the repo config before changing anything, and stops if `/etc/pacman.conf` has a `[aboard]` section, if a
   file it includes defines one, or if `/etc/pacman.d/aboard.conf` exists with other content. A second section of
   the same name would be merged with ours, its `SigLevel` and servers included, so the script doesn't guess: it
   says how to switch and that the existing setup keeps working.
3. Downloads `packaging/pacman-signing-key.asc` from `main` and reads it in a throwaway keyring. Unless the file
   holds exactly one key with the fingerprint pinned in the script, it stops with nothing changed.
4. `pacman-key --init`, `--add` and `--lsign-key`.
5. Writes `/etc/pacman.d/aboard.conf` (`SigLevel = Required DatabaseRequired`) and appends
   `Include = /etc/pacman.d/aboard.conf` to `/etc/pacman.conf`, unless the line is already there.
6. `pacman -Syu --needed aboard`, with pacman's prompts.

A second run finds its own file and `Include` line and changes nothing.

The script is a file users download by itself, so the repo name, the GitHub URL and the fingerprint are written
into it. `scripts/install-arch.test.ts` holds the first two to `package.json`, and the container test holds the
fingerprint to the key file. After replacing the signing key, change `key_fingerprint` in the script and the
fingerprints in the README in the same PR.

It reaches the `pacman` release only when a release is published, from that release's tag: a change to it on `main`
isn't served until the next release.

To test it, run the container test from the repo root. It runs the refusals, then installs the package the
published repo serves and runs the script a second time:

```sh
docker run --rm -v "$PWD":/src:ro -w /src archlinux:base-devel .github/scripts/install-arch-test.sh
```

`.github/workflows/arch-install.yml` runs that and shellcheck on a PR that touches `packaging/` or
`.github/scripts/`, and by hand (**Actions → Arch install → Run workflow**) to check a release. It isn't a required
check: it installs from the live repo, so it can fail for reasons a PR didn't cause.

### The AUR package

The `aur` job pushes the same package as `aboard-bin` (which `provides` and `conflicts` with `aboard`) to
`ssh://aur@aur.archlinux.org/aboard-bin.git`. It writes `PKGBUILD` and `.SRCINFO` with `scripts/arch-package.ts`
and needs the `AUR_SSH_PRIVATE_KEY` secret, an SSH key on an AUR account (**My Account → SSH Public Key**). The
AUR's host key is pinned in the workflow. No AUR account exists yet, so the job skips.

After changing `scripts/arch-package.ts`, check that its `.SRCINFO` still matches what makepkg derives from the
`PKGBUILD`, on an Arch machine with a tarball from `pnpm desktop:package tar.gz`:

```sh
node scripts/arch-package.ts aboard-bin 0.0.0 "$(sha256sum apps/desktop/release/*-linux-x64.tar.gz | cut -d' ' -f1)" /tmp/aur
cp apps/desktop/release/*-linux-x64.tar.gz /tmp/aur/ && cd /tmp/aur
diff <(makepkg --printsrcinfo) .SRCINFO && makepkg -f   # no diff, then a package that builds
```

### What both Arch packages install

The tarball, with its own Electron, goes in `/opt/aboard`, plus `/usr/bin/aboard`, a desktop entry, the SVG
icon in the hicolor theme and the license. The dependencies are the libraries the bundled Electron links
against: the same set as the .deb, plus `alsa-lib`, which a minimal Arch install lacks.

### Switching from date versions

The first eight releases were named for their date, `v2026.10.21` to `v2026.11.13`. Every date version sorts
above every semver version (`2026.11.13` > `1.0.0`), so nothing moves from one to the other by itself:

- **The date tags were renamed.** The eight dated releases count as 0.1 to 0.8, so semver started at `v0.9.0`.
  Afterwards each was moved to a new tag on the same commit (`v2026.10.21` became `v0.1.0`, up to `v2026.11.13`
  as `v0.8.0`), its title and notes updated to match, and the old tag deleted with the release tags ruleset
  switched off for the run. Their files keep the date names and versions, and links with the old tags 404.
- **The pacman repo was restarted.** `aboard.db` was deleted from the `pacman` release by hand before the first
  semver release, so the job's "won't go back a version" check found no current version and published. A
  machine on a date version takes the semver package once with `sudo pacman -Sy aboard`, which warns of a
  downgrade and installs it; after that `pacman -Syu` works as before.
- **An app installed from a date release isn't offered the semver ones.** Its updater compares versions the same
  way. Install the newer release by hand once (the installer, AppImage or package from the release page).
- **Rebuilding one of them** with the workflow builds it afresh as its `v0.x` version and adds those files next
  to the dated ones. The pacman job leaves its repo alone, as the version is older than the current one; the AUR
  job has no such check.
- **GitHub's "Latest" badge** can go by version too. When publishing the first semver release, check **Set as
  the latest release** is ticked: the update feed is read from the latest release.

## Decisions

- **Releases start from GitHub's release page.** Writing the notes, choosing the tag and publishing happen in
  one place, and the notes come from GitHub's generator. The cost is that the release is visible for a few
  minutes before its files are attached.
- **Semver versions, three numbers only.** `vMAJOR.MINOR.PATCH` allows any number of releases a day, so an
  urgent fix is a patch release rather than a wait for tomorrow's tag, and electron-builder requires semver
  anyway. No pre-release or build suffix: pacman can't take a `-` in a version, and would sort a pre-release
  differently than semver does. The cost is that the version no longer says when a build is from.
- **`0.0.0` marks a build from source.** It is the one version that can't be a release, so a first release of
  `v0.1.0` is as good as `v1.0.0`.
- **The version lives in the tag, not in a commit.** Nothing has to be bumped and merged before a release.
- **Our own pacman repo, hosted in a release.** The AUR wasn't taking new accounts. A release holds files of
  any size without growing the git history, which 100 MB packages on a `gh-pages` branch would. The repo keeps
  only the newest version, so there's no downgrading through pacman.
- **A signed repo.** pacman expects signatures, and a key only CI holds means a compromised GitHub session
  alone can't ship a package. The cost is one `pacman-key` step per machine.
- **An install script that pins the key's fingerprint.** Comparing a fingerprint by eye is the step people skip,
  so the script does it. The script itself isn't signed: someone who could replace the release's files could
  replace it too, which would reach new installs that run it, not machines that already trust the key. The README
  keeps the manual steps for anyone who would sooner not run a script as root.
- **The script served from the `pacman` release, not from `main`.** What users run is what was released, at a URL
  next to the repo it sets up.
- **The repo in its own file, `/etc/pacman.d/aboard.conf`.** The script then adds one line to `pacman.conf` and
  never edits what's there, and removing the repo is deleting a file and that line.
- **`DatabaseRequired` in the script's config.** `repo-add --sign` already signs the database, so pacman can
  insist on it; without it pacman accepts an unsigned database.
- **The script stops at an existing `[aboard]` section.** Removing lines from a user's `pacman.conf` is theirs to
  do. The hand-made setup keeps updating, so stopping costs them nothing.
- **Packages with their own Electron.** They run exactly the Electron that CI built and tested, and install in
  seconds. Arch's `electron` packages move to new versions on their own schedule.
- **The AUR's .SRCINFO written in Node, not by makepkg.** The AUR job then needs no Arch container, and it's
  covered by the makepkg check above instead.
- **The installer isn't signed.** Signing needs a paid certificate; until then SmartScreen warns on first run.
- **Updates aren't signed either.** The updater checks the download against the sha512 in the feed, over HTTPS:
  the same trust as downloading the installer by hand. Once the installer is signed, `win.publisherName` in
  `package.ts` makes the updater check the signature too.
- **The feed goes up last.** GitHub has no atomic upload of several files, so ordering is what keeps an app from
  reading a feed whose installer isn't there yet.
- **Updates start with the release after the first one that has the updater.** An older install has no updater
  to ask, so it has to be updated by hand once.

## Alternatives considered

| Option                                            | Why not chosen                                                                                        |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Release on pushing a tag, with a draft made by CI | Two steps (tag, then edit the draft) instead of one page                                              |
| Building Windows on Linux with Wine               | Saves a runner but needs Wine for the executable's icon and version info, and isn't tested on Windows |
| Date versions, `vYYYY.M.D` (the first releases, renamed `v0.1.0` to `v0.8.0`) | Says when a build is from, but only one release a day                                             |
| `vYYYY.M.N`, a counter within the month           | Any number of releases a day, but the version no longer says the date, and it isn't semver's meaning either |
| `vYYYY.MDD.N`, the date and a counter within the day | Works everywhere and sorts after the date versions, but it's an unusual form to read and type      |
| `vYYYY.M.D.N`, a fourth number                    | electron-builder rejects it: not semver                                                               |
| A nightly channel beside the releases             | Solves a different problem; a same-day fix needs a second release, not a second channel               |
| Semver with a pacman `epoch=1`                    | Lets pacman upgrade from the date versions by itself, but the epoch stays in the package for good; not worth it with one known install |
| The pacman repo on GitHub Pages                   | Pages serves a branch, so every package would stay in the git history                                 |
| Versioned snapshots and a bootstrap repo in the install script, as OpenAI's has | They guard against a CDN serving half of a release; the job uploads the package before the database that lists it, so there's no such window |
| An unsigned pacman repo (`SigLevel = Never`)      | No key to manage, but pacman would install whatever is at the URL                                     |
| An Arch package built from source                 | Every install would download the dependencies and build the web app; slow, and not what CI tested     |

## Code map

| File                                 | What it does                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------- |
| `.github/workflows/release.yml`      | Packages on Windows and Linux, uploads to the release, updates pacman and the AUR |
| `.github/scripts/pacman-repo.sh`     | Builds and signs the pacman repo's package and database                          |
| `packaging/pacman-signing-key.asc`   | The public key the repo is signed with                                           |
| `packaging/install-arch.sh`          | What Arch users run: trusts the key, adds the repo, installs the package         |
| `.github/scripts/install-arch-test.sh` | Runs the install script in a throwaway Arch container                          |
| `.github/workflows/arch-install.yml` | Shellcheck and the container test, when those scripts change                     |
| `scripts/install-arch.test.ts`       | Holds the script's repo name and URLs to `package.json`                          |
| `scripts/release-version.ts`         | Checks the tag and stamps the version into `package.json`                        |
| `scripts/arch-package.ts`            | Writes the Arch `PKGBUILD` and `.SRCINFO`, for either package name               |
| `apps/desktop/scripts/package.ts`    | electron-builder config and the targets for each OS                              |
