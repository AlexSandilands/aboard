-- Where a task runs (docs/features/remote-machines.md#choosing-the-machine): a connected machine's id, or `here`
-- for this machine. A task's `run_on` is its own choice, null following its project's; a project's is its default,
-- null meaning this machine. A machine removed later reads as `here`.
ALTER TABLE tasks ADD COLUMN run_on TEXT;
ALTER TABLE projects ADD COLUMN run_on TEXT;
