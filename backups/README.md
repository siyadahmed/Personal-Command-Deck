# Backups

Task exports are kept here locally and are **git-ignored** — this repo is
public, and a backup is a full copy of personal board data.

Restore by POSTing a file's contents back to `/rest/v1/tasks` (parents
before children — the `parent_id` foreign key is enforced).
