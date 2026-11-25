// send-skiptrace — emails the skip tracer a CSV (Full Name, Address) for the probate leads ticked in the CRM.
// Body: { ids: number[] }. Called from the CRM with the user's JWT (verify_jwt = true).
// Rules (decided with Mike, 2026-11-25):
//   * Name    = personal representative (pr_name), else the decedent.
//   * Address = the PR's own mailing address (pr_address, i.e. the absentee address) when there is one,
//               otherwise the property address.
//   * Only leads that are NOT skip-traced (lead and its batch) and NOT already sent are included.
//   * Leads are stamped skiptrace_sent_at / skiptrace_sent_to only AFTER the email is accepted.
// Recipient: app_config key 'skiptrace_email' if set, else the default below. Mail goes out through Resend.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const RESEND_KEY = Deno.env.get('RESEND_API_KEY') || '';
const MAIL_FROM = Deno.env.get('RESEND_FROM') || 'MEstate <contact@mestate.info>';
const DEFAULT_TO = 'mntraceservices@gmail.com';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
const clean = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim();
const cell = (v: string) => (/[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
const b64 = (s: string) => { const u = new TextEncoder().encode(s); let bin = ''; for (const c of u) bin += String.fromCharCode(c); return btoa(bin); };

function nameAddr(r: any): { name: string; address: string } {
  const name = clean(r.pr_name) || clean(r.decedent_name);
  let address = clean(r.pr_address);
  if (!address) {
    address = [clean(r.property_address), clean(r.property_city), clean(r.state) + ' ' + clean(r.property_zip)]
      .map((x) => x.trim()).filter(Boolean).join(', ');
  }
  return { name, address };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    if (!RESEND_KEY) return json({ ok: false, reason: 'no_resend_key' }, 500);
    const b: any = await req.json().catch(() => ({}));
    const ids: number[] = Array.isArray(b.ids) ? b.ids.map((x: unknown) => Number(x)).filter((x: number) => Number.isFinite(x)) : [];
    if (!ids.length) return json({ ok: false, reason: 'no_ids' }, 400);
    if (ids.length > 5000) return json({ ok: false, reason: 'too_many', max: 5000 }, 400);

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: cf } = await admin.from('app_config').select('value').eq('key', 'skiptrace_email').limit(1);
    const to = (cf && cf[0] && String(cf[0].value || '').trim()) || DEFAULT_TO;

    // Load the leads (chunked) and the batch statuses.
    const rows: any[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await admin.from('crm_probate')
        .select('id,state,decedent_name,pr_name,pr_address,property_address,property_city,property_zip,date_pulled,skiptraced_at,skiptrace_sent_at')
        .in('id', ids.slice(i, i + 200));
      if (error) return json({ ok: false, reason: 'db_error', error: error.message }, 500);
      rows.push(...(data || []));
    }
    const { data: bt } = await admin.from('crm_probate_batches').select('date_pulled,state,skiptraced');
    const done = new Set((bt || []).filter((x: any) => x.skiptraced === 'Yes' || x.skiptraced === 'Texted').map((x: any) => (x.date_pulled || '') + '|' + (x.state || '')));

    let skipTraced = 0, skipSent = 0, skipNoData = 0;
    const send: { id: number; name: string; address: string }[] = [];
    for (const r of rows) {
      if (r.skiptraced_at || done.has((r.date_pulled || '') + '|' + (r.state || ''))) { skipTraced++; continue; }
      if (r.skiptrace_sent_at) { skipSent++; continue; }
      const na = nameAddr(r);
      if (!na.name || !na.address) { skipNoData++; continue; }
      send.push({ id: r.id, ...na });
    }
    if (!send.length) return json({ ok: false, reason: 'nothing_to_send', skipTraced, skipSent, skipNoData });

    const csv = 'Full Name,Address\n' + send.map((x) => cell(x.name) + ',' + cell(x.address)).join('\n') + '\n';
    const day = new Date().toISOString().slice(0, 10);
    const filename = 'skiptrace-' + day + '-' + send.length + '-leads.csv';
    const html = '<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#0f172a;font-size:14.5px">'
      + '<p>Hi,</p><p>Attached is a skip trace list: <b>' + send.length + '</b> record' + (send.length !== 1 ? 's' : '')
      + ' (Full Name, Address). Please send back the phone numbers you find, keeping the same name and address on each row.</p><p>Thank you.</p></div>';
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: MAIL_FROM, to: [to],
        subject: 'Skip trace list - ' + send.length + ' record' + (send.length !== 1 ? 's' : '') + ' - ' + day,
        html, attachments: [{ filename, content: b64(csv) }],
      }),
      signal: AbortSignal.timeout(25000),
    });
    if (!r.ok) return json({ ok: false, reason: 'mail_failed', status: r.status, detail: (await r.text()).slice(0, 300) }, 502);

    const now = new Date().toISOString();
    const sentIds = send.map((x) => x.id);
    for (let i = 0; i < sentIds.length; i += 200) {
      await admin.from('crm_probate').update({ skiptrace_sent_at: now, skiptrace_sent_to: to }).in('id', sentIds.slice(i, i + 200));
    }
    return json({ ok: true, sent: send.length, to, sentAt: now, ids: sentIds, skipTraced, skipSent, skipNoData });
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message) }, 500);
  }
});
