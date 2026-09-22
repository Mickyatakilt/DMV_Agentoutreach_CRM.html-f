# HANDOFF — Manager Agent "wrong information" debug

**Date:** 2026-09-22
**App:** DMV Outreach CRM — `DMV_Agent_Outreach_CRM.html` (repo `Mickyatakilt/DMV_Agentoutreach_CRM.html-f`, GitHub Pages, installed as PWA "Mestate CRM")
**Feature:** Manager Agent = Ask AI (real answers) + Dashboard 🧠 briefing, backed by Supabase edge fn `manager-agent` on OpenAI `gpt-4o-mini`.
**Supabase project:** `jwctfsapxrdzznjaaufo`

---

## TL;DR — what's going on
The Manager Agent's **logic is correct against the live DB**. The "wrong info" Mike is seeing is almost certainly the **PWA service worker serving stale cached HTML** — i.e. Mike's browser/installed app is still running an OLD build, not the fixed one. Secondary: a couple of real data-scale gotchas (leads 1000-row cap, probate 18k rows) and a data-vs-expectation mismatch on probate "sent".

---

## Evidence — live DB counts (queried 2026-09-22)
| Metric | Live DB value |
|---|---|
| leads total | 974 |
| leads active (not deleted) | 395 |
| **leads Hot (active, non-D4D)** | **3** |
| jv_leads (Tasks) total | 100 |
| **jv_leads Hot (active)** | **10** |
| **TRUE total Hot = 3 + 10** | **13** ✅ |
| crm_probate total | 18,144 |
| crm_probate with `sent_on` set | **1** (so "not sent/not texted" = 18,143) |
| crm_lists | 8 |
| crm_buyers | 0 |

**"3 vs 13" is explained:** the ORIGINAL digest counted Hot only in `leads` (=3) and ignored `jv_leads`/Tasks (=10). The CRM's own canonical count (line ~6259) is `leads(Hot, non-D4D) + jvLeads(Hot)` = 13. This was FIXED in commit `cb28925` (digest now mirrors canonical). The DB math (3+10=13) confirms the fix is right.

**"Probate not texted returned already-texted":** two parts —
1. Parser didn't treat "texted/contacted" as the sent flag (only "sent"). FIXED `cb28925` (synonyms added).
2. DATA REALITY: only **1** of 18,144 probate rows has `sent_on` set. So "probate we haven't texted" legitimately ≈ all 18,143. If Mike believes more were texted, the `crm_probate.sent_on` field is not being written when he texts them (texting likely happens in GHL, not written back to `sent_on`). **This is a data-source question, not an agent bug** — see Open Questions.

---

## ROOT CAUSE of "still wrong after fixes" → stale service worker
`sw.js` is **cache-first** for the app shell and the cache VERSION is hardcoded `mestate-crm-v7`:
- `fetch` handler: `return cached || net` → returns the CACHED (old) HTML immediately, updates cache in background. User sees new HTML only on a LATER load, and only if the background fetch succeeded.
- VERSION was never bumped on the Manager Agent deploys, so the installed PWA keeps serving the old shell.

**Net effect:** Mike keeps testing the OLD build. Every "it's still wrong" is the pre-fix code.

### Fix applied in this handoff
- `sw.js` changed to **network-first for the same-origin HTML shell** (always fetch latest when online; fall back to cache offline) + VERSION bumped to `mestate-crm-v8`. Committed alongside this doc.
- Mike must do ONE clean reload to pick up the new SW (see Next Steps). After that, future deploys land immediately.

---

