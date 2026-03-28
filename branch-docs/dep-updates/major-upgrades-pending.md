# Major Dependency Upgrades Pending

These dependencies have major version bumps available that require dedicated upgrade work due to breaking changes.

---

## ESLint 9 → 10

| Package | Current | Latest |
|---------|---------|--------|
| `eslint` | 9.39.4 | 10.1.0 |
| `@eslint/js` | 9.39.4 | 10.0.1 |

**Breaking changes:**
- ESLint 10 drops support for the legacy `.eslintrc` config format — flat config only
- Several deprecated rules removed
- Node.js 20+ required (already met)
- Plugin API changes may affect third-party plugins (typescript-eslint, next/eslint-plugin)

**Migration steps:**
1. Verify flat config is already in use (`eslint.config.mjs`)
2. Update `eslint` and `@eslint/js` together
3. Update `typescript-eslint` to a compatible version
4. Update `eslint-plugin-react-hooks` and `@next/eslint-plugin-next` if needed
5. Run `pnpm lint` and fix any new/changed rule violations
6. Test CI passes

---

## TypeScript 5.9 → 6.0

| Package | Current | Latest |
|---------|---------|--------|
| `typescript` | 5.9.3 | 6.0.2 |

**Breaking changes:**
- Stricter type narrowing in some edge cases
- `--module nodenext` behavior changes
- Some deprecated compiler options removed
- `isolatedDeclarations` becomes the default in certain configurations
- `@supabase/supabase-js` and other deps may need type updates

**Migration steps:**
1. Update `typescript` in root and all workspace packages
2. Run `pnpm typecheck` — fix any new type errors
3. Check Supabase generated types compatibility
4. Check Next.js compatibility (Next.js 16 should support TS 6)
5. Run full test suite
6. Verify build passes

**Note:** The Expo mobile app has a peer dependency on `typescript@"^5.0.0"` — this will need to be resolved if Expo doesn't yet support TS 6.
