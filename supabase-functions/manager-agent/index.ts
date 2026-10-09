// Manager Agent v8 — database-grounded. The model never guesses: it writes read-only SQL against
// the `agent` schema (clean views that encode the CRM's own rules), the function runs it as a
// SELECT-only Postgres role (agent_ro), and the model answers from the real rows.
//
//  ask mode      -> tool loop (run_sql) -> JSON {type:'answer'|'clarify', ...}
//  briefing mode -> fixed server-side queries -> plain-text briefing
//
// Owner-only: the caller's JWT must be a signed-in user whose app_users.is_owner = true
// (the public anon key alone can NOT query anything through this function).

import { createClient } from 'jsr:@supabase/supabase-js@2';
import postgres from 'npm:postgres@3.4.4';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (o: unknown) => new Response(JSON.stringify(o), { headers: { ...cors, 'Content-Type': 'application/json' } });

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-4.1';
const FALLBACK_MODEL = 'gpt-4o';       // used if the primary model name isn't available
const RATE_FALLBACK_MODEL = 'gpt-4.1-mini'; // used if the primary model stays rate-limited (tier TPM caps)
const ROW_CAP = 200;          // max rows a single query may return
const MAX_STEPS = 7;          // max tool calls per question
const MODEL_ROWS = 60;         // rows of each result the model actually sees (the rest only feed the clickable list)
const RESULT_CHARS = 9000;    // max chars of one result shown back to the model (keeps token use under rate limits)

const SCHEMA_DOC = `
READ-ONLY VIEWS (schema "agent") — query ONLY these, always with the "agent." prefix. Non-deleted rows only.

agent.leads  — Outreach leads (the CRM "CRM Outreach" tab).
  kind='lead', id, title, sub, name, phone, address, status, score('Hot'/'Warm'/'Cold'/''), is_hot, lead_source, marketing_type, month,
  offer, arv, notes, follow_up_date(date), is_nationwide, shared(bool = sent/shared out), shared_with, needs_review,
  is_d4d (came from D4D auto-scan), is_fb_batch, in_main_pipeline (= NOT d4d and NOT fb batch), d4d_status, d4d_hot, date_added, updated_at, ghl_contact_id
agent.tasks  — Tasks tab (JV / follow-up work).
  kind='task', id, title, sub, name, phone, location, score, is_hot, jv_status, asking_price, arv, profit_est, notes, source_group,
  follow_up_date, shared, shared_with, needs_review, d4d_status, date_added, ghl_contact_id   (NO updated_at column)
agent.probate_crm — leads inside the CRM Probate tab (imported batches).
  kind='probate', id, title, sub, state (a BATCH LABEL like 'MD PROBATE','ALL STATES','DC','NC','MD','SC PRE-FORE' — not a clean state code), county, case_number,
  estate_type, decedent_name, date_of_death, filing_date, property_address, property_city, property_zip, assessed_value, pr_name, pr_phone, attorney,
  score, lead_status, date_pulled, sent_on, follow_up_date, notes, has_phone,
  batch_status ('Not Scraped' = batch has no skip-traced phone numbers yet | 'Scraped' = skip-traced | 'Texted'), texted (bool)
agent.probate_batches — one row per imported probate batch: id, state, date_pulled, batch_status ('Not Scraped'/'Scraped'/'Texted'), send_out_date, follow_up_date, notes, lead_count
agent.probate_scraped — leads found by the probate COURT SCRAPER (separate platform, much bigger): id, state (real code), county, case_number, decedent_name,
  filing_date, date_of_death, status, case_type, personal_rep, lead_score, lead_stage, first_seen, property_address, property_city, property_zip, assessed_value, property_confirmed, tax_balance
agent.probate_scan_coverage — one row per state/county the scraper knows: state, county, last_scan, never_scanned(bool), days_since_scan, scan_runs, total_found, total_new, leads_in_db, newest_lead
agent.probate_scan_log — every scraper run: id, state, county, started_at, finished_at, window_from, window_to, found, new_cases, updated_cases, new_properties, ok, error
agent.d4d_leads — raw Driving-for-Dollars scan results: id, address, locality, area, status, tier, signal_count, grade_note, scanned_at, graded_at, dismissed, owner_name, sv_year, boarded, grass, mail, trash, roof, door, windows
agent.sms_messages — GoHighLevel text mirror: id, contact_id, direction ('outbound'/'inbound'; inbound = a reply), status, msg_type, is_opt_out, date_added. Join to leads/tasks via ghl_contact_id.
agent.lists — marketing lists (List Tracking tab): kind='list', id, title, sub, name, category, region, amount, period, date_added, last_texted, due_date, notes
agent.buyers — kind='buyer', id, title, sub, name, phone, email, area, is_hot, buy_box, tags, notes
agent.deals — saved deals: kind='deal', id, title, sub, address, price, arv, beds, baths, sqft, status, created_at
agent.jv_agreements — e-sign agreements: id, party_a_name, party_b_name, property_address, status, agreement_date, created_at, received_at, opened_at, failed_at
agent.fb_scrapes — Facebook scrape files: id, date_scraped, lead_count, texted, deleted, source, created_at
`;

