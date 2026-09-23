import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const AGREEMENT_VERSION = '1.0';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Retry a Supabase op that returns { data, error }. Transient edge->DB blips show up either
// as a thrown error or as a populated `error` field; either way we retry a few times before
// giving up. This is what turns the intermittent 500s the recipients were seeing into a
// silent success on the next attempt.
async function withRetry<T extends { error?: unknown }>(fn: () => Promise<T>, tries = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fn();
      if (res && (res as any).error) { last = (res as any).error; await sleep(150 * (i + 1)); continue; }
      return res;
    } catch (e) {
      last = e; await sleep(150 * (i + 1));
    }
  }
  throw (last instanceof Error) ? last : new Error(String((last as any)?.message || last || 'DB error'));
}

// ---- Deal Analysis (per-recipient ARV / asking / photos link / comps) ----
// Stored in `deal_analyses` jsonb as { "<key>": {...} }. The KEY is decided server-side from
// who the caller is (acceptance-signer name, or portal login email), so a recipient can only
// ever write — and only ever read back — their own entry. Admin sees/edits all.
const nameKey = (first: string, last: string) => 'n:' + (first + ' ' + last).trim().toLowerCase().replace(/\s+/g, ' ');
const emailKey = (email: string) => 'e:' + String(email || '').trim().toLowerCase();

const s = (v: unknown, max = 500) => String(v ?? '').slice(0, max);
function cleanAnalysis(d: any, by: string) {
  d = (d && typeof d === 'object') ? d : {};
  const comps = Array.isArray(d.comps) ? d.comps.slice(0, 30).map((c: any) => ({
    address: s(c?.address, 300), soldPrice: s(c?.soldPrice, 40), soldDate: s(c?.soldDate, 20),
  })).filter((c: any) => c.address || c.soldPrice || c.soldDate) : [];
  return {
    by: s(by, 120), arv: s(d.arv, 40), askingPrice: s(d.askingPrice, 40),
    askingBy: d.askingBy === 'Agent' ? 'Agent' : 'Seller',
    photosLink: s(d.photosLink, 1000), comps, savedAt: new Date().toISOString(),
  };
}
async function saveAnalysis(supa: any, table: string, leadId: number, key: string, data: any, by: string) {
  const { data: row } = await withRetry(() => supa.from(table).select('deal_analyses').eq('id', leadId).maybeSingle());
  const all = (row && row.deal_analyses && typeof row.deal_analyses === 'object') ? row.deal_analyses : {};
  const prev = all[key] || {};
  all[key] = { ...cleanAnalysis(data, by || prev.by || ''), firstSavedAt: prev.firstSavedAt || prev.savedAt || new Date().toISOString() };
  const { error } = await withRetry(() => supa.from(table).update({ deal_analyses: all }).eq('id', leadId));
  if (error) throw new Error((error as any).message || 'save failed');
  return all[key];
}
// Hide everyone else's analyses from a recipient.
function onlyMine(lead: any, key: string) {
  const all = (lead && lead.deal_analyses) || {};
  return { ...lead, deal_analyses: all[key] ? { [key]: all[key] } : {}, deal_analysis_key: key };
}

// ---- Comments feature: shared auth + scope helpers ----
// Resolves the caller's app_users row from their Supabase Auth JWT. Used by every
// comments_* action below (list / add / unread), same identity model portal_save already uses.
async function authCaller(supa: any, req: Request) {
  const authHeader = req.headers.get('Authorization') || '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return { error: json({ error: 'Not signed in' }, 401) };
  const { data: userData, error: userErr } = await supa.auth.getUser(jwt);
  if (userErr || !userData?.user) return { error: json({ error: 'Invalid session' }, 401) };
  const { data: prof } = await withRetry(() => supa
    .from('app_users')
    .select('id, email, name, role, disabled, scope_dmv, scope_nationwide, scope_emailed')
    .eq('id', userData.user.id).maybeSingle());
  if (!prof || prof.disabled) return { error: json({ error: 'Account not active' }, 403) };
  return { prof };
}