## Fixes already shipped (all on `main`)
1. `0ac361e` — Manager Agent v1 (Ask AI + Dashboard briefing).
2. `cb28925` — **accuracy**: hot count = leads(non-D4D)+tasks; Ask AI sends deterministic search results to the model as GROUND TRUTH (no guessing); parser treats texted/contacted/messaged/reached-out as sent synonyms; richer probate/hot samples.
3. `a983900` — clarify flow: agent asks a multiple-choice question (+ "Other" box) when unsure.
4. `ceb46ef` — threaded conversation (follow-ups keep context; collapsible matching records; "New topic" button).
5. **Parser bug from Mike's screenshot** — "how many follow ups do we have today" returned probate rows on "UPShur/UPSal St". Cause: (a) "ups" (from "follow ups") wasn't a stopword → became a text term matching "UPS…" addresses; (b) bare "today" wasn't parsed as due-today. FIXED: added "ups" to stopwords; due parser now treats "today"/"this week" as a due filter in follow-up/count context. Verified: parse of that query → due=today, no leftover terms.
6. `HANDOFF + sw.js network-first (v8)` — this commit. Service worker was cache-first (served stale HTML); now network-first for the shell so deploys land immediately.

Edge fn `manager-agent` is at **version 6** (OpenAI, JSON clarify contract). Server-side tests pass: hot=13, probate-not-texted grounded, vague→clarify, concrete→answer.

---

## Remaining REAL risks / suspects (verify next)
1. **leads 1000-row cap, oldest-first** — `loadFromSupabase()` (line ~1301): `leads?select=*&order=id.asc&limit=1000`. Currently 974 rows so OK, but at >1000 the NEWEST leads (highest id) silently drop → hot/recent counts wrong. FIX: use `sbFetchAll` (already exists, line ~1239) like probate does, or raise limit + order id.desc. **Do before leads cross 1000.**
2. **jv_leads 1000 cap** (line ~1425) — 100 rows now, fine, same latent issue.
3. **Probate 18k rows loaded client-side** — `crmProbateFetch` uses `sbFetchAll` (good, complete) but pulls all 18,144 rows into memory on Dashboard/Ask open. Heavy on mobile; `mgrBuildDigest` also tallies byState over 18k each call. Consider server-side aggregate counts (a Supabase RPC/edge fn) instead of client tally for probate.
4. **buyers = 0** — any buyer question correctly returns 0; if Mike expects buyers, they live in GHL, not `crm_buyers` (there's a `ghl-buyers-sync` fn — is it running?).
5. **Digest vs matched for overview** — "how are we doing" uses digest aggregates; those now mirror canonical, but double-check `sent`/`shared` semantics on leads match what Mike means by "sent."

---

## Open questions for Mike
- When you "text" a probate lead, where does that get recorded? (GHL tag? a CRM field?) Right now only `crm_probate.sent_on` counts as "texted", and it's set on just 1 of 18k. If texting = a GHL send, we need to sync that status back so "not texted" is meaningful.
- Which exact questions gave wrong answers, and what did you expect? (One concrete example with the number you expected pinpoints the next fix fast.)
- Are you using the installed "Mestate CRM" app icon, a browser tab, or both? (Confirms the service-worker cache theory.)

---

## NEXT STEPS (in order)
1. **Bust the old cache once** (this is probably the whole problem):
   - Browser: open the CRM, DevTools → Application → Service Workers → **Unregister**, then hard-reload (Cmd+Shift+R). OR just close & reopen twice after the sw.js v8 deploy.
   - Installed PWA: fully quit the app and reopen (twice), or delete & re-add to home screen.
2. Re-test the exact failing questions. Expect: **13 hot leads**, probate-not-texted ≈ 18,143 (data-accurate).
3. If still wrong, capture the exact question + expected answer and check `mgrBuildDigest()` output in console (`console.log(mgrBuildDigest())`) vs the DB counts above.
4. Address the **leads 1000-cap** (switch to `sbFetchAll`) before leads exceed 1000.
5. Decide how probate "texted" should be defined and wire it (GHL sync → a status field).

---

## Key code locations
- Manager module: search `=== Manager Agent` in `DMV_Agent_Outreach_CRM.html` (~line 4995+): `mgrBuildDigest`, `mgrCall`, `askRun`, `mgrRenderThread`, clarify fns.
- Canonical hot count reference: line ~6259.
- Lead load (1000 cap): `loadFromSupabase` line ~1301. Paginated helper: `sbFetchAll` line ~1239.
- Probate fetch (all rows): `crmProbateFetch` line ~3436.
- Edge fn: Supabase → Functions → `manager-agent` (v6).
