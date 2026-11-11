import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const WEBHOOK_SECRET = Deno.env.get('WEBHOOK_SECRET') ?? '';
const MS_TENANT_ID = Deno.env.get('MS_TENANT_ID') ?? '';
const MS_CLIENT_ID = Deno.env.get('MS_CLIENT_ID') ?? '';
const MS_CLIENT_SECRET = Deno.env.get('MS_CLIENT_SECRET') ?? '';
const EXCEL_DRIVE_ID = Deno.env.get('EXCEL_DRIVE_ID') ?? '';
const EXCEL_ITEM_ID = Deno.env.get('EXCEL_ITEM_ID') ?? '';

const SHEET_NAME = 'Solicitudes';
const PAGE_SIZE = 1000;
const WRITE_CHUNK = 500;

const HEADERS = [
	'N.º solicitud',
	'Ciclo',
	'Fecha de ingreso',
	'Empresa',
	'Actividad',
	'Modalidad',
	'Especialidades y cantidades',
	'Contacto',
	'Correo',
	'Teléfono',
	'Dirección',
	'Puesto',
	'Entrevista',
	'Horario',
	'Vestimenta',
	'Otros requisitos',
	'Beneficios',
	'Estado'
];

const STATUS_LABELS: Record<string, string> = {
	recibida: 'Recibida',
	en_revision: 'En revisión',
	contactada: 'Contactada',
	cerrada: 'Cerrada'
};

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
	auth: { persistSession: false, autoRefreshToken: false }
});

// Serializa las sincronizaciones para que dos webhooks seguidos no se pisen.
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
	const run = queue.then(task, task);
	queue = run.catch(() => undefined);
	return run;
}

function safeCell(value: unknown): string | number {
	if (value === null || value === undefined) return '';
	if (typeof value === 'number') return value;
	if (typeof value === 'boolean') return value ? 'Sí' : 'No';
	if (Array.isArray(value)) return safeCell(value.join(', '));
	if (typeof value === 'object') return safeCell(JSON.stringify(value));
	const text = String(value);
	// Evita que Excel interprete el texto como fórmula.
	return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function formatSpecialties(row: Record<string, unknown>): string {
	let details = row.detalle_especialidades;
	if (typeof details === 'string') {
		try { details = JSON.parse(details); } catch { details = []; }
	}
	if (Array.isArray(details) && details.length) {
		return details
			.map((item: { especialidad?: string; cantidad?: number }) => `${item.especialidad} (${item.cantidad})`)
			.join(', ');
	}
	return String(row.especialidades_requeridas ?? '');
}

function formatDate(row: Record<string, unknown>): string {
	const source = row.created_at ? new Date(String(row.created_at)) : null;
	if (source && !Number.isNaN(source.getTime())) {
		return source.toLocaleString('es-CR', { timeZone: 'America/Costa_Rica' });
	}
	return String(row.fecha ?? '');
}

function toSheetRow(row: Record<string, unknown>): (string | number)[] {
	return [
		safeCell(row.id),
		safeCell(row.ciclo),
		safeCell(formatDate(row)),
		safeCell(row.empresa),
		safeCell(row.actividad),
		safeCell(row.modalidad),
		safeCell(formatSpecialties(row)),
		safeCell(row.contacto),
		safeCell(row.email),
		safeCell(row.telefono),
		safeCell(row.direccion),
		safeCell(row.puesto),
		safeCell(row.entrevista),
		safeCell(row.horario),
		safeCell(row.vestimenta),
		safeCell(row.otro),
		safeCell(row.checks),
		safeCell(STATUS_LABELS[String(row.estado ?? 'recibida')] ?? row.estado)
	];
}

async function fetchAllRequests(): Promise<Record<string, unknown>[]> {
	const rows: Record<string, unknown>[] = [];
	for (let from = 0; ; from += PAGE_SIZE) {
		const { data, error } = await db
			.from('solicitudes_estudiantes')
			.select('*')
			.order('id', { ascending: true })
			.range(from, from + PAGE_SIZE - 1);
		if (error) throw new Error(`Supabase: ${error.message}`);
		rows.push(...(data ?? []));
		if (!data || data.length < PAGE_SIZE) break;
	}
	return rows;
}

async function getGraphToken(): Promise<string> {
	const body = new URLSearchParams({
		client_id: MS_CLIENT_ID,
		client_secret: MS_CLIENT_SECRET,
		scope: 'https://graph.microsoft.com/.default',
		grant_type: 'client_credentials'
	});
	const response = await fetch(`https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body
	});
	const json = await response.json();
	if (!response.ok) throw new Error(`Token Microsoft: ${json.error_description ?? response.status}`);
	return json.access_token as string;
}

async function graph(token: string, path: string, init: RequestInit = {}): Promise<Response> {
	return fetch(`https://graph.microsoft.com/v1.0/drives/${EXCEL_DRIVE_ID}/items/${EXCEL_ITEM_ID}/workbook${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
			...(init.headers ?? {})
		}
	});
}

async function ensureWorksheet(token: string): Promise<void> {
	const check = await graph(token, `/worksheets/${encodeURIComponent(SHEET_NAME)}`);
	if (check.ok) return;
	if (check.status !== 404) throw new Error(`Excel (hoja): HTTP ${check.status}`);
	const created = await graph(token, '/worksheets', {
		method: 'POST',
		body: JSON.stringify({ name: SHEET_NAME })
	});
	if (!created.ok) throw new Error(`Excel (crear hoja): HTTP ${created.status}`);
}

async function writeRange(token: string, address: string, values: unknown[][]): Promise<void> {
	const response = await graph(token, `/worksheets/${encodeURIComponent(SHEET_NAME)}/range(address='${address}')`, {
		method: 'PATCH',
		body: JSON.stringify({ values })
	});
	if (!response.ok) throw new Error(`Excel (escribir ${address}): HTTP ${response.status}`);
}

async function syncExcel(): Promise<number> {
	const requests = await fetchAllRequests();
	const values: (string | number)[][] = [HEADERS, ...requests.map(toSheetRow)];

	const token = await getGraphToken();
	await ensureWorksheet(token);

	const clear = await graph(token, `/worksheets/${encodeURIComponent(SHEET_NAME)}/range(address='A:R')/clear`, {
		method: 'POST',
		body: JSON.stringify({ applyTo: 'All' })
	});
	if (!clear.ok) throw new Error(`Excel (limpiar): HTTP ${clear.status}`);

	for (let start = 0; start < values.length; start += WRITE_CHUNK) {
		const chunk = values.slice(start, start + WRITE_CHUNK);
		const first = start + 1;
		const last = start + chunk.length;
		await writeRange(token, `A${first}:R${last}`, chunk);
	}
	return requests.length;
}

Deno.serve(async (req) => {
	if (req.method !== 'POST') {
		return new Response('Method not allowed', { status: 405 });
	}
	if (!WEBHOOK_SECRET || req.headers.get('x-webhook-secret') !== WEBHOOK_SECRET) {
		return new Response('No autorizado', { status: 401 });
	}
	try {
		const count = await enqueue(syncExcel);
		return Response.json({ ok: true, filas: count });
	} catch (error) {
		console.error('Error sincronizando Excel:', error);
		return Response.json({ ok: false, error: (error as Error).message }, { status: 500 });
	}
});
