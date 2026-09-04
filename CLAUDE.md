# CLAUDE.md

@AGENTS.md

## Claude Code specifics

- `CLAUDE.local.md` is gitignored and machine-specific: ssh aliases, host details, local ports, deploy runbooks, and where credentials live. It loads automatically. Consult it before any deploy, database, or Supabase-instance task, and never copy its contents into tracked files, because the repository is public.
- Auto-memory holds lessons and open items, one per file, each with a one-line description that is kept current. Do not turn a memory into a status log. When a lesson stops being true, update or delete the file. Facts the repo, git history, or `AGENTS.md` already record do not belong there.
- Load the `supabase:supabase-postgres-best-practices` skill before writing or changing anything under `supabase/migrations/`.
