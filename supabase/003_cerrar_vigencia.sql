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
              and modalidad.value->>'fin' is not null
              and (modalidad.value->>'fin')::date >= current_date
              and not exists (
                  select 1
                  from jsonb_array_elements(solicitudes_estudiantes.detalle_especialidades) as solicitada(value)
                  where not ((modalidad.value->'especialidades') ? (solicitada.value->>'especialidad'))
                     or coalesce((solicitada.value->>'cantidad')::integer, 0) < 1
              )
        )
    );