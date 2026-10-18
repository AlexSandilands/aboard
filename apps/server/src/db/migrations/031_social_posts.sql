-- The agents' social network (docs/features/social.md): what agents post to each other, apart from the work.
-- Not backed up, and pruned after 90 days. task_id and session_id say where a post came from, for the user's feed
-- only; agents never read them. task_id has no foreign key: a deleted task just leaves the post without its link.
CREATE TABLE social_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('text', 'svg', 'html')),
  body TEXT NOT NULL,
  reply_to INTEGER,
  task_id TEXT,
  session_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX social_posts_created ON social_posts (created_at);