// Same scope rule portal_save enforces for recipient reads/writes on a lead — recipients only
// ever see leads that match their assigned scope; admins/team see everything.
function leadInScope(prof: any, lead: any, kind: string) {
  if (prof.role === 'admin' || prof.role === 'team') return true;
  const email = (prof.email || '').trim().toLowerCase();
  const sharedWith = (lead.shared_with || '').trim().toLowerCase();
  const isNationwide = lead.nationwide === 'Yes';
  if (kind === 'lead') {
    if (prof.scope_nationwide && isNationwide) return true;
    if (prof.scope_dmv && !isNationwide) return true;
    if (prof.scope_emailed && email && sharedWith === email) return true;
    return false;
  }
  return !!(prof.scope_emailed && email && sharedWith === email);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    let payload: any;
    try { payload = await req.json(); } catch { return json({ error: 'Bad JSON' }, 400); }

    const action = String(payload.action || '');
    const kind = payload.kind === 'task' ? 'task' : 'lead';
    const table = kind === 'task' ? 'jv_leads' : 'leads';
    const leadId = parseInt(payload.leadId, 10);
    // comments_unread scans across every lead the caller has been mentioned on, so it never
    // takes a leadId — every other action operates on one specific lead and requires it.
    if (action !== 'comments_unread' && !leadId && leadId !== 0) return json({ error: 'Missing leadId' }, 400);

    const supa = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false } }
    );

    // ---- GET: reveal the lead ONLY if this viewer holds a valid acceptance token ----
    if (action === 'get') {
      const token = String(payload.token || '');
      if (!token) return json({ needsAgreement: true });
      const { data: acc } = await withRetry(() => supa
        .from('lead_agreements')
        .select('id, first_name, last_name')
        .eq('lead_id', leadId).eq('kind', kind).eq('token', token)
        .maybeSingle());
      if (!acc) return json({ needsAgreement: true });
      const { data: lead } = await withRetry(() => supa.from(table).select('*').eq('id', leadId).maybeSingle());
      if (!lead) return json({ error: 'Lead not found' }, 404);
      return json({ lead: onlyMine(lead, nameKey(acc.first_name || '', acc.last_name || '')) });
    }

    // ---- ACCEPT: record acceptance, flip status, hand back a token + the lead ----
    if (action === 'accept') {
      const firstName = String(payload.firstName || '').trim();
      const lastName = String(payload.lastName || '').trim();
      if (!firstName || !lastName) return json({ error: 'First and last name are required.' }, 400);

      const { data: lead } = await withRetry(() => supa.from(table).select('*').eq('id', leadId).maybeSingle());
      if (!lead) return json({ error: 'Lead not found' }, 404);

      const address = kind === 'task' ? (lead.location || '') : (lead.address || '');
      const email = String(payload.email || lead.shared_with || '').trim();
      const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim();
      const ua = req.headers.get('user-agent') || '';
      const token = crypto.randomUUID();
      const now = new Date();
      const nowIso = now.toISOString();
      const nowDate = nowIso.slice(0, 10);

      const { error: insErr } = await withRetry(() => supa.from('lead_agreements').insert({
        lead_id: leadId, kind, first_name: firstName, last_name: lastName, email,
        property_address: address, agreement_version: AGREEMENT_VERSION, status: 'accepted',
        ip, user_agent: ua, token, accepted_at: nowIso, revealed_at: nowIso,
      }));
      if (insErr) return json({ error: 'Could not record acceptance: ' + (insErr as any).message }, 500);

      try {
        await withRetry(() => supa.from(table).update({
          agreement_status: 'Accepted', agreement_accepted_at: nowDate,
        }).eq('id', leadId));
      } catch (_e) { /* audit row is already saved; status flip is best-effort */ }

      const revealed = { ...lead, agreement_status: 'Accepted', agreement_accepted_at: nowDate };
      return json({ token, lead: onlyMine(revealed, nameKey(firstName, lastName)), version: AGREEMENT_VERSION, acceptedAt: nowIso });
    }

    // ---- RECIPIENT_SAVE: anonymous shared-link recipient updates allowed fields.
    // Gated on a valid acceptance token. Only whitelisted columns apply. ----
    if (action === 'recipient_save') {
      const token = String(payload.token || '');
      if (!token) return json({ needsAgreement: true });
      const { data: acc } = await withRetry(() => supa
        .from('lead_agreements')
        .select('id, first_name, last_name')
        .eq('lead_id', leadId).eq('kind', kind).eq('token', token)
        .maybeSingle());
      if (!acc) return json({ needsAgreement: true });

      const patch = (payload.patch && typeof payload.patch === 'object') ? payload.patch : {};
      let analysis: unknown = undefined;
      if (patch.deal_analysis) {
        const by = ((acc.first_name || '') + ' ' + (acc.last_name || '')).trim();
        try { analysis = await saveAnalysis(supa, table, leadId, nameKey(acc.first_name || '', acc.last_name || ''), patch.deal_analysis, by); }
        catch (e) { return json({ error: 'Could not save: ' + ((e as any)?.message || e) }, 500); }
      }
      const allowedLead = ['marketing_type', 'status', 'score', 'recipient_follow_up_date', 'recipient_notes', 'activity_log', 'updated_by', 'updated_at', 'beds', 'baths', 'sqft', 'needs_review', 'review_sent_by', 'review_sent_at', 'review_note'];
      const allowedTask = ['jv_status', 'score', 'recipient_follow_up_date', 'recipient_notes', 'activity_log', 'beds', 'baths', 'sqft', 'needs_review', 'review_sent_by', 'review_sent_at', 'review_note'];
      const allowed = kind === 'task' ? allowedTask : allowedLead;
      const clean: Record<string, unknown> = {};
      for (const k of allowed) if (k in patch) clean[k] = patch[k];
      if (Object.keys(clean).length === 0) {
        if (analysis) return json({ ok: true, analysis });
        return json({ error: 'Nothing to save' }, 400);
      }

      const { error } = await withRetry(() => supa.from(table).update(clean).eq('id', leadId));
      if (error) return json({ error: 'Could not save: ' + (error as any).message }, 500);
      return json({ ok: true, analysis });
    }

    // ---- PORTAL_SAVE: a LOGGED-IN recipient (JWT, no acceptance token) updates a lead from the
    // recipient portal. We verify the caller's session, confirm the lead is within THEIR scope,
    // and apply the same whitelisted editable fields as the emailed shared link. ----
    if (action === 'portal_save') {
      const auth = await authCaller(supa, req);
      if (auth.error) return auth.error;
      const prof = auth.prof;

      const { data: lead } = await withRetry(() => supa.from(table).select('*').eq('id', leadId).maybeSingle());
      if (!lead) return json({ error: 'Lead not found' }, 404);
      if (lead.deleted) return json({ error: 'Lead not available' }, 404);

      // Admins/team can save anything; recipients only within their scope.
      const isStaff = (prof.role === 'admin' || prof.role === 'team');
      const inScope = isStaff || leadInScope(prof, lead, kind);
      if (!inScope) return json({ error: 'This lead is not in your account' }, 403);

      const patch = (payload.patch && typeof payload.patch === 'object') ? payload.patch : {};
      let analysis: unknown = undefined;
      if (patch.deal_analysis) {
        // Staff may edit any recipient's entry (by key); recipients only their own.
        const reqKey = String(payload.analysisKey || '');
        const key = (isStaff && reqKey) ? reqKey : emailKey(prof.email || '');
        const by = (isStaff && reqKey) ? '' : (prof.name || prof.email || '');
        try { analysis = await saveAnalysis(supa, table, leadId, key, patch.deal_analysis, by); }
        catch (e) { return json({ error: 'Could not save: ' + ((e as any)?.message || e) }, 500); }
      }
      // Logged-in recipients get the same editable field set as the emailed shared link,
      // so the portal detail view mirrors what they'd see if the lead were emailed to them.
      const allowedLead = ['marketing_type', 'status', 'score', 'recipient_follow_up_date', 'recipient_notes', 'activity_log', 'updated_by', 'updated_at', 'beds', 'baths', 'sqft', 'needs_review', 'review_sent_by', 'review_sent_at', 'review_note'];
      const allowedTask = ['jv_status', 'score', 'recipient_follow_up_date', 'recipient_notes', 'activity_log', 'beds', 'baths', 'sqft', 'needs_review', 'review_sent_by', 'review_sent_at', 'review_note'];
      const allowed = kind === 'task' ? allowedTask : allowedLead;
      const clean: Record<string, unknown> = {};
      for (const k of allowed) if (k in patch) clean[k] = patch[k];
      if (Object.keys(clean).length === 0) {
        if (analysis) return json({ ok: true, analysis });
        return json({ error: 'Nothing to save' }, 400);
      }

      const { error } = await withRetry(() => supa.from(table).update(clean).eq('id', leadId));
      if (error) return json({ error: 'Could not save: ' + (error as any).message }, 500);
      return json({ ok: true, analysis });
    }

    // ---- COMMENTS_LIST / COMMENTS_ADD: shared identity resolution. Three kinds of caller can
    // reach these: staff (admin/team, JWT), a signed-in recipient portal user (JWT + scope
    // check), or an anonymous emailed-link recipient (acceptance token, same as get/recipient_save
    // above) — that last one is the normal way a lead reaches someone by email in this CRM, so
    // they get a name-only identity built from whatever first/last name they typed at the
    // agreement gate. Nothing here trusts the client for who's allowed to see or post what. ----
    if (action === 'comments_list' || action === 'comments_add' || action === 'comments_edit') {
      const { data: lead } = await withRetry(() => supa.from(table).select('*').eq('id', leadId).maybeSingle());
      if (!lead || lead.deleted) return json({ error: 'Lead not found' }, 404);

      let me: { id: string | null; name: string; role: string; isStaff: boolean } | null = null;

      const authHeader = req.headers.get('Authorization') || '';
      const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
      if (jwt) {
        const { data: userData } = await supa.auth.getUser(jwt);
        if (userData?.user) {
          const { data: prof } = await withRetry(() => supa
            .from('app_users')
            .select('id, email, name, role, disabled, scope_dmv, scope_nationwide, scope_emailed')
            .eq('id', userData.user.id).maybeSingle());
          if (prof && !prof.disabled) {
            const isStaff = prof.role === 'admin' || prof.role === 'team';
            if (isStaff || leadInScope(prof, lead, kind)) {
              me = { id: prof.id, name: prof.name || prof.email || 'User', role: prof.role, isStaff };
            }
          }
        }
      }
      if (!me) {
        const token = String(payload.token || '');
        if (token) {
          const { data: acc } = await withRetry(() => supa
            .from('lead_agreements')
            .select('id, first_name, last_name')
            .eq('lead_id', leadId).eq('kind', kind).eq('token', token)
            .maybeSingle());
          if (acc) {
            const nm = ((acc.first_name || '') + ' ' + (acc.last_name || '')).trim() || 'Recipient';
            me = { id: null, name: nm, role: 'recipient', isStaff: false };
          }
        }
      }
      if (!me) return json({ error: 'Not signed in' }, 401);

      // Mentionable roster: staff always visible; recipients (portal or anonymous) only see
      // staff — they have no way to know who else a lead was shared with. Staff additionally
      // see whichever portal recipients are in-scope for this specific lead.
      const { data: staffRows } = await withRetry(() => supa
        .from('app_users').select('id, name, role').eq('disabled', false).in('role', ['admin', 'team']));
      let mentionable = (staffRows || []).map((u: any) => ({ id: u.id, name: u.name, role: u.role }));
      const validIds = new Set((staffRows || []).map((u: any) => u.id));
      if (me.isStaff) {
        const { data: recipRows } = await withRetry(() => supa
          .from('app_users').select('id, name, role, email, scope_dmv, scope_nationwide, scope_emailed')
          .eq('disabled', false).eq('role', 'recipient'));
        const inScopeRecips = (recipRows || []).filter((u: any) => leadInScope(u, lead, kind));
        mentionable = mentionable.concat(inScopeRecips.map((u: any) => ({ id: u.id, name: u.name, role: u.role })));
        for (const u of inScopeRecips) validIds.add(u.id);
      }

      if (action === 'comments_list') {
        const { data: rows } = await withRetry(() => supa
          .from('lead_comments').select('*')
          .eq('kind', kind).eq('lead_id', leadId).eq('deleted', false)
          .order('created_at', { ascending: true }));

        // Only an identified (uuid) caller has a read-marker row to update — an anonymous
        // link visitor has no durable identity across visits, so there's nothing to mark.
        if (me.id) {
          try {
            await supa.from('lead_comment_reads').upsert(
              { user_id: me.id, kind, lead_id: leadId, last_read_at: new Date().toISOString() },
              { onConflict: 'user_id,kind,lead_id' }
            );
          } catch (_e) { /* best-effort — a missed read-marker just means the dot stays lit */ }
        }

        return json({ comments: rows || [], mentionable, me: { id: me.id, name: me.name, role: me.role } });
      }

      // comments_edit — only the comment's own author can change its text.
      if (action === 'comments_edit') {
        const commentId = parseInt(payload.commentId, 10);
        const body = String(payload.body || '').trim().slice(0, 4000);
        if (!commentId) return json({ error: 'Missing commentId' }, 400);
        if (!body) return json({ error: 'Comment is empty' }, 400);
        const { data: c } = await withRetry(() => supa.from('lead_comments').select('*')
          .eq('id', commentId).eq('kind', kind).eq('lead_id', leadId).eq('deleted', false).maybeSingle());
        if (!c) return json({ error: 'Comment not found' }, 404);
        const isAuthor = me.id ? c.author_id === me.id : (!c.author_id && c.author_name === me.name);
        if (!isAuthor) return json({ error: 'You can only edit your own comments' }, 403);
        const rawMentions = Array.isArray(payload.mentions) ? payload.mentions : [];
        const mentions = rawMentions.filter((id: string) => validIds.has(id)).slice(0, 20);
        const { data: updated, error } = await withRetry(() => supa.from('lead_comments')
          .update({ body, mentions, edited_at: new Date().toISOString() })
          .eq('id', commentId).select('*').maybeSingle());
        if (error) return json({ error: 'Could not save: ' + (error as any).message }, 500);
        return json({ comment: updated });
      }

      // comments_add
      const body = String(payload.body || '').trim().slice(0, 4000);
      if (!body) return json({ error: 'Comment is empty' }, 400);
      const parentId = payload.parentId ? parseInt(payload.parentId, 10) : null;

      const rawMentions = Array.isArray(payload.mentions) ? payload.mentions : [];
      const mentions = rawMentions.filter((id: string) => validIds.has(id)).slice(0, 20);

      const { data: inserted, error } = await withRetry(() => supa.from('lead_comments').insert({
        kind, lead_id: leadId, parent_id: parentId,
        author_id: me.id, author_name: me.name, author_role: me.role,
        body, mentions,
      }).select('*').maybeSingle());
      if (error) return json({ error: 'Could not post: ' + (error as any).message }, 500);

      if (me.id) {
        try {
          await supa.from('lead_comment_reads').upsert(
            { user_id: me.id, kind, lead_id: leadId, last_read_at: new Date().toISOString() },
            { onConflict: 'user_id,kind,lead_id' }
          );
        } catch (_e) { /* best-effort */ }
      }

      return json({ comment: inserted });
    }

    // ---- COMMENTS_UNREAD: every {kind,leadId} where the caller has an unread @mention.
    // Powers the red dot on list rows / the modal's comment tab. No leadId required for this
    // action — it looks across every thread the caller has ever been tagged in. ----
    if (action === 'comments_unread') {
      const auth = await authCaller(supa, req);
      if (auth.error) return auth.error;
      const prof = auth.prof;

      const { data: mentionRows } = await withRetry(() => supa
        .from('lead_comments').select('kind, lead_id, created_at')
        .contains('mentions', [prof.id])
        .eq('deleted', false)
        .order('created_at', { ascending: false })
        .limit(500));

      const { data: readRows } = await withRetry(() => supa
        .from('lead_comment_reads').select('kind, lead_id, last_read_at').eq('user_id', prof.id));
      const readMap = new Map((readRows || []).map((r: any) => [r.kind + ':' + r.lead_id, r.last_read_at]));

      const unread = new Set<string>();
      for (const m of (mentionRows || [])) {
        const key = m.kind + ':' + m.lead_id;
        const lastRead = readMap.get(key);
        if (!lastRead || new Date(m.created_at) > new Date(lastRead as string)) unread.add(key);
      }
      return json({ unread: Array.from(unread) });
    }

    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    return json({ error: 'Server error: ' + ((e as any)?.message || String(e)) }, 500);
  }
});