const CRM_RULES = `
CRM DEFINITIONS (follow exactly):
- "Hot leads" = agent.leads WHERE is_hot AND NOT is_d4d  PLUS  agent.tasks WHERE is_hot. Always report the total AND the split (Outreach vs Tasks).
- Active pipeline leads = agent.leads WHERE in_main_pipeline.
- Overdue follow-up = follow_up_date < CURRENT_DATE ; due today = follow_up_date = CURRENT_DATE (use leads with in_main_pipeline, plus tasks).
- D4D: "when was D4D last scanned" = max(scanned_at) from agent.d4d_leads. D4D leads waiting in the Review queue = agent.leads WHERE is_d4d AND needs_review.
- Probate "Not Scraped" has TWO meanings, so cover both whenever the user says "not scraped":
    (a) COVERAGE — counties/places the court scraper hasn't scanned: agent.probate_scan_coverage (never_scanned = true, or stale = days_since_scan > 14). Lead with this.
    (b) CRM BATCH STATUS — probate batches in the CRM tab with no skip-traced phones: agent.probate_crm / agent.probate_batches WHERE batch_status = 'Not Scraped'.
  Say which is which in the answer. "Not texted" probate = agent.probate_crm WHERE NOT texted.
- Texting results come from agent.sms_messages (replies = direction 'inbound'; opt-outs = is_opt_out). Dates are UTC timestamps.
- Dates: today is {TODAY} (America/New_York). Use CURRENT_DATE in SQL.
`;

