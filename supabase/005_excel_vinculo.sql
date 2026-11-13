-- Guarda el único Excel de solicitudes vinculado desde administración.
-- Ejecutar después de table.sql, 002, 003 y 004.

create table if not exists public.excel_vinculo (
    id integer primary key default 1 check (id = 1),
    drive_id text not null,
    item_id text not null,
    nombre text not null,
    url text,
    vinculado_at timestamptz not null default now(),
    ultima_sincronizacion timestamptz,
    filas integer
);

alter table public.excel_vinculo enable row level security;

drop policy if exists "coordinadores leen excel vinculado" on public.excel_vinculo;
create policy "coordinadores leen excel vinculado"
    on public.excel_vinculo for select
    to authenticated
    using (public.es_coordinador());

drop policy if exists "coordinadores desvinculan excel" on public.excel_vinculo;
create policy "coordinadores desvinculan excel"
    on public.excel_vinculo for delete
    to authenticated
    using (public.es_coordinador());

revoke all on public.excel_vinculo from anon, authenticated;
grant select, delete on public.excel_vinculo to authenticated;
