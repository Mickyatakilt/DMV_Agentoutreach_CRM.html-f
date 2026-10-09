import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let payload: any;
  try { payload = await req.json(); } catch { return json({ error: 'Bad JSON' }, 400); }

  const supa = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } }
  );

  // ---- Verify the caller is a logged-in, enabled CRM user (any role) ----
  const authHeader = req.headers.get('Authorization') || '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return json({ error: 'Not authenticated' }, 401);
  const { data: userData, error: userErr } = await supa.auth.getUser(jwt);
  if (userErr || !userData?.user) return json({ error: 'Invalid session' }, 401);
  const { data: caller } = await supa
    .from('app_users').select('role, disabled, name, email').eq('id', userData.user.id).maybeSingle();
  if (!caller || caller.disabled) return json({ error: 'Access denied' }, 403);
  const isAdmin = caller.role === 'admin';
  const callerName = caller.name || caller.email || 'Someone';

  const action = String(payload.action || '');

  // ---- LIST destinations (label only — webhook URLs never leave this function) ----
  if (action === 'list_destinations') {
    const { data, error } = await supa.from('slack_destinations').select('id, label').order('label', { ascending: true });
    if (error) return json({ error: error.message }, 500);
    return json({ destinations: data || [] });
  }

  // ---- Admin: manage destinations ----
  if (action === 'create') {
    if (!isAdmin) return json({ error: 'Admin access required' }, 403);
    const label = String(payload.label || '').trim();
    const webhook_url = String(payload.webhook_url || '').trim();
    if (!label || !webhook_url.startsWith('https://hooks.slack.com/')) {
      return json({ error: 'Label and a valid Slack webhook URL (https://hooks.slack.com/...) are required' }, 400);
    }
    const { error } = await supa.from('slack_destinations').insert({ label, webhook_url, created_by: callerName });
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }
  if (action === 'update') {
    if (!isAdmin) return json({ error: 'Admin access required' }, 403);
    const id = payload.id; if (!id) return json({ error: 'Missing id' }, 400);
    const patch: any = {};
    if ('label' in payload) patch.label = String(payload.label || '').trim();
    if ('webhook_url' in payload) {
      const w = String(payload.webhook_url || '').trim();
      if (!w.startsWith('https://hooks.slack.com/')) return json({ error: 'Webhook URL must start with https://hooks.slack.com/' }, 400);
      patch.webhook_url = w;
    }
    if (Object.keys(patch).length === 0) return json({ error: 'Nothing to update' }, 400);
    const { error } = await supa.from('slack_destinations').update(patch).eq('id', id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }
  if (action === 'delete') {
    if (!isAdmin) return json({ error: 'Admin access required' }, 403);
    const id = payload.id; if (!id) return json({ error: 'Missing id' }, 400);
    const { error } = await supa.from('slack_destinations').delete().eq('id', id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  // ---- SEND a lead/task to a destination. Lead details are re-read here (service role)
  // rather than trusted from the client, so the message can never be spoofed. ----
  if (action === 'send') {
    const destId = payload.destination_id;
    const kind = payload.kind === 'task' ? 'task' : 'lead';
    const recId = payload.id;
    if (!destId || !recId) return json({ error: 'Missing destination or lead id' }, 400);

    const { data: dest } = await supa.from('slack_destinations').select('webhook_url, label').eq('id', destId).maybeSingle();
    if (!dest) return json({ error: 'Destination not found' }, 404);

    const table = kind === 'task' ? 'jv_leads' : 'leads';
    const { data: rec } = await supa.from(table).select('*').eq('id', recId).maybeSingle();
    if (!rec) return json({ error: (kind === 'task' ? 'Task' : 'Lead') + ' not found' }, 404);

    const address = rec.address || rec.location || 'No address';
    const phone = rec.phone || '';
    const price = rec.offer || rec.asking_price || '';
    const link = (Deno.env.get('CRM_URL') || '') + '?open=' + kind + '&id=' + recId;

    const lines = [
      `*${callerName}* sent you a ${kind === 'task' ? 'task' : 'lead'}:`,
      `*${address}*`,
    ];
    if (phone) lines.push(`Phone: ${phone}`);
    if (price) lines.push(`${kind === 'task' ? 'Asking' : 'Offer'}: ${price}`);
    if (Deno.env.get('CRM_URL')) lines.push(`<${link}|Open in CRM>`);

    const slackRes = await fetch(dest.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: lines.join('\n') }),
    });
    if (!slackRes.ok) return json({ error: 'Slack rejected the message (' + slackRes.status + ')' }, 502);
    return json({ ok: true, sentTo: dest.label });
  }

  return json({ error: 'Unknown action' }, 400);
});
