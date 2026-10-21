#!/usr/bin/env bash
# Builds the pacman repo's package for a release, then signs it and a repo database listing only it. Runs as root in
# an archlinux:base-devel container with nodejs, from the repo root (the release workflow's pacman job):
#
#   PACMAN_GPG_PRIVATE_KEY=... .github/scripts/pacman-repo.sh <version> <linux tarball> <out dir>
#
# <out dir> ends up holding exactly the files the `pacman` release serves. docs/features/releases.md has the rest.
set -euo pipefail

version=$1
tarball=$(realpath "$2")
out=$(realpath -m "$3")
repo=$(node -p 'require("./package.json").name')
work=$(mktemp -d)

node scripts/arch-package.ts "$repo" "$version" "$(sha256sum "$tarball" | cut -d' ' -f1)" "$work"
# Already in the build folder under its source name, so makepkg doesn't download it again.
cp "$tarball" "$work/$repo-$version-linux-x64.tar.gz"
# makepkg refuses to run as root. --nodeps: the runtime libraries aren't needed to repackage a build.
id builder &>/dev/null || useradd --create-home builder
chown -R builder "$work"
su builder -c "cd '$work' && PKGEXT=.pkg.tar.zst makepkg --nodeps --noconfirm"
pkgfile=$(basename "$(ls "$work/$repo-$version"-*.pkg.tar.zst)")

GNUPGHOME=$(mktemp -d)
export GNUPGHOME
gpg --batch --import <<< "$PACMAN_GPG_PRIVATE_KEY"
key=$(gpg --batch --with-colons --list-secret-keys | awk -F: '$1 == "fpr" { print $10; exit }')

rm -rf "$out"
mkdir -p "$out"
cp "$work/$pkgfile" "$out/"
cd "$out"
gpg --batch --local-user "$key" --detach-sign "$pkgfile"
repo-add --sign --key "$key" "$repo.db.tar.zst" "$pkgfile"

# repo-add leaves `<repo>.db` and `<repo>.files` (and their .sig) as symlinks to the archives. pacman fetches those
# names, and a release can't hold symlinks, so the archives take the names instead.
for name in db files; do
  for sig in "" .sig; do
    rm "$repo.$name$sig"
    mv "$repo.$name.tar.zst$sig" "$repo.$name$sig"
  done
done
for file in "$pkgfile" "$repo.db" "$repo.files"; do
  gpg --batch --verify "$file.sig" "$file"
done
ls -l
