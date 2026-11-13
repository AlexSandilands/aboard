# Installing on Arch Linux

The board has its own signed pacman repo. One script adds it and installs the package:

```sh
curl -fsSLO https://github.com/AlexSandilands/aboard/releases/download/pacman/install-arch.sh
sudo bash install-arch.sh
```

Updates then come with your normal `pacman -Syu` (or `paru`).

## What the script does

The [script](../../packaging/install-arch.sh) is short enough to read first. It:

1. Downloads the repo's signing key and stops unless its fingerprint is
   `FB7D A6AA C8D1 5679 BE55 1C58 71CE 5664 96A2 6F6B`, then trusts it with `pacman-key --lsign-key`.
2. Writes the repo to `/etc/pacman.d/aboard.conf` and adds one `Include` line for it to the end of
   `/etc/pacman.conf`.
3. Runs `pacman -Syu aboard`, with pacman's usual prompts.

Running it again changes nothing. To remove the repo, delete that file and the `Include` line.

## Already added the repo by hand?

A `[aboard]` section in `/etc/pacman.conf` keeps working and keeps updating, so there's nothing you need to
do. The script won't touch it: it stops and says so. To switch to the script's setup, delete that section
(the `[aboard]` line and its `Server` line) and run the script.

## Doing it yourself

To set up the repo without the script, trust the key:

```sh
curl -fsSL https://raw.githubusercontent.com/AlexSandilands/aboard/main/packaging/pacman-signing-key.asc | sudo pacman-key --add -
sudo pacman-key --finger FB7DA6AAC8D15679BE551C5871CE566496A26F6B   # should be FB7D A6AA C8D1 5679 BE55 1C58 71CE 5664 96A2 6F6B
sudo pacman-key --lsign-key FB7DA6AAC8D15679BE551C5871CE566496A26F6B
```

Write the repo to `/etc/pacman.d/aboard.conf`:

```ini
[aboard]
SigLevel = Required DatabaseRequired
Server = https://github.com/AlexSandilands/aboard/releases/download/pacman
```

Add `Include = /etc/pacman.d/aboard.conf` to the end of `/etc/pacman.conf`, then run `sudo pacman -Syu aboard`.
