import { createClient } from 'npm:@supabase/supabase-js@2';
import * as XLSX from 'npm:xlsx@0.18.5';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const WEBHOOK_SECRET = Deno.env.get('WEBHOOK_SECRET') ?? '';
const MS_TENANT_ID = Deno.env.get('MS_TENANT_ID') ?? '';
const MS_CLIENT_ID = Deno.env.get('MS_CLIENT_ID') ?? '';
const MS_CLIENT_SECRET = Deno.env.get('MS_CLIENT_SECRET') ?? '';

const SHEET_NAME = 'Solicitudes';
const FILE_NAME = 'Solicitudes_estudiantes.xlsx';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
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

type Vinculo = {
	drive_id: string;
	item_id: string;
	nombre: string;
	url: string | null;
};

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
	auth: { persistSession: false, autoRefreshToken: false }
});

// Serializa las operaciones para que dos peticiones seguidas no se pisen.
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

async function obtenerVinculo(): Promise<Vinculo | null> {
	const { data, error } = await db
		.from('excel_vinculo')
		.select('drive_id, item_id, nombre, url')
		.eq('id', 1)
		.maybeSingle();
	if (error) throw new Error(`Supabase: ${error.message}`);
	return data;
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

async function graph(token: string, vinculo: Vinculo, path: string, init: RequestInit = {}): Promise<Response> {
	return fetch(`https://graph.microsoft.com/v1.0/drives/${vinculo.drive_id}/items/${vinculo.item_id}/workbook${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
			...(init.headers ?? {})
		}
	});
}

async function ensureWorksheet(token: string, vinculo: Vinculo): Promise<void> {
	const check = await graph(token, vinculo, `/worksheets/${encodeURIComponent(SHEET_NAME)}`);
	if (check.ok) return;
	if (check.status !== 404) throw new Error(`Excel (hoja): HTTP ${check.status}`);
	const created = await graph(token, vinculo, '/worksheets', {
		method: 'POST',
		body: JSON.stringify({ name: SHEET_NAME })
	});
	if (!created.ok) throw new Error(`Excel (crear hoja): HTTP ${created.status}`);
}

async function writeRange(token: string, vinculo: Vinculo, address: string, values: unknown[][]): Promise<void> {
	const response = await graph(token, vinculo, `/worksheets/${encodeURIComponent(SHEET_NAME)}/range(address='${address}')`, {
		method: 'PATCH',
		body: JSON.stringify({ values })
	});
	if (!response.ok) throw new Error(`Excel (escribir ${address}): HTTP ${response.status}`);
}

async function syncExcel(): Promise<{ vinculado: boolean; filas?: number }> {
	const vinculo = await obtenerVinculo();
	if (!vinculo) return { vinculado: false };

	const requests = await fetchAllRequests();
	const values: (string | number)[][] = [HEADERS, ...requests.map(toSheetRow)];

	const token = await getGraphToken();
	await ensureWorksheet(token, vinculo);

	const clear = await graph(token, vinculo, `/worksheets/${encodeURIComponent(SHEET_NAME)}/range(address='A:R')/clear`, {
		method: 'POST',
		body: JSON.stringify({ applyTo: 'All' })
	});
	if (!clear.ok) throw new Error(`Excel (limpiar): HTTP ${clear.status}`);

	for (let start = 0; start < values.length; start += WRITE_CHUNK) {
		const chunk = values.slice(start, start + WRITE_CHUNK);
		const first = start + 1;
		const last = start + chunk.length;
		await writeRange(token, vinculo, `A${first}:R${last}`, chunk);
	}

	const { error } = await db
		.from('excel_vinculo')
		.update({ ultima_sincronizacion: new Date().toISOString(), filas: requests.length })
		.eq('id', 1);
	if (error) throw new Error(`Supabase: ${error.message}`);
	return { vinculado: true, filas: requests.length };
}

// Convierte el enlace de compartir en la carpeta real (unidad e ID) con la API de Shares de Graph.
async function resolverCarpeta(token: string, enlace: string): Promise<{ drive_id: string; item_id: string }> {
	const bytes = new TextEncoder().encode(enlace.trim());
	const base64 = btoa(String.fromCharCode(...bytes));
	const shareId = 'u!' + base64.replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
	const response = await fetch(`https://graph.microsoft.com/v1.0/shares/${shareId}/driveItem?$select=id,folder,parentReference`, {
		headers: { Authorization: `Bearer ${token}` }
	});
	const json = await response.json();
	if (!response.ok) {
		const detalle = json?.error?.message ?? `HTTP ${response.status}`;
		console.error('Graph shares error:', response.status, json);
		throw new Error(`No se pudo leer el enlace de la carpeta (${detalle}). Verifique que sea un enlace de OneDrive o SharePoint válido.`);
	}
	if (!json.folder) throw new Error('El enlace debe ser de una carpeta, no de un archivo.');
	return { drive_id: json.parentReference?.driveId, item_id: json.id };
}

