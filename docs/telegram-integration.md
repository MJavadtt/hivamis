# The Telegram meeting platform and Hivamis

Audit F-9. A reading of the meeting platform at
`/Users/mohammadjavad/Downloads/Hiva/Telegram Bot/meeting-platform` (commit `af1a883`), what it
shares with Hivamis, and two ways to bring them together. **The owner chose Option A; its progress
is at the end.**

Everything below was read from the code and the project's own documents. Its `.env` and runtime
logs were not opened.

## ⚠️ First: the bot token

A bot token was once pasted into a chat. **Treat it as compromised.**

1. In Telegram, open @BotFather, choose the bot and run `/revoke`. The old token stops working at
   once.
2. Put the new token only in the server's environment, in a `.env` that is never committed:
   `MESSENGER_BOT_TOKEN` for Hivamis, which now runs the one bot (`TELEGRAM_BOT_TOKEN` was the
   meeting platform's name). Never put it in a chat, a document, an issue or a URL.
3. The meeting platform's local `.env` holds a token too. Replace it with the new one after
   revoking.

Checked: no commit in the meeting platform's history adds a token value. Its tracked env files
(`apps/*/.env.development`, `apps/mini-app/.env.production`) set only `VITE_API_URL`. No file
outside `.env` contains a string shaped like a bot token.

## What it is

A meeting and resource booking system for one company. Its three clients:

- **Bot** (grammY): registration, `/meetings`, `/approvals`, and one-tap approve, reject, confirm
  and cancel buttons.
- **Mini App** (React, inside Telegram): a ten-step wizard covering title, participants, date,
  time, place, type, guests, catering, parking and review. Drafts save as you go.
- **Admin panel** (React, a separate web app): users, departments, rooms and resources, locations,
  catering, texts, notification templates, working hours, holidays, settings, guests and
  reception, analytics and audit.

**Stack.** Node 22, Fastify 5, Kysely over `pg`, and PostgreSQL 17. Redis is optional. The bot runs
in the API's process.

**Approval flow.** A meeting moves `DRAFT → PENDING_MANAGER_APPROVAL →
APPROVED_PENDING_ORGANIZER_CONFIRMATION → CONFIRMED`. Side branches lead to `REJECTED`,
`CHANGES_REQUESTED` and `CANCELLED`. A material change sends the meeting back for approval.

**Strong points worth keeping:**

- **Double booking is impossible at the database.** It is enforced in three layers:
  - GiST exclusion constraints on `tstzrange` stop two active bookings of one room, or one
    person, from overlapping;
  - advisory locks, taken in sorted order, serialise confirmation, so parking capacity is counted
    without races;
  - an availability engine (580 lines) turns a conflict into a readable sentence.
- **Booking is generic.** Rooms, equipment, vehicles and parking are all one `resources` table.
  Parking counts against capacity rather than being exclusive.
- **Calendar sync** through Google, Microsoft and ICS. ICS needs no credentials, so confirming a
  meeting never waits on a vendor.
- **The bot keeps itself running on an unstable link.** A supervised polling loop restarts it,
  and a liveness stamp records when Telegram last answered.

**Data model** (two migrations, 29 tables):

| Area | Tables |
| --- | --- |
| People | `users` (one global `role` of eight; `telegram_user_id`), `departments`, `sessions`, `password_resets`, `bot_dialog_state` |
| Bookable things | `locations`, `resources`, `working_hours`, `holidays` |
| Meetings | `meetings`, `meeting_participants`, `meeting_versions`, `meeting_templates`, `approval_requests`, `meeting_catering`, `catering_options` |
| Allocation | `resource_bookings`, `participant_bookings`, `parking_reservations`, `waitlist_entries` |
| Guests | `guest_profiles`, `external_guests` (with a check-in token and QR) |
| Calendars | `calendar_events`, `external_busy_blocks` |
| Messages and settings | `notification_templates`, `notifications`, `content_strings`, `system_settings`, `audit_logs` |

There is no organisation column: one installation serves one company.

## What it shares with Hivamis

| | Meeting platform | Hivamis | Note |
| --- | --- | --- | --- |
| **People** | its own `users`, Telegram id on the row | `User`; external sign-ins in `UserIdentity (provider, subject)` | Two lists of the same staff; one must win |
| **Roles** | eight fixed roles, one per person | permission-based roles, several per person, set per organisation, rule-set versioned | Theirs map onto Hivamis permissions (below) |
| **Departments** | `departments` | units (`Department`) | Same idea |
| **Meetings** | a *booking*: when, where, who, catering, parking; approval and confirmation | `Meeting`: a record of a meeting held, with agenda, decisions, action items and minutes (roadmap #23) | **Complementary**: a confirmed booking is the meeting whose minutes Hivamis keeps |
| **Approvals** | `approval_requests`, one step, any manager | the workflow engine with named Doc_H guards; delegations; SLA | Hivamis's rule: only `transition()` writes a state |
| **Working time** | `working_hours`, `holidays` | work calendars and the SLA calendar | Same idea |
| **Notifications** | Telegram and email, templates, retry | in-app, email, Web Push, and the messenger adapter (roadmap #40) | Hivamis's adapter already speaks Telegram's Bot API |
| **Bot** | grammY, long polling | `messenger/`: links a chat by a one-time token; each button carries a single-use action token tied to its person | **A bot token serves one consumer of updates**: two systems cannot both read one bot |
| **Audit** | `audit_logs` | `audit_events`, written in the same transaction, never deleted | |

## What must be fixed whichever way is chosen

Found while reading. None is exploitable without a registered Telegram account, but each is real:

1. **The bot's buttons skip the permission check.** Each button's `callback_data` is
   `approve:<id>`, `reject:<id>`, `confirm:<id>` or `cancel:<id>`. The bot checks only that the
   person is registered and active, then calls the domain function:
   - `decideApproval` and `cancelMeeting` check nothing about who calls them. The HTTP routes add
     `meeting.approve`, or "organiser or `meeting.cancel`"; the bot does not.
   - Telegram does not verify that callback data matches the button it was sent on. A modified
     client can send `cancel:<any meeting id>` and cancel someone else's meeting.
   - Hivamis's messenger avoids this: each button is a single-use token for one person and one
     decision.
2. **Registration links an account by email alone.** If an administrator pre-created a person,
   anyone who registers from Telegram with that person's email is linked to the account and
   inherits its role. That includes a `MEETING_ADMIN` or `SUPER_ADMIN` not yet linked. No code is
   sent to the address.
3. **A deep link shows any meeting.** `/start meeting_<id>` replies with the meeting's summary to
   any registered person, participant or not. The HTTP API, by contrast, limits reading to
   participants, the organiser and `meeting.view.all`.
4. **`initData` stays valid for 24 hours.** Telegram's signature has no nonce, so a captured
   payload replays for a day. An hour is enough for opening the Mini App.

## Option A — bring it in, as part of Hivamis (recommended)

The booking domain becomes a Hivamis module. It shares the database, the identity, the
permissions, the workflow engine, the audit trail and the one bot.

- **Identity.** A Telegram account is a `UserIdentity` with `provider = 'telegram'` and
  `subject` = the Telegram user id. It is linked the way the messenger links a chat today: by a
  one-time token the signed-in person starts from Hivamis. No email matching (finding 2).
  - The Mini App signs in by verified `initData`, exchanged for a Hivamis session for the linked
    user.
  - An unlinked Telegram account gets a message saying how to link it, and nothing else.
- **Permissions.** Hivamis decides everything the bot and Mini App show or do. Their eight roles
  become permissions on Hivamis roles: `meeting.book`, `meeting.approve`, `meeting.view_all`,
  `resource.manage`, `reception.checkin`. They are granted per organisation, can be withdrawn and
  are versioned like every other grant. A permission not held is not shown (task 6).
- **Data.** The tables move into Prisma with an `organizationId` on each: resources, locations,
  bookings, participants, approvals, catering, guests, calendars and templates.
  - The exclusion constraints and advisory locks are kept as raw SQL in the migrations.
  - `users`, `departments`, `sessions`, `audit_logs`, `content_strings` and
    `notification_templates` are not moved: Hivamis's own replace them.
- **One meeting.** A confirmed booking creates the Hivamis `Meeting` (code `MTG-…`), linked to the
  project or company when one was chosen. The meeting's minutes are written there afterwards
  (roadmap #23), so "booked in Telegram" and "minuted in Hivamis" are the same record.
- **States.** Booking states move only through `workflow/engine.ts transition()`, with named
  guards (for example `organizer_only`, `approver_assigned`, `no_conflict`) answering 422 with
  `details.rule`. Delegations and SLA clocks apply to booking approvals like every other approval.
- **The bot.** The one bot is Hivamis's messenger, with `MESSENGER_MODE=telegram` and the token
  from the environment only. Booking commands and buttons join the messenger's single-use action
  tokens (finding 1). The polling supervisor and liveness stamp come along: they solve a problem
  this deployment really has.
- **The Mini App** stays a Telegram Mini App, served by Hivamis and calling Hivamis's API. Its
  texts go through Hivamis's catalogues.
- **The admin panel** is retired. Its pages become Admin → Rooms and resources, Catering,
  Reception and Analytics in Hivamis, in both languages.

**Cost.** Several weeks, in four steps, each usable on its own:

1. identity linking and the one bot;
2. the booking domain with its constraints and tests (their 46 tests and 83 workflow checks are
   ported, not dropped);
3. the Mini App against Hivamis;
4. the admin pages.

**Gains:**

- one list of people and one sign-in;
- one permission model, one audit trail and one backup;
- one bot, which Telegram's one-consumer rule allows;
- multi-organisation support for free;
- the four findings above disappear by construction.

## Option B — keep it separate, connect by API and webhooks

Two systems, two databases and two deployments.

- **Identity.** Hivamis stays the source of people. The meeting platform asks Hivamis, with an
  API key (roadmap #46), who a Telegram account belongs to and what they may do. A link endpoint
  in Hivamis issues the one-time token.
- **Meetings.** On confirmation, the platform calls a Hivamis endpoint that creates the `Meeting`.
  Hivamis webhooks notify the platform of people leaving and of permission changes.
- **The bot.** It stays the meeting platform's. Hivamis's messenger then needs a second bot, so
  people talk to two bots, or the messenger is turned off for Telegram.

**Cost.** One to two weeks for the bridge. The four findings must still be fixed in the platform's
own code.

**What stays doubled:**

- two user tables to keep in step;
- two role models, joined only by a lookup on each request: if Hivamis is unreachable, the bot
  cannot decide anything;
- two audit trails, and two deployments to back up, upgrade and secure.

## Recommendation

**Option A.** The rules this integration must follow are what Hivamis already is:

- one identity, linked as a `UserIdentity`;
- Hivamis's permissions deciding what the bot shows;
- bookings arriving as Hivamis meetings with minutes.

Option B rebuilds each of those as a bridge between two systems and keeps the duplication.
Telegram allows one consumer of a bot's updates, so B also means two bots.

Option A costs more at first. It ends with one system to run, and the platform's real strength
comes across intact: bookings that cannot collide, enforced by the database.

**Chosen: Option A** (the owner, 2026-10-14). Progress:

1. **Identity and the one bot — built** (ADR-090). Findings 2 and 4 are closed. A Telegram account
   is linked only by the code sent from a private chat. The Mini App's launch is taken for an hour
   and once. The bot can long-poll, one reader by lease.
2. **The booking domain — built** (ADR-091). Findings 1 and 3 are closed. Bot buttons are
   single-use action tokens that move a booking through the workflow as the person pressing them. A
   booking is read only by those it concerns. Clashes are refused by the database.
3. **The Mini App — built** (ADR-092). It is `/tg` in Hivamis, signed in by the launch data
   Telegram hands it, and opened from the bot's buttons and menu. It runs in Telegram's phone and
   desktop apps; Telegram Web would have to frame it, which Hivamis does not allow.
4. The admin pages.
