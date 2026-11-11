create table if not exists public.ofertas_anuales (
    ciclo integer primary key check (ciclo between 2026 and 2100),
    estado text not null default 'borrador'
        check (estado in ('borrador', 'publicada', 'cerrada')),
    modalidades jsonb not null default '[]'::jsonb
        check (jsonb_typeof(modalidades) = 'array'),
    updated_at timestamptz not null default timezone('utc'::text, now()),
    updated_by uuid references auth.users(id)
);

create unique index if not exists ofertas_anuales_una_publicada
    on public.ofertas_anuales ((true))
    where estado = 'publicada';

alter table public.solicitudes_estudiantes
    add column if not exists ciclo integer;

update public.solicitudes_estudiantes
set ciclo = extract(year from created_at)::integer
where ciclo is null;

alter table public.solicitudes_estudiantes
    alter column ciclo set not null;

grant insert (ciclo) on public.solicitudes_estudiantes to anon, authenticated;

alter table public.ofertas_anuales enable row level security;
revoke all on table public.ofertas_anuales from public, anon, authenticated;
grant select on public.ofertas_anuales to anon, authenticated;

drop policy if exists ofertas_select_public on public.ofertas_anuales;
drop policy if exists ofertas_select_authenticated on public.ofertas_anuales;

create policy ofertas_select_public
    on public.ofertas_anuales
    for select to anon
    using (estado = 'publicada');

create policy ofertas_select_authenticated
    on public.ofertas_anuales
    for select to authenticated
    using (estado = 'publicada' or public.es_coordinador());

create or replace function public.guardar_oferta_anual(
    p_ciclo integer,
    p_estado text,
    p_modalidades jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    if not public.es_coordinador() then
        raise exception 'Solo coordinación puede administrar ofertas anuales';
    end if;

    if p_ciclo < 2026 or p_ciclo > 2100 then
        raise exception 'El ciclo debe estar entre 2026 y 2100';
    end if;

    if p_estado not in ('borrador', 'publicada', 'cerrada') then
        raise exception 'Estado de oferta no válido';
    end if;

    if jsonb_typeof(p_modalidades) <> 'array' or jsonb_array_length(p_modalidades) = 0 then
        raise exception 'Agregue al menos una modalidad';
    end if;

    if exists (
        select 1
        from jsonb_array_elements(p_modalidades) as modalidad(value)
        where jsonb_typeof(value) <> 'object'
           or coalesce((value->>'horas')::integer, 0) < 1
           or jsonb_typeof(value->'disponible') <> 'boolean'
           or jsonb_typeof(value->'especialidades') <> 'array'
    ) then
        raise exception 'Revise las horas, disponibilidad y especialidades de cada modalidad';
    end if;

    if p_estado = 'publicada' and not exists (
        select 1
        from jsonb_array_elements(p_modalidades) as modalidad(value)
        where value->>'disponible' = 'true'
          and jsonb_array_length(value->'especialidades') > 0
    ) then
        raise exception 'Una oferta publicada debe incluir cupos disponibles';
    end if;

    if p_estado = 'publicada' then
        update public.ofertas_anuales
        set estado = 'cerrada', updated_at = timezone('utc'::text, now())
        where estado = 'publicada' and ciclo <> p_ciclo;
    end if;

    insert into public.ofertas_anuales (ciclo, estado, modalidades, updated_at, updated_by)
    values (p_ciclo, p_estado, p_modalidades, timezone('utc'::text, now()), auth.uid())
    on conflict (ciclo) do update
    set estado = excluded.estado,
        modalidades = excluded.modalidades,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by;
end;
$$;

revoke all on function public.guardar_oferta_anual(integer, text, jsonb) from public;
grant execute on function public.guardar_oferta_anual(integer, text, jsonb) to authenticated;

drop policy if exists solicitudes_insert_public on public.solicitudes_estudiantes;

create policy solicitudes_insert_public
    on public.solicitudes_estudiantes
    for insert to anon
    with check (
        jsonb_typeof(detalle_especialidades) = 'array'
        and jsonb_array_length(detalle_especialidades) > 0
        and exists (
            select 1
            from public.ofertas_anuales oferta
            cross join lateral jsonb_array_elements(oferta.modalidades) as modalidad(value)
            where oferta.estado = 'publicada'
              and oferta.ciclo = solicitudes_estudiantes.ciclo
              and modalidad.value->>'nombre' = solicitudes_estudiantes.modalidad
              and modalidad.value->>'disponible' = 'true'
              and not exists (
                  select 1
                  from jsonb_array_elements(solicitudes_estudiantes.detalle_especialidades) as solicitada(value)
                  where not ((modalidad.value->'especialidades') ? (solicitada.value->>'especialidad'))
                     or coalesce((solicitada.value->>'cantidad')::integer, 0) < 1
              )
        )
    );

insert into public.ofertas_anuales (ciclo, estado, modalidades)
values (
    2026,
    'cerrada',
    '[
        {"nombre":"Pasantía","horas":80,"inicio":"2026-08-03","fin":"2026-08-14","disponible":false,"especialidades":[]},
        {"nombre":"Práctica profesional","horas":320,"inicio":"2026-10-05","fin":"2026-11-27","disponible":true,"especialidades":["Contabilidad y Costos","Contabilidad y Finanzas","Configuración y Soporte de Redes y Sistemas Operativos","Secretariado","Electrónica Industrial"]}
    ]'::jsonb
)
on conflict (ciclo) do nothing;