-- Review PRs' other people's PRs (docs/features/autopilot.md#other-peoples-prs): what Autopilot last did on each PR
-- it reviews that no task links to. The PR's history (rounds, approvals, hand-offs, /autopilot stop and resume) is read
-- back from the git host's markers on every pass; this keeps what the host can't give back: the hand-off comment to
-- edit on a repeat, the manual task a real escalation made, and a clean PR waiting for the user's approval (Needs you).
-- History, so backups leave it out; a restore's orphan sweep drops rows whose project is gone.
CREATE TABLE repo_pr_reviews (
  host TEXT NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  author TEXT,
  -- The head commit the last post was about, and the rounds used then.
  head_oid TEXT NOT NULL,
  round INTEGER NOT NULL,
  -- approved | changes_requested | escalated | ready
  outcome TEXT NOT NULL,
  -- The hand-off's reason (EscalationReason) and its one line, for escalated and ready.
  reason TEXT,
  reason_detail TEXT,
  -- The hand-off comment, edited instead of posting another when the same reason holds again.
  handoff_comment_id TEXT,
  handoff_comment_url TEXT,
  -- The manual task a real escalation made or noted; closed on a later approval or resume.
  task_id TEXT REFERENCES tasks (id) ON DELETE SET NULL,
  -- Set while a clean PR waits for the user's approval; cleared once it is approved, closed or moves on.
  ready_since TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (host, repo, number)
);
CREATE INDEX idx_repo_pr_reviews_ready ON repo_pr_reviews (ready_since) WHERE ready_since IS NOT NULL;
CREATE INDEX idx_repo_pr_reviews_project ON repo_pr_reviews (project_id);
