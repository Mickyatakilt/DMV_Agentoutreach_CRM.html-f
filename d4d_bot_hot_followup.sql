-- D4D text bot -> Hot Leads with a follow-up date (Mike, 2026-10-27)
-- When the bot's text 1 or text 2 goes out, the lead moves to the D4D Hot Leads tab (d4d_status = 'hot') and gets a
-- follow-up date = the day the next bot step is due (New York date). A seller reply or a hand-off puts the follow-up
-- date on TODAY so the lead is Due Today. Never touches leads in the mail queue; never pushes a later date Mike set himself.
create or replace function public.d4d_bot_to_hot() returns trigger language plpgsql security definer set search_path = public as $$
declare
  fu text;
  cur record;
begin
  if new.kind is distinct from 'handoff' and new.status = 'sent' and old.status is distinct from 'sent' and new.step in (1, 2) then
    fu := to_char((coalesce(new.sent_at, now()) + interval '24 hours') at time zone 'America/New_York', 'YYYY-MM-DD');
  elsif new.status = 'cancelled' and old.status is distinct from 'cancelled' and coalesce(new.note, '') ilike '%seller replied%' then
    fu := to_char(now() at time zone 'America/New_York', 'YYYY-MM-DD');
  elsif new.kind = 'handoff' and new.status = 'sent' and old.status is distinct from 'sent' then
    fu := to_char(now() at time zone 'America/New_York', 'YYYY-MM-DD');
  else
    return new;
  end if;
  select id, d4d_status, follow_up_date into cur from leads where id = new.lead_id;
  if not found or coalesce(cur.d4d_status, '') in ('mail_queued', 'mail_sent') then return new; end if;
  update leads
     set d4d_status = 'hot',
         follow_up_date = case when coalesce(cur.follow_up_date, '') = '' or cur.follow_up_date < fu or new.status <> 'sent' or new.kind = 'handoff' then fu else cur.follow_up_date end,
         updated_at = now()
   where id = new.lead_id;
  return new;
end $$;

drop trigger if exists d4d_bot_to_hot_trg on public.d4d_bot_queue;
create trigger d4d_bot_to_hot_trg after update of status on public.d4d_bot_queue
  for each row execute function public.d4d_bot_to_hot();

-- one-time catch-up for leads already texted (text 1 sent, text 2 still pending): same rule
update leads l
   set d4d_status = 'hot',
       follow_up_date = to_char(q.send_at at time zone 'America/New_York', 'YYYY-MM-DD'),
       updated_at = now()
  from d4d_bot_queue q
 where q.lead_id = l.id and q.status = 'pending' and q.step = 2 and q.kind = 'text'
   and coalesce(l.d4d_status, '') not in ('mail_queued', 'mail_sent', 'hot')
   and coalesce(l.deleted, false) = false;
