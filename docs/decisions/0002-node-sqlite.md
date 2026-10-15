# 0002 SQLite through `node:sqlite`

Status: Accepted

## Context

The board is a single-user local app that must install with `pnpm install` on Windows, and ship inside an
Electron app, without a compiler toolchain. Native modules such as `better-sqlite3` need prebuilt binaries
per Node and Electron ABI, or a build step.

## Decision

Store everything in one SQLite file (`<data dir>/data.sqlite`) through Node's built-in `node:sqlite`
(`DatabaseSync`), with WAL, `foreign_keys = ON` and a busy timeout. Use plain SQL migrations and thin typed
repos (`apps/server/src/db/repos`), with no ORM. The engine requirement is Node 24.

## Consequences

- No native dependencies: the server bundles to one ESM file that runs on plain Node or in an Electron
  `utilityProcess`.
- `node:sqlite` still prints an experimental warning on some versions; the desktop shell hides it with
  `NODE_NO_WARNINGS`.
- Queries are synchronous, which suits a local app with one writer and keeps transactions simple.
- Only one server process may own the file. The desktop app attaches to a running server rather than
  starting a second one.
- Board SQL lives in `db/` (repos, migrations, transactions). The only other `node:sqlite` user is
  `integrations/t3.ts`, which reads a copy of T3 Code's database for project import. Swapping the driver
  would touch those two places.
