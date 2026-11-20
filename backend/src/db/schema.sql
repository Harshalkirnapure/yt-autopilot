-- YT AutoPilot — PostgreSQL / Supabase schema
-- Safe to run repeatedly (idempotent).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Videos
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS videos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topic TEXT NOT NULL,
  niche TEXT,
  audience TEXT,
  language TEXT,
  script TEXT,
  audio_path TEXT,
  audio_duration DOUBLE PRECISION,
  video_path TEXT,
  caption_path TEXT,
  thumbnail_path TEXT,
  seo_title TEXT,
  seo_description TEXT,
  seo_tags TEXT[],
  youtube_video_id TEXT,
  privacy_status TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'rendered', 'uploaded', 'published', 'failed')),
  error TEXT,
  uploaded_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  approved_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Added after the first release; keeps existing databases in step.
ALTER TABLE videos ADD COLUMN IF NOT EXISTS approved_by TEXT;

CREATE INDEX IF NOT EXISTS videos_created_at_idx ON videos (created_at DESC);
CREATE INDEX IF NOT EXISTS videos_youtube_id_idx ON videos (youtube_video_id);

-- ---------------------------------------------------------------------------
-- Deduplication ledgers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS used_clips (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pexels_video_id TEXT UNIQUE NOT NULL,
  used_in_video_id UUID REFERENCES videos(id) ON DELETE SET NULL,
  used_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS used_clips_used_at_idx ON used_clips (used_at DESC);

CREATE TABLE IF NOT EXISTS used_topics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topic TEXT NOT NULL,
  niche TEXT,
  video_id UUID REFERENCES videos(id) ON DELETE SET NULL,
  used_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS used_topics_topic_key ON used_topics (lower(topic));

-- ---------------------------------------------------------------------------
-- YouTube OAuth tokens (single rotating row)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  access_token TEXT,
  refresh_token TEXT,
  expiry_date TIMESTAMPTZ,
  channel_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Job logs (one row per pipeline step)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id UUID REFERENCES videos(id) ON DELETE CASCADE,
  step TEXT,
  status TEXT,
  message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS job_logs_video_idx ON job_logs (video_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Render jobs (progress polling for GET /api/status/:jobId)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS render_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'active', 'completed', 'failed')),
  progress INTEGER NOT NULL DEFAULT 0,
  stage TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS render_jobs_video_idx ON render_jobs (video_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Scheduled pipeline runs (ledger for catch-up and "did today run?")
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Not "trigger": that is a keyword in enough dialects to be worth avoiding.
  trigger_kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'skipped', 'failed')),
  niche TEXT,
  audience TEXT,
  video_id UUID REFERENCES videos(id) ON DELETE SET NULL,
  job_id UUID REFERENCES render_jobs(id) ON DELETE SET NULL,
  reason TEXT,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS pipeline_runs_started_at_idx ON pipeline_runs (started_at DESC);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $fn$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS videos_set_updated_at ON videos;
CREATE TRIGGER videos_set_updated_at
  BEFORE UPDATE ON videos
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS oauth_tokens_set_updated_at ON oauth_tokens;
CREATE TRIGGER oauth_tokens_set_updated_at
  BEFORE UPDATE ON oauth_tokens
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS render_jobs_set_updated_at ON render_jobs;
CREATE TRIGGER render_jobs_set_updated_at
  BEFORE UPDATE ON render_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
