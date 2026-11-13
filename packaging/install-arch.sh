#!/usr/bin/env bash
# Sets up the board's signed pacman repo on Arch Linux and installs the package:
#
#   curl -fsSLO https://github.com/AlexSandilands/aboard/releases/download/pacman/install-arch.sh
#   sudo bash install-arch.sh
#
# It trusts the repo's signing key (only if its fingerprint is the one below), adds the repo as
# /etc/pacman.d/<repo>.conf with one Include line in /etc/pacman.conf, and runs `pacman -Syu <repo>`. Updates then
# come with a normal `pacman -Syu`. Running it again changes nothing. docs/features/releases.md has the rest.
set -euo pipefail

# scripts/install-arch.test.ts holds these to package.json, and the container test holds the fingerprint to
# packaging/pacman-signing-key.asc.
repo=aboard
github=https://github.com/AlexSandilands/aboard
key_url=https://raw.githubusercontent.com/AlexSandilands/aboard/main/packaging/pacman-signing-key.asc
key_fingerprint=FB7DA6AAC8D15679BE551C5871CE566496A26F6B

server=$github/releases/download/pacman
pacman_conf=/etc/pacman.conf
repo_conf=/etc/pacman.d/$repo.conf
include="Include = $repo_conf"

die() {
  printf 'install-arch.sh: %s\n' "$@" >&2
  exit 1
}

[ $# -eq 0 ] || die "this script takes no arguments"
[ "$(id -u)" -eq 0 ] || die "run it as root: sudo bash install-arch.sh"
for tool in pacman pacman-key pacman-conf curl gpg; do
  command -v "$tool" > /dev/null || die "$tool is needed and wasn't found (is this Arch Linux?)"
done
[ -f "$pacman_conf" ] || die "$pacman_conf doesn't exist"

umask 022
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# --- The repo config, checked before anything is changed ---------------------------------------------------------

printf '[%s]\nSigLevel = Required DatabaseRequired\nServer = %s\n' "$repo" "$server" > "$tmp/repo.conf"

switch_over=(
  "To switch to this script's setup, remove that [$repo] section (the header and its lines), then run this again."
  "To keep your own setup, there's nothing to do: \`pacman -Syu\` already updates $repo."
)
# A section of the same name would be merged with ours, taking its SigLevel and servers.
if grep -Eq "^[[:space:]]*\[$repo\][[:space:]]*$" "$pacman_conf"; then
  die "$pacman_conf already has a [$repo] section." "${switch_over[@]}"
fi
included=false
if grep -Eq "^[[:space:]]*Include[[:space:]]*=[[:space:]]*${repo_conf}[[:space:]]*$" "$pacman_conf"; then
  included=true
elif pacman-conf --repo-list | grep -Fxq "$repo"; then
  # Not in pacman.conf itself and not from our file, so a file it includes defines it.
  die "a file included from $pacman_conf already defines a [$repo] repo." "${switch_over[@]}"
fi
if [ -e "$repo_conf" ] && ! cmp -s "$tmp/repo.conf" "$repo_conf"; then
  die "$repo_conf exists and isn't what this script writes, so it was left alone." \
    "Move it away and run this again, or keep it and install with: pacman -Syu $repo"
fi

# --- The signing key ---------------------------------------------------------------------------------------------

echo "Downloading the repo's signing key..."
curl -fsSL --proto '=https' --tlsv1.2 -o "$tmp/key.asc" "$key_url" || die "couldn't download $key_url"

# Read in a throwaway keyring, so nothing is trusted before the fingerprint has been checked. Every primary key in
# the file is listed: pacman-key --add would import them all, so a second key is refused too. A file gpg can't
# read is refused below as well, as no key.
mkdir -m 700 "$tmp/gnupg"
found=$(GNUPGHOME="$tmp/gnupg" gpg --batch --show-keys --with-colons "$tmp/key.asc" |
  awk -F: '$1 == "pub" { primary = 1 } $1 == "fpr" && primary { print $10; primary = 0 }') || found=
if [ "$found" != "$key_fingerprint" ]; then
  die "the downloaded signing key isn't the expected one, so nothing was changed." \
    "expected: $key_fingerprint" \
    "found:    ${found:-no key}"
fi

echo "Trusting key $key_fingerprint..."
# Does nothing to a keyring that already exists.
pacman-key --init
pacman-key --add "$tmp/key.asc"
pacman-key --lsign-key "$key_fingerprint"

# --- The repo ----------------------------------------------------------------------------------------------------

install -Dm644 "$tmp/repo.conf" "$repo_conf"
if ! $included; then
  # The blank line also ends a last line that has no newline.
  printf '\n%s\n' "$include" >> "$pacman_conf"
  echo "Added the [$repo] repo: $repo_conf, included from $pacman_conf."
fi

# A full upgrade, not `-Sy <package>`: installing against a refreshed database without upgrading the rest is a
# partial upgrade, which Arch doesn't support. --needed: a second run doesn't reinstall the package.
pacman -Syu --needed "$repo"
