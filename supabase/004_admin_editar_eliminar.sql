-- 004: permisos para que coordinación edite y elimine solicitudes desde admin/admin.html.
-- Requiere haber ejecutado table.sql, 002 y 003.

grant update (
    empresa, actividad, direccion, contacto, fecha, telefono, fax, email, puesto,
    modalidad, entrevista, horario, vestimenta, otro, checks, estado
) on public.solicitudes_estudiantes to authenticated;

grant delete on public.solicitudes_estudiantes to authenticated;

drop policy if exists solicitudes_delete_coordinacion on public.solicitudes_estudiantes;
create policy solicitudes_delete_coordinacion
    on public.solicitudes_estudiantes
    for delete to authenticated
    using (public.es_coordinador());
