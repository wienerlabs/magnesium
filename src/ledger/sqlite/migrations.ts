import type Database from "better-sqlite3";

const SCHEMA_VERSION = 1;

const DDL = `
CREATE TABLE IF NOT EXISTS runs (
  id                  TEXT PRIMARY KEY,
  goal                TEXT NOT NULL,
  status              TEXT NOT NULL,
  workspace_dir       TEXT NOT NULL,
  base_commit         TEXT,
  integration_branch  TEXT,
  budget_usd_cap      REAL NOT NULL,
  cost_usd_spent      REAL NOT NULL DEFAULT 0,
  model_orchestrator  TEXT NOT NULL,
  model_router        TEXT NOT NULL,
  metadata            TEXT NOT NULL DEFAULT '{}',
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL REFERENCES runs(id),
  parent_id           TEXT REFERENCES tasks(id),
  slug                TEXT NOT NULL,
  title               TEXT NOT NULL,
  description         TEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL DEFAULT '[]',
  kind                TEXT NOT NULL,
  status              TEXT NOT NULL,
  attempt             INTEGER NOT NULL DEFAULT 0,
  max_attempts        INTEGER NOT NULL DEFAULT 2,
  model               TEXT,
  worktree_path       TEXT,
  branch              TEXT,
  worker_session_id   TEXT,
  cost_usd            REAL NOT NULL DEFAULT 0,
  result_summary      TEXT,
  error               TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_run ON tasks(run_id);

CREATE TABLE IF NOT EXISTS task_deps (
  task_id         TEXT NOT NULL REFERENCES tasks(id),
  depends_on_id   TEXT NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (task_id, depends_on_id)
);

CREATE TABLE IF NOT EXISTS artifacts (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES tasks(id),
  type            TEXT NOT NULL,
  path            TEXT,
  sha256          TEXT,
  metadata        TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id);

CREATE TABLE IF NOT EXISTS events (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES runs(id),
  task_id         TEXT REFERENCES tasks(id),
  seq             INTEGER NOT NULL,
  type            TEXT NOT NULL,
  payload         TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_run_seq ON events(run_id, seq);

CREATE TABLE IF NOT EXISTS llm_calls (
  id                    TEXT PRIMARY KEY,
  run_id                TEXT NOT NULL REFERENCES runs(id),
  task_id               TEXT REFERENCES tasks(id),
  purpose               TEXT NOT NULL,
  model                 TEXT NOT NULL,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd              REAL NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_llm_calls_run ON llm_calls(run_id);

CREATE TABLE IF NOT EXISTS checkpoints (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES runs(id),
  seq             INTEGER NOT NULL,
  digest          TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_run_seq ON checkpoints(run_id, seq);

CREATE TABLE IF NOT EXISTS schema_meta (
  version INTEGER NOT NULL
);
`;

export function applyMigrations(db: Database.Database): void {
  db.exec(DDL);
  const row = db.prepare("SELECT version FROM schema_meta LIMIT 1").get() as
    | { version: number }
    | undefined;
  if (!row) {
    db.prepare("INSERT INTO schema_meta (version) VALUES (?)").run(SCHEMA_VERSION);
  }
}
