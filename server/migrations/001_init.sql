-- Tally schema. Every table that holds tenant data has an org_id column and a
-- row-level security policy keyed on the `app.org_id` setting, which the server
-- sets per transaction (see src/db.ts). FORCE ROW LEVEL SECURITY makes the
-- policies apply to the table owner too, so the only way around them is a
-- superuser or BYPASSRLS role, and the server refuses to run as either.

CREATE EXTENSION IF NOT EXISTS citext;

-- Session context helpers. NULLIF turns an unset setting ('' or NULL) into NULL,
-- so "no tenant selected" matches no rows instead of raising a cast error.
CREATE FUNCTION app_org_id() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT NULLIF(current_setting('app.org_id', true), '')::uuid $$;
CREATE FUNCTION app_user_id() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;
CREATE FUNCTION app_user_email() RETURNS citext LANGUAGE sql STABLE AS
  $$ SELECT NULLIF(current_setting('app.user_email', true), '')::citext $$;
CREATE FUNCTION app_api_key_hash() RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT NULLIF(current_setting('app.api_key_hash', true), '') $$;

-- Users are global: one person can belong to many organizations.
CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              citext NOT NULL UNIQUE,
  name               text NOT NULL,
  password_hash      text,
  google_sub         text UNIQUE,
  is_platform_admin  boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- Organization rows hold no customer content, only identity, plan and usage
-- counters. Anyone may read them (public boards resolve an org by slug, Stripe
-- webhooks by customer id); only the current tenant may change its own row.
CREATE TABLE organizations (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                    text NOT NULL,
  slug                    text NOT NULL UNIQUE,
  plan                    text NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'business')),
  stripe_customer_id      text UNIQUE,
  stripe_subscription_id  text UNIQUE,
  subscription_status     text,
  current_period_end      timestamptz,
  -- created time of the newest Stripe subscription event applied; older (out of order) events are ignored
  subscription_event_at   timestamptz,
  sso_domain              citext,
  usage_period_start      date NOT NULL DEFAULT date_trunc('month', now())::date,
  posts_this_period       integer NOT NULL DEFAULT 0,
  api_calls_this_period   integer NOT NULL DEFAULT 0,
  is_demo                 boolean NOT NULL DEFAULT false,
  created_at              timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY org_read ON organizations FOR SELECT USING (true);
CREATE POLICY org_create ON organizations FOR INSERT WITH CHECK (true);
CREATE POLICY org_update ON organizations FOR UPDATE USING (id = app_org_id());
CREATE POLICY org_delete ON organizations FOR DELETE USING (id = app_org_id());

-- A user sees their own memberships in every org (to list and switch orgs) and
-- all memberships of the current org.
CREATE TABLE memberships (
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_active_at timestamptz,
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX memberships_user ON memberships(user_id);
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_read ON memberships FOR SELECT
  USING (org_id = app_org_id() OR user_id = app_user_id());
CREATE POLICY membership_write ON memberships FOR ALL
  USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());

-- An invite is visible to its org and to the invited person (matched by email).
CREATE TABLE invites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email       citext NOT NULL,
  role        text NOT NULL CHECK (role IN ('admin', 'member')),
  invited_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, email)
);
ALTER TABLE invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE invites FORCE ROW LEVEL SECURITY;
CREATE POLICY invite_read ON invites FOR SELECT
  USING (org_id = app_org_id() OR email = app_user_email());
CREATE POLICY invite_write ON invites FOR ALL
  USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());

CREATE TABLE boards (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        text NOT NULL,
  slug        text NOT NULL,
  is_public   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug),
  UNIQUE (org_id, id)
);

CREATE TABLE posts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  board_id        uuid NOT NULL,
  number          integer NOT NULL,
  title           text NOT NULL,
  body            text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'under_review', 'planned', 'in_progress', 'shipped', 'closed')),
  tags            text[] NOT NULL DEFAULT '{}',
  author_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  author_name     text NOT NULL,
  vote_count      integer NOT NULL DEFAULT 0,
  comment_count   integer NOT NULL DEFAULT 0,
  merged_into_id  uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number),
  UNIQUE (org_id, id),
  -- Foreign-key checks are not subject to RLS, so plain FKs would let a row point
  -- at another tenant's board or post. Composite keys pin both to the same org.
  FOREIGN KEY (org_id, board_id) REFERENCES boards (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, merged_into_id) REFERENCES posts (org_id, id) ON DELETE SET NULL (merged_into_id)
);
CREATE INDEX posts_board ON posts(org_id, board_id, vote_count DESC);
CREATE INDEX posts_org_created ON posts(org_id, created_at DESC);

-- voter_key is "user:<uuid>" for signed-in people or "anon:<uuid>" for visitors.
CREATE TABLE votes (
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  post_id     uuid NOT NULL,
  voter_key   text NOT NULL,
  voter_name  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, voter_key),
  FOREIGN KEY (org_id, post_id) REFERENCES posts (org_id, id) ON DELETE CASCADE
);

CREATE TABLE comments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  post_id      uuid NOT NULL,
  author_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  author_name  text NOT NULL,
  is_team      boolean NOT NULL DEFAULT false,
  is_internal  boolean NOT NULL DEFAULT false,
  body         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, post_id) REFERENCES posts (org_id, id) ON DELETE CASCADE
);
CREATE INDEX comments_post ON comments(post_id, created_at);

CREATE TABLE status_changes (
  id          bigserial PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  post_id     uuid NOT NULL,
  from_status text,
  to_status   text NOT NULL,
  changed_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, post_id) REFERENCES posts (org_id, id) ON DELETE CASCADE
);

-- An API key row is visible to its org, and to a request that presents the
-- key itself (matched by hash) so the key can be resolved to its org.
CREATE TABLE api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name          text NOT NULL,
  prefix        text NOT NULL,
  key_hash      text NOT NULL UNIQUE,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY api_key_read ON api_keys FOR SELECT
  USING (org_id = app_org_id() OR key_hash = app_api_key_hash());
CREATE POLICY api_key_write ON api_keys FOR ALL
  USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());

CREATE TABLE audit_logs (
  id            bigserial PRIMARY KEY,
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_type    text NOT NULL CHECK (actor_type IN ('user', 'api_key', 'system')),
  actor_id      uuid,
  actor_label   text NOT NULL,
  action        text NOT NULL,
  target_label  text,
  ip            inet,
  metadata      jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_org_created ON audit_logs(org_id, created_at DESC);

-- Stripe event ids we've processed, so a retried webhook is applied once.
-- Not tenant data: it holds only event ids.
CREATE TABLE stripe_events (
  id            text PRIMARY KEY,
  type          text NOT NULL,
  processed_at  timestamptz NOT NULL DEFAULT now()
);

-- Same policy for every plain tenant table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['boards', 'posts', 'votes', 'comments', 'status_changes', 'audit_logs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id())', t);
  END LOOP;
END $$;
