#!/usr/bin/env bash
# Runs packaging/install-arch.sh for real: the ways it refuses, then an install from the published pacman repo and
# a second run. It changes the system's pacman setup, so it's for a throwaway container, as root, from the repo
# root (the Arch install workflow):
#
#   docker run --rm -v "$PWD":/src:ro -w /src archlinux:base-devel .github/scripts/install-arch-test.sh
set -euo pipefail

script=$PWD/packaging/install-arch.sh
repo=$(sed -n 's/^repo=//p' "$script")
fingerprint=$(sed -n 's/^key_fingerprint=//p' "$script")
conf=/etc/pacman.d/$repo.conf
work=$(mktemp -d)
cp /etc/pacman.conf "$work/pacman.conf"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

step() {
  printf '\n== %s\n' "$*"
}

# refuses <text the error must contain> <command...>
refuses() {
  local want=$1 out
  shift
  if out=$("$@" 2>&1 < /dev/null); then
    fail "expected a refusal, but it succeeded: $out"
  fi
  echo "$out"
  grep -Fq -- "$want" <<< "$out" || fail "the refusal doesn't say: $want"
}

# What a refusal must leave behind: the pacman.conf it found, and no trusted key.
untouched() {
  cmp -s "$1" /etc/pacman.conf || fail "/etc/pacman.conf was changed"
  ! pacman-key --list-keys "$fingerprint" &> /dev/null || fail "the key was added to pacman's keyring"
}

step "The pinned fingerprint is the committed key's"
committed=$(GNUPGHOME=$(mktemp -d) gpg --batch --show-keys --with-colons packaging/pacman-signing-key.asc |
  awk -F: '$1 == "fpr" { print $10; exit }')
[ "$committed" = "$fingerprint" ] || fail "the script pins $fingerprint, the key file is $committed"

step "Refuses arguments"
refuses "takes no arguments" bash "$script" --yes

step "Refuses to run without root"
refuses "run it as root" runuser -u nobody -- bash "$script"

step "Refuses a key with another fingerprint"
sed 's/^key_fingerprint=.*/key_fingerprint=0000000000000000000000000000000000000000/' "$script" > "$work/wrong-key.sh"
refuses "isn't the expected one" bash "$work/wrong-key.sh"
untouched "$work/pacman.conf"
[ ! -e "$conf" ] || fail "$conf was written"

step "Refuses when pacman.conf already has the section"
printf '\n[%s]\nServer = https://example.invalid/repo\n' "$repo" >> /etc/pacman.conf
cp /etc/pacman.conf "$work/inline.conf"
refuses "already has a [$repo] section" bash "$script"
untouched "$work/inline.conf"
[ ! -e "$conf" ] || fail "$conf was written"
cp "$work/pacman.conf" /etc/pacman.conf

step "Refuses when an included file defines the repo"
printf '[%s]\nServer = https://example.invalid/repo\n' "$repo" > /etc/pacman.d/elsewhere.conf
printf '\nInclude = /etc/pacman.d/elsewhere.conf\n' >> /etc/pacman.conf
cp /etc/pacman.conf "$work/included.conf"
refuses "already defines a [$repo] repo" bash "$script"
untouched "$work/included.conf"
rm /etc/pacman.d/elsewhere.conf
cp "$work/pacman.conf" /etc/pacman.conf

step "Refuses to overwrite a different repo file"
printf '[%s]\nSigLevel = Never\nServer = https://example.invalid/repo\n' "$repo" > "$conf"
cp "$conf" "$work/other-repo.conf"
refuses "isn't what this script writes" bash "$script"
untouched "$work/pacman.conf"
cmp -s "$work/other-repo.conf" "$conf" || fail "$conf was overwritten"
rm "$conf"

step "Installs"
# Empty lines take the default at each of pacman's prompts.
bash "$script" < <(yes '')
pacman -Q "$repo"
LC_ALL=C pacman -Si "$repo" | grep -Eq "^Repository +: $repo$" || fail "$repo doesn't come from the [$repo] repo"
grep -Fxq "SigLevel = Required DatabaseRequired" "$conf" || fail "$conf doesn't require signatures"
[ "$(stat -c %a "$conf")" = 644 ] || fail "$conf isn't mode 644"

step "A second run changes nothing"
cp /etc/pacman.conf "$work/installed.conf"
bash "$script" < <(yes '')
cmp -s "$work/installed.conf" /etc/pacman.conf || fail "the second run changed /etc/pacman.conf"
[ "$(grep -c "^Include = $conf$" /etc/pacman.conf)" = 1 ] || fail "expected one Include line for $conf"

printf '\nAll passed.\n'
