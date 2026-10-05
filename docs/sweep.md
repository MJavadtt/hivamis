# The sweep — Hivamis task 10 (October 2026)

A pass over the whole system for faults in behaviour, interface and experience. It combined the
issues noted while building tasks 1–9 with three systematic checks, so that "nothing found" means
something.

## How it was done

| Check | What it covered | Result |
|---|---|---|
| **API sweep**, a permanent test (`apps/api/tests/035-sweep.test.ts`) | Every GET route the server registers (209, read from Fastify itself, so later routes are included), called by eight roles. Routes with an id are given a real one from the list beside them. | 1,672 calls: 984 answers, 292 refusals, 215 not-found, **no 5xx**. The test fails on any future 5xx. |
| **Page crawl**, signed in | Every page and every tab, as seven roles (CEO, PMO, sales, account, designer, finance, legal), in Persian and, for two of them, English. Recorded console and page errors, failed or refused API calls, and Persian left in English interface text. | No page errors, no failed or refused calls. One dev-server 404 that could not be reproduced. Persian in English: data only, plus the ask-the-data examples (below). |
| **Phone and accessibility crawl** | Every page and tab at 390px: sideways overflow, controls with no accessible name, fields with no label, images with no alt. | No overflow. 15 unlabelled fields (fixed). |
| **Dependency audit** | `pnpm audit --prod` | 7 advisories, 2 high (fixed, now none). |
| **Source scan** | TODO/FIXME, stray `console.log`, `debugger` | None. |

## Found and fixed

1. **A refresh token could be spent twice.**
   - Two refreshes presenting the same token at once both rotated it, and the account gained two
     sessions. Rotation is now atomic, and the loser is handled as reuse.
   - Tabs refresh one at a time through a Web Lock, reading the stored token inside it.
   - Restoring a session on load went around the shared path, which is how React's development
     double mount made pairs of sessions; it now uses that path.
   - ADR-063.
2. **A server restart signed people out.** Restoring the session deleted the stored token on any
   failure, a network error or a 5xx included. Now only a refusal ends the session. Otherwise the
   page says «سرور در دسترس نیست»: it keeps the session and tries again.
3. **Persian numbers used Latin separators** (`۴,۴۰۰`, `۳.۵`). Persian now gets `٬` and `٫` in every
   formatted number. Strings with several dots, such as addresses and versions, are left alone.
4. **Notices stayed light in dark mode.** Boxes written with fixed `bg-rose-50`, `bg-amber-50` and
   similar classes ignored the theme. The rose, amber, emerald and sky palettes are now tokens: in
   the dark their tints are washed over the card and their text shades lifted. Fills keep their
   colour. This replaces task 3's badge-only `dark:` classes.
5. **«تأیید مشتری» read "Client approved"** on the client-approval button and card, where it names
   the approval being asked for. They now read "Client approval".
6. **Ask-the-data invited English questions it cannot read.** The parser reads Persian. The English
   placeholder now says so and points to the Persian examples.
7. **Hard-coded right alignment**: tables, form cards, search results and a revenue column were
   `text-right` and so right-aligned in English. They now use logical alignment. Found during task 3
   and listed here for completeness.
8. **Tabs scrolled the page.** Bringing the chosen tab into view also scrolled the page down when the
   strip sat near the bottom of the screen. Only the strip scrolls now. Found during task 3.
9. **Fifteen fields had no accessible name**: every list's search box, the traffic unit filter, the
   accounting export's date, the forms search and the audit filter.
10. **Vulnerable dependencies**: Fastify 5.12.5, `@fastify/static` 10.1.5, and patched `fast-uri` and
    `brace-expansion` through pnpm overrides.
11. **The coverage plugin did not match vitest** (`@vitest/coverage-v8` 5 against vitest 3), so
    coverage could not run. It does now.

## Found, and left for its own task

- **Catalogue changes never reach an installed system.** The container runs migrations on start but
  not the reference-data sync, so a form changed in the catalogue keeps its old fields in the
  database until someone re-runs the seed. In this database the lead form still asks for «تلفن»
  without the lead-source fields of task 2. This is the upgrade path of roadmap #50, and it is fixed
  there.
- **nginx configuration**: the location added in task 8 was not checked with `nginx -t`, because no
  nginx image is available here.

## Left to the organisation

- The fourteen false «استفادهٔ دوباره از توکن» alerts on creative@ from before task 4a, and the test
  deliverable DLV-000027. Both are records in the organisation's data; they are not deleted without
  its say.
