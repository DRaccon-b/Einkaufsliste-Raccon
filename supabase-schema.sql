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
  created_at timestamptz not null default now()
);

alter table shopping_lists enable row level security;
alter table shopping_items enable row level security;

-- Jeder mit dem Link (list_id) darf lesen/schreiben.
-- Der Zugriffsschutz besteht darin, dass die list_id (UUID) geheim/geteilt bleibt.
create policy "public read lists" on shopping_lists for select using (true);
create policy "public insert lists" on shopping_lists for insert with check (true);

create policy "public read items" on shopping_items for select using (true);
create policy "public insert items" on shopping_items for insert with check (true);
create policy "public update items" on shopping_items for update using (true);
create policy "public delete items" on shopping_items for delete using (true);

-- Realtime für die items-Tabelle aktivieren
alter publication supabase_realtime add table shopping_items;
