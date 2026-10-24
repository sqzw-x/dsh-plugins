---
'dsh-lan-link': minor
---

把 host 半区从手写 `lib/*.js` 迁到 TypeScript（`src/index.ts`、`src/gateway.ts`），随包发布 `index.d.ts` / `gateway.d.ts`；运行时行为不变，`lib/` 改由 `pnpm build` 生成、`prepack` 保证发布时存在。
