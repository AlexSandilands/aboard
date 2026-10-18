-- An agent's request for the user's attention on a task (the request_attention tool). All three are set together or
-- all are null. It stands until the user dismisses it or an agent clears it; a new request replaces it.
ALTER TABLE tasks ADD COLUMN attention_message TEXT;
ALTER TABLE tasks ADD COLUMN attention_actor TEXT;
ALTER TABLE tasks ADD COLUMN attention_requested_at TEXT;