function systemPrompt(today: string): string {
  return `You are the Manager Agent for a DMV (DC/Maryland/Virginia) real-estate wholesaling business, built into the operator's CRM. Accuracy matters more than anything: the operator makes decisions from your numbers.

HOW YOU WORK
- You have ONE tool, run_sql, that runs a read-only SELECT against live CRM data. EVERY number, count, date, name or list in your answer MUST come from a run_sql result in this conversation. Never guess, estimate, or recall from memory. If you have not queried it, you do not know it.
- Use count(*) for "how many". Never count by eye. For lists, ORDER BY something sensible and LIMIT (you see at most the first ${MODEL_ROWS} rows of any result; for any total run a separate count(*)).
- When listing CRM records (leads, tasks, probate_crm, lists, buyers, deals), SELECT kind, id, title, sub (and any columns you need) so the app can show clickable rows. One statement only, no semicolons, no comments.
- If a query errors, read the error, fix the SQL, and retry. If the data truly can't answer the question, say so plainly and say what's missing — never fill gaps with guesses.
- If the answer is zero, say "none" and what you checked.
- Be explicit about WHICH source you used when two exist (e.g. CRM probate tab vs court scraper), and state the exact count.
- NEVER do arithmetic or counting yourself — not even adding two numbers or counting list items. Every total you state must be a number a query returned (use count(*), sum(), or a UNION ALL query that returns the combined total). If you quote a total, it must match the rows you list.
- If you mention a list, WRITE OUT every item (when 40 or fewer) in your answer — never say "see list below" unless you wrote it. Include BOTH 'never scanned' and 'stale' items when asked what has not been scraped.
- Only describe what the results actually show. Never say "showing N" or "top N" unless that N is literally in the results.
- When the answer is zero/none, run one quick breakdown query (e.g. group by batch_status or state) so you can explain WHY it is zero (e.g. "all MD batches are already marked Texted").
- Select only the columns you need (not every column) to keep results small. For names of people who replied to texts, JOIN agent.sms_messages to agent.leads / agent.tasks on ghl_contact_id; also report how many replying contacts could not be matched to a CRM lead (count them in SQL).

CLARIFY ONLY WHEN TRULY AMBIGUOUS (vague words like "good ones/best/top" with no concrete field). Otherwise answer. Never ask for something you can look up.

FINAL REPLY — respond ONLY as one JSON object, one of:
 {"type":"answer","answer":"<markdown>","list_queries":[<n>,...]}
 {"type":"clarify","question":"<short>","options":["<opt>","<opt>","<opt>"]}
 - list_queries = the 1-based indexes of the run_sql calls (in the order you made them) whose rows should be shown to the user as clickable record lists (e.g. [1,3] to show both a leads list and a tasks list); [] if none. Only include queries that selected kind and id.
 - Answer style: lead with the answer, short bold headers, tight bullets, no preamble. Talk like a sharp teammate.

${SCHEMA_DOC}
${CRM_RULES.replace('{TODAY}', today)}`;
}

// ---------- config / auth / db ----------
async function getConfig(admin: any): Promise<{ key: string | null; model: string }> {
  let key = Deno.env.get('OPENAI_API_KEY') || null;
  let model = Deno.env.get('OPENAI_MODEL') || '';
  if (!key || !model) {
    try {
      const { data } = await admin.from('app_config').select('key,value').in('key', ['openai_key', 'openai_model']);
      const map = Object.fromEntries((data || []).map((r: any) => [r.key, r.value]));
      if (!key && map['openai_key']) key = map['openai_key'];
      if (!model && map['openai_model']) model = map['openai_model'];
    } catch (_) { /* optional */ }
  }
  // gpt-4o-mini was the old default and is the weak link for tool use — upgrade it unless the owner chose otherwise via env.
  if (!model || model === 'gpt-4o-mini') model = DEFAULT_MODEL;
  return { key, model };
}

async function requireOwner(admin: any, req: Request): Promise<{ ok: boolean; why?: string }> {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return { ok: false, why: 'no token' };
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) return { ok: false, why: 'not signed in' };
  const { data: prof } = await admin.from('app_users').select('is_owner').eq('id', data.user.id).maybeSingle();
  return prof?.is_owner === true ? { ok: true } : { ok: false, why: 'owner only' };
}

function guardSql(raw: string): string {
  let s = String(raw || '').trim().replace(/;+\s*$/, '');
  if (!/^(select|with)\b/i.test(s)) throw new Error('Only a single SELECT (or WITH … SELECT) statement is allowed.');
  if (s.includes(';')) throw new Error('Only ONE statement is allowed (no semicolons).');
  if (/--|\/\*/.test(s)) throw new Error('SQL comments are not allowed.');
  if (!/\bagent\./i.test(s)) throw new Error('Query the agent.* views only.');
  return s;
}

let _sql: any = null;
function db() {
  if (!_sql) _sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { max: 2, prepare: false, idle_timeout: 20, connect_timeout: 10 });
  return _sql;
}

