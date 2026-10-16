-- The model tier a task's planner suggests for implementing it (see ModelTier in contracts). Both null when
-- none is set; a reason never exists without a tier.
ALTER TABLE tasks ADD COLUMN suggested_tier TEXT CHECK (suggested_tier IN ('light', 'standard', 'deep'));
ALTER TABLE tasks ADD COLUMN suggested_reason TEXT;
