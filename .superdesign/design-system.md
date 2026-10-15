# Tally design system

## Product context

Tally is a multi-tenant B2B feedback board. A company (an "organization") signs up, creates one or more boards, and shares a public board link with its customers. Customers post feature requests and bug reports, vote on them, and comment. The company's team triages posts (status, merge, tag), sees what customers want most, and closes the loop when they ship.

Each organization's data is fully isolated. Each organization pays for a plan (Free, Pro, Business) through Stripe. Plans set usage limits (boards, posts per month, team seats, API calls).

### Users and jobs to be done

- **Org owner / admin (primary):** "Show me what my customers want most, let me triage it fast, and let me manage my team and billing."
- **Org member:** "Let me triage and reply to feedback without touching billing."
- **End customer (public board, no account or a light one):** "Let me suggest an idea, upvote what I need, and see when it ships."
- **Developer at the org:** "Let me pull feedback into our tools with an API key."

### Key pages

1. **Marketing landing + pricing** (public): what Tally does, the three plans, sign-up CTA.
2. **Sign in / sign up / create organization** (public).
3. **Public board** `/b/:org/:board` (customer-facing): post list sorted by votes or newest, status filter, "Suggest an idea" form, vote button on each post, post detail with comments. Shows the org's name, not Tally's chrome.
4. **Dashboard / overview** (app): key numbers (open posts, votes this week, new posts), top-voted posts, recent activity, plan usage meters.
5. **Feedback inbox** (app, the core screen): dense table/list of posts across boards. Columns: votes, title, board, status, tags, author, created. Filters by status and board, search, sort. Selecting a post opens a right-side detail panel: description, status selector, tags, merge into another post, voters, comments thread, internal note.
6. **Boards** (app): create, rename, set public/private, copy public link.
7. **Settings** (app): Members and roles (owner, admin, member; invite by email), Billing (current plan, usage meters vs limits, upgrade, Stripe customer portal), API keys (create, revoke, last used), Audit log (who did what, when), SSO (Google sign-in).
8. **Platform admin** (super-admin): list of all organizations with plan, MRR, usage; impersonation is out of scope.

### App shell

Left sidebar (240px) with: org switcher at top (org name + plan badge), nav (Overview, Inbox, Boards, Settings), usage meter at bottom ("312 / 500 posts this month"), user menu. Main area has a 56px top bar with page title, search and primary action.

## Visual style (source: Superdesign library "Mosaic Grid Architecture Style", adapted for an app)

"Technical minimalist." Flat, 2D, precise. Structure comes from 1px hairlines and flat color blocks, never from shadows or gradients. High negative space on marketing pages; on app pages, denser but still calm.

### Color

| Token | Hex | Use |
|---|---|---|
| paper | #F7F7F5 | Page background |
| white | #FFFFFF | Cards, inputs, table rows, panels |
| forest | #1A3C2B | Primary brand: primary buttons, logo box, active nav, selected states, links |
| grid | #3A3A38 | Body text is #1C1C1A; grid at 20% opacity for all hairlines and dividers |
| ink | #1C1C1A | Primary text |
| muted | #6B6B66 | Secondary text, metadata |
| coral | #FF8C69 | Accent: "bug" tags, destructive hints, "over limit" usage |
| mint | #9EFFBF | Accent: "shipped/done" status, success, positive deltas |
| gold | #F4D35E | Accent: "in progress" status, warnings, "near limit" usage |

Status colors (flat chips, 1px border, square 8px dot + mono label):
- Open: grid/neutral. Under review: gold. Planned: forest at 15% fill. In progress: gold. Shipped: mint. Closed: muted.

Dark mode is not required for the first version.

### Typography

- **Space Grotesk** for headings. Marketing hero 64–96px, line-height 0.9, tight tracking. In-app page titles 24–28px, section titles 16–18px, weight 600.
- **General Sans** for body and UI text, 14px in-app (15–16px on marketing), line-height 1.5.
- **JetBrains Mono** for labels, tags, status chips, counts, IDs, timestamps, table column headers and small metadata: 10–12px, uppercase for labels, letter-spacing 0.1em.
- Vote counts use JetBrains Mono, tabular figures, 14–16px.

### Shape, borders, depth

- Border radius 0px everywhere; 2px allowed on inputs and buttons only.
- 1px hairline borders in #3A3A38 at 20% opacity for cards, table rows, panels, dividers.
- No box shadows, no gradients, no blur. Overlays (dialogs, side panels) separate from the page with a 1px border and a flat #1C1C1A at 30% scrim.
- Bento grids: cells separated by 1px gaps in the grid color.
- "Corner markers": four 10px L-shaped marks in forest at container corners, used sparingly (auth card, pricing highlight, empty states).

### Components

- **Buttons:** primary = solid forest, white text, 2px radius, 36px tall in-app. Secondary = ghost with 1px border. Destructive = ghost with coral text.
- **Inputs:** white background, 1px hairline border, 2px radius, mono label above the field.
- **Vote button:** a square 48x56px box with 1px border, an up chevron and the count in mono; voted state = forest fill, white text.
- **Status badge:** inline-flex, 1px border at 20% of its color, 8px square dot, mono 10px uppercase label, padding 4px 10px.
- **Usage meter:** mono label "POSTS 312 / 500", a 4px flat bar; bar color forest under 80%, gold 80–100%, coral at or over the limit.
- **Tables:** header row in mono 10px uppercase muted; rows 44px with hairline separators; selected row gets a 2px forest left border.
- **Plan cards (pricing/billing):** flat bordered cells in a bento grid; the recommended plan gets corner markers.
- **Navigation (marketing):** fixed top bar with 1px bottom border, 32x32 forest logo box with a white mark, mono 10px uppercase nav links with numeric indices (01. Product, 02. Pricing).
- **Mosaic background:** SVG mosaic of interlocking rectangles with 0.5px hairlines, marketing and auth pages only. Never behind app tables.

### Motion

Snappy and minimal: 120–160ms ease-out for hover and selection, 200ms for panels sliding in. Vote count changes with a short 150ms number tick. No decorative looping animation in the app.

### Layout

- Marketing: 1200px max width, 12-column grid, sections separated by full-width 1px lines.
- App: fixed sidebar 240px + fluid main; content max width 1280px; 24px page padding; 16px gaps.
- Public board: single centered column, max 760px, the org's name at top.
- Responsive: sidebar collapses to a top bar under 900px; tables become stacked rows under 640px.

## Requirements

- Accessible: WCAG AA contrast (forest on paper passes; mint and gold are fills only, never text on paper), visible 2px forest focus rings, keyboard navigable tables and menus.
- Use realistic B2B content (e.g. org "Northwind Analytics", posts like "Export dashboards to PDF", "SSO with Okta", "Dark mode for embedded charts").
