-- Führe dieses Script im Supabase SQL Editor deines Projekts aus.

create table if not exists shopping_lists (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Einkaufsliste',
  created_at timestamptz not null default now()
);

create table if not exists shopping_items (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references shopping_lists(id) on delete cascade,
  text text not null,
  checked boolean not null default false,
  position integer not null default 0,
  category text not null default 'Sonstiges',
  created_at timestamptz not null default now()
);

alter table shopping_items add column if not exists category text not null default 'Sonstiges';
alter table shopping_items add column if not exists important boolean not null default false;

alter table shopping_lists enable row level security;
alter table shopping_items enable row level security;

-- Jeder mit dem Link (list_id) darf lesen/schreiben.
-- Der Zugriffsschutz besteht darin, dass die list_id (UUID) geheim/geteilt bleibt.
-- Policies existieren evtl. schon aus dem ersten Setup-Durchlauf, daher DROP + CREATE.
drop policy if exists "public read lists" on shopping_lists;
create policy "public read lists" on shopping_lists for select using (true);
drop policy if exists "public insert lists" on shopping_lists;
create policy "public insert lists" on shopping_lists for insert with check (true);

drop policy if exists "public read items" on shopping_items;
create policy "public read items" on shopping_items for select using (true);
drop policy if exists "public insert items" on shopping_items;
create policy "public insert items" on shopping_items for insert with check (true);
drop policy if exists "public update items" on shopping_items;
create policy "public update items" on shopping_items for update using (true);
drop policy if exists "public delete items" on shopping_items;
create policy "public delete items" on shopping_items for delete using (true);

-- Realtime für die items-Tabelle aktivieren (falls noch nicht geschehen)
do $$
begin
  alter publication supabase_realtime add table shopping_items;
exception
  when duplicate_object then null;
end $$;
