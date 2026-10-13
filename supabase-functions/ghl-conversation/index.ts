import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const GHL = 'https://services.leadconnectorhq.com';
const VER = '2021-04-15'; // Conversations API version

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

// Decode the role claim from the caller's Supabase JWT. SMS content is sensitive and sending
// costs money, so we reject the public anon key (role 'anon') and only serve logged-in users.
function jwtRole(auth: string | null): string {
  try {
    const t = (auth || '').replace(/^Bearer\s+/i, '');
    const p = t.split('.')[1];
    const b = p.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b + '='.repeat((4 - (b.length % 4)) % 4);
    const obj = JSON.parse(atob(pad));
    return String(obj.role || '');
  } catch (_e) { return ''; }
}

async function ghlCreds() {
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data: cfg, error } = await admin.from('app_config').select('key,value').in('key', ['ghl_token', 'ghl_location_id']);
  if (error) throw error;
  const map = Object.fromEntries((cfg || []).map((r) => [r.key, r.value]));
  if (!map['ghl_token'] || !map['ghl_location_id']) throw new Error('missing_ghl_config');
  return { token: map['ghl_token'], loc: map['ghl_location_id'] };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const role = jwtRole(req.headers.get('authorization'));
    if (role === 'anon' || role === '') return json({ ok: false, reason: 'not_authorized', message: 'Sign in to use messaging.' }, 401);

    const payload = await req.json();
    const action = payload.action || 'thread';
    const { token, loc } = await ghlCreds();
    const H = { Authorization: `Bearer ${token}`, Version: VER, Accept: 'application/json' };

    // ---- SEND an SMS ----
    if (action === 'send') {
      const contactId = payload.contactId;
      const message = String(payload.message || '').trim();
      if (!contactId || typeof contactId !== 'string') return json({ ok: false, reason: 'missing_contactId' });
      if (!message) return json({ ok: false, reason: 'empty_message' });
      const sr = await fetch(`${GHL}/conversations/messages`, {
        method: 'POST',
        headers: { ...H, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'SMS', contactId, message }),
      });
      const sText = await sr.text();
      if (!sr.ok) return json({ ok: false, stage: 'send', status: sr.status, scopeOk: sr.status !== 401 && sr.status !== 403, body: sText.slice(0, 400) });
      let sj: any = {};
      try { sj = JSON.parse(sText); } catch (_e) { /* ignore */ }
      return json({ ok: true, sent: true, messageId: sj.messageId || sj.id || null, conversationId: sj.conversationId || null });
    }

    // ---- READ the thread (default) / READ call log (action 'calls') ----
    const contactId = payload.contactId;
    if (!contactId || typeof contactId !== 'string') return json({ ok: false, reason: 'missing_contactId' });
    const wantCalls = action === 'calls';

    const sUrl = `${GHL}/conversations/search?locationId=${encodeURIComponent(loc)}&contactId=${encodeURIComponent(contactId)}`;
    const sr = await fetch(sUrl, { headers: H });
    const sText = await sr.text();
    if (!sr.ok) return json({ ok: false, stage: 'search', status: sr.status, scopeOk: sr.status !== 401 && sr.status !== 403, body: sText.slice(0, 400) });
    let sj: any = {};
    try { sj = JSON.parse(sText); } catch (_e) { /* ignore */ }
    const convs = sj.conversations || [];
    if (!convs.length) return json({ ok: true, scopeOk: true, conversationId: null, messages: [], calls: [], note: 'no_conversation' });
    convs.sort((a: any, b: any) => (b.lastMessageDate || 0) - (a.lastMessageDate || 0));
    const convId = convs[0].id;

    const lim = wantCalls ? 100 : (Number(payload.limit) || 50);
    const mUrl = `${GHL}/conversations/${encodeURIComponent(convId)}/messages?limit=${lim}`;
    const mr = await fetch(mUrl, { headers: H });
    const mText = await mr.text();
    if (!mr.ok) return json({ ok: false, stage: 'messages', status: mr.status, scopeOk: mr.status !== 401 && mr.status !== 403, conversationId: convId, body: mText.slice(0, 400) });
    let mj: any = {};
    try { mj = JSON.parse(mText); } catch (_e) { /* ignore */ }
    const raw = (mj.messages && mj.messages.messages) || mj.messages || [];

    if (wantCalls) {
      // team-member names (best effort) so the log can say who made each call
      const names: Record<string, string> = {};
      try {
        const ur = await fetch(`${GHL}/users/?locationId=${encodeURIComponent(loc)}`, { headers: { ...H, Version: '2021-07-28' } });
        if (ur.ok) { const uj: any = await ur.json(); (uj.users || []).forEach((u: any) => { names[u.id] = u.name || [u.firstName, u.lastName].filter(Boolean).join(' '); }); }
      } catch (_e) { /* names are optional */ }
      const calls = raw
        .filter((m: any) => String(m.messageType || m.type || '').toUpperCase().includes('CALL'))
        .map((m: any) => {
          const c = (m.meta && m.meta.call) || {};
          return {
            id: m.id,
            direction: m.direction || '',
            status: c.status || m.status || '',
            duration: Number(c.duration ?? m.duration ?? 0) || 0,
            dateAdded: m.dateAdded || '',
            by: (m.userId && names[m.userId]) || '',
            from: m.from || '',
            to: m.to || '',
            recordingUrl: m.attachments && m.attachments[0] ? (m.attachments[0].url || m.attachments[0]) : '',
          };
        })
        .sort((a: any, b: any) => new Date(b.dateAdded || 0).getTime() - new Date(a.dateAdded || 0).getTime());
      return json({ ok: true, scopeOk: true, conversationId: convId, count: calls.length, calls });
    }

    const norm = raw
      .filter((m: any) => String(m.messageType || m.type || '').toUpperCase().includes('SMS'))
      .map((m: any) => ({ id: m.id, direction: m.direction || '', body: m.body || '', dateAdded: m.dateAdded || '', status: m.status || '', messageType: m.messageType || m.type || '' }))
      .sort((a: any, b: any) => new Date(a.dateAdded || 0).getTime() - new Date(b.dateAdded || 0).getTime());
    return json({ ok: true, scopeOk: true, conversationId: convId, count: norm.length, messages: norm });
  } catch (e) {
    return json({ ok: false, reason: 'exception', error: String((e as Error).message) });
  }
});
