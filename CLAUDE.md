# Working in this repo

- Read `docs/plan.md` first (local only, kept out of git): it is the agreed design and phase order. Linear-compatible naming for the API and MCP surface is a core decision, so match Linear's names (`issueCreate`, `team.states`, `organization`, connections with `nodes` and `pageInfo`) when adding features.
- The hub must run identically on Node (libSQL) and Cloudflare Workers (D1). Keep `packages/core` free of Node-only APIs; use Web APIs (`crypto.subtle`, `fetch`, `Request`). Platform specifics live in `apps/hub-node` and `apps/hub-cloudflare`.
- D1 limits shape the data layer: at most 100 bound parameters per statement (use `insertRows` in `packages/core/src/write.ts`), no interactive transactions (group writes with `commit(db, ops)`, which batches atomically), and keep statements per request low.
- Every mutation writes its audit entry in the same batch (`audit(...)` in `packages/core/src/audit.ts`).
- GraphQL errors must be created with `createGraphQLError` from `graphql-yoga`, not `new GraphQLError`, or Yoga masks them.
- New behaviour that both platforms must share gets a case in `packages/core/src/testing/contract.ts`.
- Before pushing: `pnpm lint && pnpm typecheck && pnpm test && pnpm e2e`.
