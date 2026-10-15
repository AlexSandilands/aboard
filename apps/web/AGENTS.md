# apps/web

React 19, Vite, Tailwind v4, Base UI, TanStack Query + zustand, TanStack Router.

## State

- Server state is in the TanStack Query cache, kept fresh by SSE: `useBoardEvents` in
  `state/queries.ts` applies events with `state/boardReducer.ts`. See
  [docs/features/live-sync.md](../../docs/features/live-sync.md).
- Mutation hooks (`state/mutations.ts`) don't write results into the cache; the server's event does.
  Edits that must feel instant patch the cache optimistically: card moves inside `useMoveTask` (rolled
  back on error); lane collapse and order, plan edits and link removal in the caller (refetched on error).
- UI-only state is in zustand stores in `state/ui.ts`. Persisted keys go through `storageKey()`.
- All requests go through `api()` in `lib/api.ts`.

## Components

- `components/<area>/` per feature: `board`, `task`, `sidebar`, `command`, `settings`, `handoff`,
  `review`, `project`, `stage`, `layout`, `markdown`.
- `components/ui/*` are primitives ported from T3 Code (MIT, see `NOTICE`). Keep diffs from upstream
  small. [docs/reference/style.md](../../docs/reference/style.md) maps where the styles come from.
  `/__gallery` (dev only, `dev/StyleGallery.tsx`) shows every primitive.
- Pure logic sits in `*.logic.ts` files next to the components, with a `*.logic.test.ts` beside it.
- Top bars use `.drag-region` and respect the `.wco` class for the desktop title bar
  ([docs/features/desktop.md](../../docs/features/desktop.md)).

## Conventions

- Import with the `~/` alias and no extension (`~/components/ui/button`).
- Tests cover logic only, in a node environment, with no DOM rendering.
