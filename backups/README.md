# Backups

Pre-migration snapshots of the `tasks` table, pulled straight from the REST
API. Restore by POSTing a file's contents back to `/rest/v1/tasks` (parents
before children — the `parent_id` foreign key is enforced).

Taken before the boards/membership migration (`supabase/migrations/`).