async function runReadOnly(raw: string): Promise<any[]> {
  const s = guardSql(raw);
  const sql = db();
  return await sql.begin('read only', async (tx: any) => {
    await tx.unsafe('set local role agent_ro');
    await tx.unsafe("set local statement_timeout = '8s'");
    return await tx.unsafe(`select * from (${s}) _q limit ${ROW_CAP}`);
  });
}

function clip(v: unknown): unknown {
  if (typeof v === 'string' && v.length > 240) return v.slice(0, 240) + '…';
  return v;
}
function rowsForModel(rows: any[]): string {
  const total = rows.length;
  let n = Math.min(total, MODEL_ROWS);
  const slim = rows.slice(0, n).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, clip(v)])));
  let out = JSON.stringify(slim);
  while (out.length > RESULT_CHARS && n > 1) { n = Math.floor(n * 0.7); out = JSON.stringify(slim.slice(0, n)); }
  if (n < total) out += `  /* showing the first ${n} of ${total} rows returned (query cap ${ROW_CAP}) — use count(*) for true totals */`;
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function openai(key: string, model: string, payload: any) {
  const call = (m: string) => fetch(OPENAI_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, model: m }),
  });
  let r = await call(model);
  if ((r.status === 404 || r.status === 400) && model !== FALLBACK_MODEL) {
    const t = await r.clone().text();
    if (/model/i.test(t)) { model = FALLBACK_MODEL; r = await call(model); }
  }
  // Tokens-per-minute rate limit: wait the time OpenAI asks for (a few tries), then fall back to a smaller model.
  for (let i = 0; i < 3 && r.status === 429; i++) {
    const t = await r.clone().text();
    const m = t.match(/try again in ([\d.]+)(ms|s)/i);
    const wait = m ? Math.min(12000, Math.ceil(parseFloat(m[1]) * (m[2].toLowerCase() === 'ms' ? 1 : 1000)) + 300) : 4000;
    await sleep(wait);
    r = await call(model);
  }
  if (r.status === 429 && model !== RATE_FALLBACK_MODEL) { model = RATE_FALLBACK_MODEL; r = await call(model); }
  return { r, model };
}

function errAnswer(status: number, detail: string) {
  const hint = status === 401 ? 'The API key looks invalid — check the OPENAI_API_KEY secret.'
    : status === 404 ? 'That model name may be wrong — set OPENAI_MODEL to a model your key can use.'
    : status === 429 ? 'Out of OpenAI credits or rate-limited — add credit at platform.openai.com billing.'
    : 'Try again in a moment.';
  return { error: 'openai_error', status, answer: `⚠️ The Manager couldn't reach OpenAI (HTTP ${status}). ${hint}`, detail: detail.slice(0, 500) };
}

const TOOLS = [{
  type: 'function',
  function: {
    name: 'run_sql',
    description: 'Run ONE read-only SELECT against the live CRM views in schema "agent". Returns up to ' + ROW_CAP + ' rows as JSON. Use count(*) for totals.',
    parameters: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'A single SELECT/WITH statement over agent.* views. No semicolons or comments.' },
        why: { type: 'string', description: 'One short phrase: what this query answers.' },
      },
      required: ['sql', 'why'],
    },
  },
}];