async function crearExcel(enlace: string): Promise<Vinculo> {
	if (await obtenerVinculo()) {
		throw new Error('Ya hay un Excel vinculado. Desvincúlelo antes de crear uno nuevo.');
	}
	if (!enlace.trim()) throw new Error('Pegue el enlace de la carpeta donde se creará el Excel.');

	const workbook = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([HEADERS]), SHEET_NAME);
	const bytes = new Uint8Array(XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }));

	const token = await getGraphToken();
	const carpeta = await resolverCarpeta(token, enlace);
	const upload = await fetch(
		`https://graph.microsoft.com/v1.0/drives/${carpeta.drive_id}/items/${carpeta.item_id}:/${encodeURIComponent(FILE_NAME)}:/content?@microsoft.graph.conflictBehavior=rename`,
		{
			method: 'PUT',
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': XLSX_MIME },
			body: bytes
		}
	);
	const item = await upload.json();
	if (!upload.ok) throw new Error(`Excel (crear archivo): ${item.error?.message ?? upload.status}`);

	const vinculo: Vinculo = {
		drive_id: carpeta.drive_id,
		item_id: item.id,
		nombre: item.name,
		url: item.webUrl ?? null
	};
	const { error } = await db.from('excel_vinculo').insert({ id: 1, ...vinculo });
	if (error) throw new Error(`Supabase: ${error.message}`);

	await syncExcel();
	return vinculo;
}

async function esCoordinador(req: Request): Promise<boolean> {
	const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
	if (!token) return false;
	const userDb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
		global: { headers: { Authorization: `Bearer ${token}` } },
		auth: { persistSession: false, autoRefreshToken: false }
	});
	const { data, error } = await userDb.rpc('es_coordinador');
	return !error && data === true;
}

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-webhook-secret',
	'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

async function manejar(req: Request): Promise<Response> {
	if (req.method !== 'POST') {
		return new Response('Method not allowed', { status: 405 });
	}

	const esWebhook = Boolean(WEBHOOK_SECRET) && req.headers.get('x-webhook-secret') === WEBHOOK_SECRET;
	if (!esWebhook && !(await esCoordinador(req))) {
		return new Response('No autorizado', { status: 401 });
	}

	let accion = 'sincronizar';
	let enlace = '';
	try {
		const body = await req.json();
		if (typeof body?.accion === 'string') accion = body.accion;
		if (typeof body?.enlace === 'string') enlace = body.enlace;
	} catch {
		// Sin cuerpo JSON se usa la acción por defecto.
	}

	try {
		if (accion === 'crear') {
			const vinculo = await enqueue(() => crearExcel(enlace));
			return Response.json({ ok: true, nombre: vinculo.nombre, url: vinculo.url });
		}
		if (accion === 'sincronizar') {
			const result = await enqueue(syncExcel);
			return Response.json({ ok: true, ...result });
		}
		return Response.json({ ok: false, error: 'Acción no válida.' }, { status: 400 });
	} catch (error) {
		console.error('Error con Excel:', error);
		return Response.json({ ok: false, error: (error as Error).message }, { status: 500 });
	}
}

Deno.serve(async (req) => {
	if (req.method === 'OPTIONS') {
		return new Response('ok', { headers: CORS_HEADERS });
	}
	const respuesta = await manejar(req);
	Object.entries(CORS_HEADERS).forEach(([nombre, valor]) => respuesta.headers.set(nombre, valor));
	return respuesta;
});
