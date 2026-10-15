# Tally

Tally is a multi-tenant B2B feedback board. A company creates an organization, opens public boards, and collects feature requests and bug reports from its customers. Customers post ideas and vote. The team triages the posts, replies, and changes their status. Each organization has isolated data, user roles, a Stripe subscription and usage limits.

**Stack:** TypeScript on the client and the server.

- Client: React 19, React Router, Vite. Design made in Superdesign.
- Server: Node.js, Express 5, PostgreSQL 17 (`pg`), Stripe, zod.

## Contents

1. [Features](#1-features)
2. [Tenant isolation](#2-tenant-isolation)
3. [Roles and permissions](#3-roles-and-permissions)
4. [Plans, billing and usage limits](#4-plans-billing-and-usage-limits)
5. [Sign-in and SSO](#5-sign-in-and-sso)
6. [REST API](#6-rest-api)
7. [Audit log](#7-audit-log)
8. [Run the application on your computer](#8-run-the-application-on-your-computer)
9. [Deploy a live demo](#9-deploy-a-live-demo)
10. [Configuration](#10-configuration)
11. [Tests](#11-tests)
12. [Source files](#12-source-files)
13. [Design](#13-design)
14. [Limits and next steps](#14-limits-and-next-steps)

## 1. Features

| Feature | Description |
|---|---|
| Organizations | One user can belong to many organizations. Each organization has its own boards, posts, members, plan and API keys. |
| Public boards | Customers post ideas, vote and comment without an account. A browser cookie identifies each anonymous voter, so each person votes once. |
| Triage inbox | The team filters posts by status and board, searches, sorts by votes, changes status, adds tags, merges duplicates, and writes internal notes or public replies. |
| Overview dashboard | Open posts, new posts and votes this week (with the change from last week), shipped posts, top requests, recent activity and plan usage. |
| Roles | Owner, admin and member. See section 3. |
| Billing | Stripe Checkout, the Stripe billing portal and webhooks. Without Stripe keys, a demo mode simulates checkout. See section 4. |
| Usage limits | Each plan limits boards, posts per month, seats and API calls. |
| SSO | Google sign-in. A Business organization can claim an email domain so that new Google users from that domain join automatically. |
| REST API | API keys per organization, a per-minute rate limit and a monthly quota. |
| Audit log | All important changes, with the actor, the target and the IP address. Business plans can export it as CSV. |
| Platform admin | Staff with a listed email see all organizations, their plans, usage and monthly revenue. |
| Demo mode | Each visitor gets a private organization with sample data. The server deletes it after 24 hours. |

## 2. Tenant isolation

Tally keeps the data of each organization separate in four layers. Each layer works even if a layer above it has a bug.

### 2.1 Row-level security (RLS)

Each table with tenant data has an `org_id` column and a PostgreSQL row-level security policy:

```sql
CREATE POLICY tenant_isolation ON posts FOR ALL
  USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
```

`app_org_id()` reads the `app.org_id` setting. The server sets this value at the start of each transaction (`server/src/db.ts`):

```sql
SELECT set_config('app.org_id', $1, true)  -- true = only for this transaction
```

Thus, a query such as `SELECT * FROM posts` returns only the rows of the current organization, even without a `WHERE` clause. A query cannot write a row into another organization. The setting ends with the transaction, so a pooled connection never keeps the organization of an earlier request.

Some tables need other rules:

| Table | A row is visible when |
|---|---|
| `memberships` | The row is in the current organization, or the row belongs to the current user. Thus, a user can list their own organizations. |
| `invites` | The row is in the current organization, or the invite is for the email of the current user. |
| `api_keys` | The row is in the current organization, or the request shows the key itself (the server compares the SHA-256 hash). Thus, the server can find the organization of a key. |
| `organizations` | All rows are readable. This table contains no customer content: only the name, the slug, the plan and the usage counters. Only the current organization can change its row. |

### 2.2 FORCE ROW LEVEL SECURITY and a restricted database role

PostgreSQL does not apply RLS to the table owner, to superusers or to roles with `BYPASSRLS`. Tally uses three protections:

1. Each tenant table has `FORCE ROW LEVEL SECURITY`. Thus, the policies also apply to the table owner.
2. In development and Docker, migrations run as `tally_owner`, and the server connects as `tally_app`. `tally_app` is not a superuser, does not own the tables and has no `BYPASSRLS`.
3. At startup, the server checks its own role. If the role is a superuser or has `BYPASSRLS`, the server stops with an error.

### 2.3 Composite foreign keys

Foreign-key checks in PostgreSQL do not use RLS. A normal foreign key can let a post point at the board of another organization. Thus, Tally uses composite keys:

```sql
FOREIGN KEY (org_id, board_id) REFERENCES boards (org_id, id)
```

A vote, a comment or a status change must be in the same organization as its post. A post must be in the same organization as its board.

### 2.4 Access checks in the application

Each route under `/api/orgs/:orgId` first finds the membership of the user. If the user is not a member, the server returns 404, not 403. Thus, a user cannot find out which organization IDs exist.

## 3. Roles and permissions

The permission table is in `server/src/rbac.ts`.

| Action | Member | Admin | Owner |
|---|---|---|---|
| Read the inbox and the overview | Yes | Yes | Yes |
| Create posts, change status and tags, merge, comment, write internal notes | Yes | Yes | Yes |
| Delete posts | No | Yes | Yes |
| Create, edit and delete boards | No | Yes | Yes |
| Invite members, remove members, change the role of members | No | Yes | Yes |
| Change the role of an admin or remove an admin | No | No | Yes |
| Create and revoke API keys, read the audit log, read billing | No | Yes | Yes |
| Change the plan, open the billing portal | No | No | Yes |
| Rename the organization, set the SSO domain | No | No | Yes |

Other rules:

- Nobody can become owner or stop being owner through the API.
- A member can leave an organization. The owner cannot leave.

## 4. Plans, billing and usage limits

### 4.1 Plans

| Limit | Free | Pro ($29) | Business ($99) |
|---|---|---|---|
| Boards | 1 | 10 | Unlimited |
| Posts per month | 50 | 500 | 5,000 |
| Seats (members and pending invites) | 2 | 5 | 25 |
| API calls per month | None | 50,000 | 500,000 |
| API requests per minute | None | 120 | 600 |
| Join by email domain (SSO) | No | No | Yes |
| Audit log export | No | No | Yes |

When an organization reaches a limit, the server returns HTTP 402 with the code `usage_limit`. If the plan becomes lower, the server keeps all data, but it blocks new usage above the new limits.

### 4.2 How the server enforces limits

The monthly counters are on the `organizations` row. One `UPDATE` adds 1 to the counter only if the counter is below the limit:

```sql
UPDATE organizations SET posts_this_period = posts_this_period + 1
 WHERE id = $1 AND posts_this_period < $2
```

Thus, two requests at the same time cannot both use the last unit. At the start of a new month, the server sets the counters to zero. For boards and seats, the server locks the organization row (`SELECT … FOR UPDATE`) and then counts.

### 4.3 Stripe

When `STRIPE_SECRET_KEY` and the price IDs are set, billing uses Stripe:

1. The owner clicks **Upgrade**. The server creates a Stripe customer (one time) and a Checkout Session.
2. Stripe sends `customer.subscription.created`, `customer.subscription.updated` and `customer.subscription.deleted` events to `/api/stripe/webhook`.
3. The server verifies the signature of each event. Then it sets the plan from the price ID and the subscription status.
4. A subscription with the status `active`, `trialing` or `past_due` gives the paid plan. A `canceled` or `unpaid` subscription changes the plan to Free.
5. If the organization already has a subscription, a plan change updates the subscription price. Stripe then sends a `customer.subscription.updated` event.

The webhook handler protects against two delivery problems:

- **Retries:** the server records each event ID in `stripe_events` in the same transaction as the change. A retried event changes nothing.
- **Wrong order:** the server stores the creation time of the newest event that it applied. It ignores an older event that arrives later.

NOTE: Use a restricted API key (`rk_…`) with permission for Customers, Checkout Sessions, Subscriptions, Billing Portal and Invoices, not a full secret key.

### 4.4 Demo billing

Without Stripe keys, billing runs in demo mode. **Upgrade** opens a signed link to the server. The link uses the same code path as a Stripe webhook (`applySubscription`), so the demo and Stripe give the same result. No payment occurs. The Billing page shows a notice about this.

## 5. Sign-in and SSO

- **Email and password.** The server stores a scrypt hash. The session is a signed, `HttpOnly`, `SameSite=Lax` cookie.
- **CSRF protection.** Each request that changes data must have the header `X-Requested-With: tally`. A form or a script on another site cannot send this header, because the server does not enable CORS.
- **Google sign-in.** The server uses the OpenID Connect authorization code flow with a `state` cookie. It accepts the ID token only if the audience is the client ID of Tally, the issuer is Google, the token is not expired and the email is verified.
- **Join by email domain.** On the Business plan, the owner can set an email domain (for example `northwind.app`) in **Settings → Security**. A person who signs in with Google with a verified email on that domain joins the organization as a member, if a seat is free.
- **Invites.** An admin invites an email address. The invited person signs up or signs in with that email, and then accepts the invite. The server does not send email.

## 6. REST API

The API is available on the Pro and Business plans. Create a key in **Settings → API keys**. The server shows the full key one time and stores only its SHA-256 hash.

Send the key in the `Authorization` header:

```bash
curl https://<your-host>/api/v1/posts?status=planned \
  -H "Authorization: Bearer tly_live_…"
```

| Method and path | Description |
|---|---|
| `GET /api/v1/boards` | List the boards. |
| `GET /api/v1/posts` | List posts, newest first. Query parameters: `board` (slug or ID), `status`, `limit` (1–100), `before` (a post number, for the next page). |
| `GET /api/v1/posts/:number` | Get one post. |
| `POST /api/v1/posts` | Create a post. Body: `board`, `title`, optional `body` and `authorName`. Counts against the monthly post limit. |
| `PATCH /api/v1/posts/:number` | Change `status` and `tags`. |

Each response has `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` headers. When a key goes above the per-minute limit, the server returns 429 with a `Retry-After` header. When the organization goes above its monthly quota, the server returns 429 with the code `usage_limit`. The audit log records changes from the API as `API key: <name>`.

## 7. Audit log

The server writes an audit entry in the same transaction as each change. The application never changes or deletes audit entries. Recorded actions include:

`organization.created`, `organization.updated`, `board.created`, `board.updated`, `board.deleted`, `post.created`, `post.updated`, `post.status_changed`, `post.merged`, `post.deleted`, `member.invited`, `member.invite_revoked`, `member.joined`, `member.joined_by_domain`, `member.role_changed`, `member.removed`, `member.left`, `api_key.created`, `api_key.revoked`, `subscription.updated`, `invoice.payment_failed`.

Each entry has the time, the actor (a user, an API key or the system), the action, the target, the IP address and extra details. The CSV export puts an apostrophe before values that start with `=`, `+`, `-` or `@`, so a spreadsheet does not run them as formulas.

## 8. Run the application on your computer

You must have Node.js 22.13 or later and Docker.

1. Install the dependencies:

   ```bash
   npm install
   ```

2. Start PostgreSQL:

   ```bash
   npm run db:up
   ```

   The container makes two roles (`tally_owner` and `tally_app`) and a `tally_test` database for the tests.

3. Copy the example configuration:

   ```bash
   cp .env.example .env
   ```

4. Start the server and the client:

   ```bash
   npm run dev
   ```

   The server runs the migrations and starts on port 3002. The client starts on port 5173.

5. Open http://localhost:5173. Click **Try the live demo**, or create an account.

To run the full application in Docker (the server and PostgreSQL):

```bash
docker compose --profile app up --build
```

Then open http://localhost:3002.

To see the platform admin page, put your email in `PLATFORM_ADMIN_EMAILS` before you sign up.

## 9. Deploy a live demo

### 9.1 Render

The server keeps no state in memory except rate-limit counters, so it can run on Render's free web service. This project has a blueprint (`render.yaml`) that makes a web service and a PostgreSQL database.

1. Push this repository to GitHub.
2. Sign in to https://render.com.
3. Click **New**, then click **Blueprint**.
4. Select the repository. Render reads `render.yaml`.
5. Click **Apply**. Render makes the database, builds the Docker image and starts the service.
6. Open the URL of the service. Click **Try the live demo**.

The blueprint sets `DATABASE_URL`, a random `SESSION_SECRET`, `DEMO_MODE=true` and `TRUST_PROXY=1`. The server uses `RENDER_EXTERNAL_URL` as its public URL.

On Render, the app connects with the database owner role. `FORCE ROW LEVEL SECURITY` makes the policies apply to this role. If the server stops with the message "is a superuser or has BYPASSRLS", make a second role and set `APP_DATABASE_URL` (see 9.3).

CAUTION: A free Render database expires after 30 days. For a longer demo, use a paid database or a free PostgreSQL service such as Neon (see 9.3).

NOTE: The free web service stops after 15 minutes without traffic. The next request starts it again. This can take approximately one minute.

### 9.2 Add Stripe (optional)

1. In the Stripe Dashboard (use a sandbox), make two recurring prices: Pro ($29 per month) and Business ($99 per month).
2. Make a restricted API key with the permissions in section 4.3.
3. Add a webhook endpoint: `https://<your-host>/api/stripe/webhook`. Select the events `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted` and `invoice.payment_failed`.
4. In Render, set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO` and `STRIPE_PRICE_BUSINESS`.
5. Turn on the customer portal in the Stripe Dashboard (**Settings → Billing → Customer portal**).

### 9.3 Use a separate app role

Some providers (for example Neon) give the default role `BYPASSRLS`. On these providers, make a restricted role for the app:

```sql
CREATE ROLE tally_app LOGIN PASSWORD '<password>' NOSUPERUSER NOBYPASSRLS;
```

Set `DATABASE_URL` to the owner role and `APP_DATABASE_URL` to `tally_app`. The migration step gives `tally_app` the necessary privileges.

### 9.4 Add Google sign-in (optional)

1. In Google Cloud, make an OAuth client of the type "Web application".
2. Add the redirect URI `https://<your-host>/api/auth/google/callback`.
3. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

## 10. Configuration

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | (required) | PostgreSQL URL of the owner role. The server runs migrations with it. |
| `APP_DATABASE_URL` | `DATABASE_URL` | PostgreSQL URL of the role that serves requests. It must not be a superuser or have `BYPASSRLS`. |
| `SESSION_SECRET` | (required in production) | Signs session cookies and checkout links. |
| `PUBLIC_URL` | `RENDER_EXTERNAL_URL` or `http://localhost:3002` | The URL of the browser app. Stripe and Google redirect to it. |
| `PORT` | `3002` | The HTTP port. |
| `DEMO_MODE` | `false` | `true` turns on **Try the live demo** and deletes demo organizations after 24 hours. |
| `TRUST_PROXY` | `0` | The number of proxies in front of the server. Set `1` on Render. |
| `PLATFORM_ADMIN_EMAILS` | (empty) | Comma-separated emails that get the platform admin page when they sign up. |
| `STRIPE_SECRET_KEY` | (empty) | A Stripe restricted key. Without it, billing runs in demo mode. |
| `STRIPE_WEBHOOK_SECRET` | (empty) | The signing secret of the webhook endpoint. |
| `STRIPE_PRICE_PRO`, `STRIPE_PRICE_BUSINESS` | (empty) | The price IDs of the paid plans. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | (empty) | Turn on Google sign-in. |

## 11. Tests

Start PostgreSQL (`npm run db:up`), then run:

```bash
npm test
npm run typecheck
```

The tests start a real server against a real PostgreSQL database. The server connects as `tally_app`, the same as in production. The 51 tests do a check of these items:

- **Tenant isolation:** an unfiltered query returns only the rows of the current organization. No tenant setting returns no rows. A tenant cannot insert, update or delete rows of another tenant. Composite foreign keys stop cross-tenant references. Settings do not leak between pooled connections. Every table with `org_id` has forced RLS. The server refuses a role with `BYPASSRLS`. The API returns 404 for the routes of another organization.
- **Roles:** the permission table, role changes, and the API responses for members and admins.
- **Usage limits:** board, seat and post limits. Reset in a new month. 12 requests at the same time with 5 units left give exactly 5 successes. A lower plan keeps data.
- **Billing:** signed webhooks change the plan. Retried events apply once. Older events do not overwrite newer events. Cancellation gives Free. A bad signature is refused. Demo checkout and cancel work. A changed checkout token is refused.
- **REST API:** keys need a paid plan. The full key is shown one time. A key reaches only its own organization. Revoked keys fail. The per-minute limit and the monthly quota work.
- **Accounts:** CSRF header, sign in and out, invites, Google sign-in (with a test token endpoint), and join by email domain.
- **Public board:** anonymous posts, votes and comments. Internal notes stay private. Private boards are hidden. Merge moves votes once per voter.
- **Audit export and demo mode.**

GitHub Actions runs the type check, the tests and the build on each push. It also builds the Docker image, starts it with PostgreSQL and does a smoke test.

## 12. Source files

```
server/
  migrations/001_init.sql   Schema, RLS policies, composite foreign keys
  db-init/01-roles.sql      Local roles: tally_owner and tally_app
  src/
    db.ts                   Tenant transactions, role check, migrations
    context.ts              Session, CSRF check, organization access
    rbac.ts                 Roles and permissions
    plans.ts, usage.ts      Plan limits and atomic usage counters
    billing/                Stripe and demo billing, webhook handling
    posts.ts, orgs.ts       Shared logic for posts and organizations
    demo.ts                 Demo organizations and their cleanup
    routes/                 auth, org, posts, members, billing, admin (API keys, audit log, platform), public, api-v1
  test/                     Integration tests
client/src/
  pages/                    Landing, sign-in, overview, inbox, boards, settings, public board, platform admin
  components/               App shell, shared UI
  styles.css, app.css       Design tokens and layouts
.superdesign/design-system.md   The design system used for the Superdesign drafts
```

## 13. Design

The design was made in Superdesign before the code. The design system (`.superdesign/design-system.md`) adapts the "Mosaic Grid Architecture" style: a paper background, forest green, 1px hairlines, no shadows, square corners, Space Grotesk for headings, General Sans for text and JetBrains Mono for labels.

## 14. Limits and next steps

- Rate-limit counters are in memory, so each server instance counts separately. For more than one instance, use Redis.
- The server does not send email. Invites appear when the person signs in. Next step: send invite and status emails.
- Votes from anonymous visitors use a cookie. A person can vote again from a new browser. For stronger protection, require sign-in to vote.
- Stripe tax is not configured. Before you charge real customers, set up Stripe Tax and a tax registration.