// ---------- ask ----------
async function ask(key: string, model: string, question: string, history: any[], today: string) {
  const messages: any[] = [{ role: 'system', content: systemPrompt(today) }];
  for (const h of history) {
    if (h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string') messages.push({ role: h.role, content: h.content.slice(0, 3000) });
  }
  messages.push({ role: 'user', content: question || 'How are things going?' });

  const queries: { why: string; sql: string; rows: any[]; error?: string }[] = [];
  let usedModel = model;
  const usage = { prompt: 0, completion: 0 };

  for (let step = 0; step <= MAX_STEPS; step++) {
    const last = step === MAX_STEPS;
    const payload: any = { max_completion_tokens: 1800, temperature: 0, messages, response_format: { type: 'json_object' } };
    if (!last) { payload.tools = TOOLS; payload.tool_choice = 'auto'; }
    else messages.push({ role: 'user', content: 'Out of query budget. Give your best FINAL JSON reply now using only the data already retrieved; say what you could not verify.' });

    const { r, model: m } = await openai(key, usedModel, payload);
    usedModel = m;
    if (!r.ok) return errAnswer(r.status, await r.text());
    const j = await r.json();
    usage.prompt += j.usage?.prompt_tokens || 0; usage.completion += j.usage?.completion_tokens || 0;
    const msg = j.choices?.[0]?.message || {};

    if (msg.tool_calls?.length) {
      messages.push(msg);
      for (const tc of msg.tool_calls) {
        let args: any = {}; try { args = JSON.parse(tc.function.arguments || '{}'); } catch (_) { /* bad args */ }
        const entry = { why: String(args.why || ''), sql: String(args.sql || ''), rows: [] as any[], error: undefined as string | undefined };
        queries.push(entry);
        let content: string;
        try {
          entry.rows = await runReadOnly(args.sql);
          content = rowsForModel(entry.rows);
          if (!entry.rows.length) content = '[] /* zero rows */';
        } catch (e) {
          entry.error = String((e as Error).message || e).slice(0, 400);
          content = `ERROR: ${entry.error}`;
        }
        messages.push({ role: 'tool', tool_call_id: tc.id, content });
      }
      continue;
    }

    // final answer
    const content = (msg.content || '').trim();
    let out: any = { type: 'answer', answer: content };
    try {
      const p = JSON.parse(content);
      if (p?.type === 'clarify' && Array.isArray(p.options) && p.options.length) {
        return { type: 'clarify', question: String(p.question || 'Which did you mean?'), options: p.options.slice(0, 4).map(String), model: usedModel, usage };
      }
      if (typeof p?.answer === 'string') out = { type: 'answer', answer: p.answer, list_queries: Array.isArray(p.list_queries) ? p.list_queries : (p.list_query ? [p.list_query] : []) };
    } catch (_) { /* plain text */ }

    // clickable records come ONLY from rows the database actually returned
    let records: any[] = [];
    const seen = new Set<string>();
    for (const n of (out.list_queries || []).map(Number)) {
      const q = queries[n - 1];
      if (!q || q.error) continue;
      for (const x of q.rows) {
        if (!x.kind || x.id == null || records.length >= 150) continue;
        const k = `${x.kind}:${x.id}`; if (seen.has(k)) continue; seen.add(k);
        records.push({ kind: String(x.kind), id: Number(x.id), title: String(x.title ?? ''), sub: String(x.sub ?? ''), date: x.follow_up_date ?? x.due_date ?? '' });
      }
    }
    return {
      type: 'answer', answer: out.answer || "I didn't get a response. Try rephrasing.", records,
      evidence: queries.map((q) => ({ why: q.why, sql: q.sql, rowCount: q.rows.length, error: q.error || null, sample: q.rows.slice(0, 3).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, clip(v)]))) })),
      model: usedModel, usage,
    };
  }
  return { type: 'answer', answer: "I couldn't finish that — try asking it more narrowly.", records: [], evidence: [] };
}

