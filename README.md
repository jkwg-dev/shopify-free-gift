# free-gift-engine

Internal Shopify app: a configurable free-gift promotion engine for our single store
(Shopify **Advanced**, not Plus). Replaces Kite's free-gift use case. New promotions are
configured in the admin UI, not coded by hand.

See [`CLAUDE.md`](./CLAUDE.md) for the hard constraints, architecture, and conventions —
it is the source of truth.

## Workspace layout

| Path               | Purpose                                                                       |
| ------------------ | ----------------------------------------------------------------------------- |
| `packages/core`    | Pure business rules (tier resolution, OR/AND, suppression, schedule). No I/O. |
| `packages/shopify` | Typed Admin API wrappers (products, discounts, OAuth, webhooks).              |
| `apps/admin`       | Next.js embedded admin (App Bridge + Polaris). Campaign CRUD + `/validate`.   |
| `extensions/theme` | Theme App Extension (OS 2.0 app block) — storefront perception UX.            |
| `scheduler`        | Cron that flips campaign active state at `startsAt`/`endsAt`.                 |

Dependencies point inward: `admin`/`theme` → `shopify` → `core`. `core` depends on nothing.

## Getting started

```sh
corepack enable pnpm        # pnpm is pinned via packageManager
pnpm install
cp .env.example .env        # fill in secrets (never commit .env)
```

## Commands

| Command             | What it does                                   |
| ------------------- | ---------------------------------------------- |
| `pnpm typecheck`    | `tsc --noEmit` across all packages (via Turbo) |
| `pnpm lint`         | ESLint (typescript-eslint) across all packages |
| `pnpm test`         | Vitest across all packages                     |
| `pnpm format`       | Prettier write                                 |
| `pnpm format:check` | Prettier check (used in CI)                    |

Pre-commit (Husky + lint-staged) runs format + lint on staged files and a project
typecheck. Commit messages follow Conventional Commits (enforced by commitlint). CI runs
format check + lint + typecheck + test on every PR.