// ---------- briefing (fixed queries, deterministic digest) ----------
const BRIEF_QUERIES: Record<string, string> = {
  hot: `select (select count(*) from agent.leads where is_hot and not is_d4d) as hot_outreach, (select count(*) from agent.tasks where is_hot) as hot_tasks`,
  followups: `select (select count(*) from agent.leads where in_main_pipeline and follow_up_date < current_date) as leads_overdue, (select count(*) from agent.leads where in_main_pipeline and follow_up_date = current_date) as leads_due_today, (select count(*) from agent.tasks where follow_up_date < current_date) as tasks_overdue, (select count(*) from agent.tasks where follow_up_date = current_date) as tasks_due_today`,
  oldest_overdue: `select title, follow_up_date, kind from (select title, follow_up_date, kind from agent.leads where in_main_pipeline and follow_up_date < current_date union all select title, follow_up_date, kind from agent.tasks where follow_up_date < current_date) x order by follow_up_date limit 6`,
  probate_batches: `select batch_status, count(*) as batches, sum(lead_count) as leads from agent.probate_batches group by 1`,
  probate_not_texted: `select count(*) filter (where not texted) as not_texted, count(*) as total from agent.probate_crm`,
  scan_never: `select state, county from agent.probate_scan_coverage where never_scanned order by 1,2`,
  scan_stale: `select state, county, days_since_scan from agent.probate_scan_coverage where not never_scanned and days_since_scan > 14 order by days_since_scan desc limit 12`,
  d4d: `select (select max(scanned_at) from agent.d4d_leads) as last_scan, (select count(*) from agent.leads where is_d4d and needs_review) as awaiting_review`,
  sms_7d: `select count(*) filter (where direction='outbound') as sent, count(*) filter (where direction='inbound') as replies, count(*) filter (where is_opt_out) as opt_outs from agent.sms_messages where date_added > now() - interval '7 days'`,
  lists: `select count(*) filter (where last_texted is null) as never_texted, count(*) filter (where last_texted < current_date - 21) as stale_over_21d, count(*) as total from agent.lists`,
};

async function briefing(key: string, model: string, today: string) {
  const digest: Record<string, unknown> = {};
  for (const [k, q] of Object.entries(BRIEF_QUERIES)) {
    try { digest[k] = await runReadOnly(q); } catch (e) { digest[k] = `error: ${(e as Error).message}`; }
  }
  const messages = [
    { role: 'system', content: `You are the Manager Agent for a DMV real-estate wholesaling business. Today is ${today}. Use ONLY the live data provided; use exact numbers; never invent. ${CRM_RULES.replace('{TODAY}', today)}` },
    { role: 'user', content: `Live CRM data (JSON, straight from the database):\n${JSON.stringify(digest)}\n\nGive me today's manager briefing:\n1. **How we're doing** — 2-3 sentence pulse.\n2. **Needs attention now** — most urgent items (overdue follow-ups, probate not texted, scrapes that haven't run / stale counties, hot leads, D4D waiting review). Prioritized bullets with exact numbers.\n3. **Do next** — 3-5 specific actions, most important first.\nKeep it tight.` },
  ];
  const { r, model: m } = await openai(key, model, { max_completion_tokens: 1200, temperature: 0.2, messages });
  if (!r.ok) return errAnswer(r.status, await r.text());
  const j = await r.json();
  const content = (j.choices?.[0]?.message?.content || '').trim();
  return { type: 'answer', answer: content || "I didn't get a response. Try rephrasing.", usage: j.usage || null, model: m };
}

// ---------- entry ----------
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const auth = await requireOwner(admin, req);
    if (!auth.ok) return json({ error: 'forbidden', answer: `🔒 Ask AI is owner-only (${auth.why}). Sign in again as the owner.` });

    const { key, model } = await getConfig(admin);
    if (!key) return json({ error: 'missing_key', answer: "⚠️ The Manager Agent isn't connected yet. Add your OpenAI API key as the Supabase secret OPENAI_API_KEY (Edge Functions → Secrets), then try again." });

    const body = await req.json().catch(() => ({}));
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', dateStyle: 'full' }).format(new Date());
    if (body.mode === 'briefing') return json(await briefing(key, model, today));

    const question = String(body.question || '').slice(0, 2000);
    const history = Array.isArray(body.history) ? body.history.slice(-8) : [];
    return json(await ask(key, model, question, history, today));
  } catch (e) {
    return json({ error: 'exception', answer: '⚠️ Something went wrong on the Manager Agent server. Try again.', detail: String((e as Error).message) });
  }
});
