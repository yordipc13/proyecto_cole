const SUPABASE_URL = 'https://wnhqeprmjbihkeflzckb.supabase.co';
const SUPABASE_PUBLIC_KEY = 'sb_publishable_BUrY_4Z30umc1-wiEwQT5g_bht1bbTV';
const supabaseClient = window.supabase?.createClient(SUPABASE_URL, SUPABASE_PUBLIC_KEY);

const specialtyCatalog = [
	'Contabilidad y Costos',
	'Contabilidad y Finanzas',
	'Configuración y Soporte de Redes y Sistemas Operativos',
	'Ejecutivo Comercial y de Servicio al Cliente',
	'Secretariado',
	'Electrónica Industrial',
	'Instalación y mantenimiento de Sistemas Eléctricos Industriales'
];

const modalityTemplates = [
	{ name: 'Pasantía', defaultHours: 80 },
	{ name: 'Práctica profesional', defaultHours: 320 }
];

const statusLabels = {
	recibida: 'Recibida',
	en_revision: 'En revisión',
	contactada: 'Contactada',
	cerrada: 'Cerrada'
};

const panelStatus = document.getElementById('panelStatus');
const loginForm = document.getElementById('loginForm');
const loginSection = document.getElementById('loginSection');
const adminPanel = document.getElementById('adminPanel');
const requestTable = document.getElementById('requestsTable');
const editModal = document.getElementById('editModal');
const editForm = document.getElementById('editForm');
const confirmModal = document.getElementById('confirmModal');
let requests = [];
let annualOffers = [];
let pendingDeleteId = null;
let offerDraft = null;
let offerModalityIndex = 0;
let offerDirty = false;
let offerSaveTimer = null;
let offerSaveQueue = Promise.resolve();
const cycleModal = document.getElementById('cycleModal');
const cycleModalSelect = document.getElementById('cycleModalSelect');
const cycleModalYear = document.getElementById('cycleModalYear');
const cycleModalStatus = document.getElementById('cycleModalStatus');
const offerEditorModal = document.getElementById('offerEditorModal');
const offerEditorStatus = document.getElementById('offerEditorStatus');
const contextMenu = document.getElementById('contextMenu');
let contextMenuRequestId = null;

function localDateValue() {
	const now = new Date();
	const offset = now.getTimezoneOffset() * 60000;
	return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function showMessage(element, message, type) {
	element.textContent = message;
	element.classList.remove('hidden', 'status-success', 'status-error', 'status-info');
	element.classList.add(`status-${type}`);
}

function hideMessage(element) {
	element.textContent = '';
	element.classList.add('hidden');
	element.classList.remove('status-success', 'status-error', 'status-info');
}

function setAccess(allowed) {
	loginSection.classList.toggle('hidden', allowed);
	adminPanel.classList.toggle('hidden', !allowed);
	document.getElementById('logoutButton').classList.toggle('hidden', !allowed);
}

async function verifyCoordinator() {
	const { data: sessionData, error: sessionError } = await supabaseClient.auth.getSession();
	if (sessionError) throw sessionError;
	const user = sessionData.session?.user;
	if (!user) {
		setAccess(false);
		return false;
	}

	const { data, error } = await supabaseClient
		.from('coordinadores')
		.select('user_id')
		.eq('user_id', user.id)
		.maybeSingle();
	if (error) throw error;
	if (!data) {
		await supabaseClient.auth.signOut();
		setAccess(false);
		showMessage(panelStatus, 'Esta cuenta no está autorizada para consultar solicitudes. Contacte al administrador de Supabase.', 'error');
		return false;
	}

	setAccess(true);
	hideMessage(panelStatus);
	Promise.all([loadRequests(), loadAnnualOffers()]).catch((loadError) => {
		console.error('Error al cargar datos:', loadError);
		showMessage(panelStatus, `No se pudieron cargar los datos: ${loadError.message}`, 'error');
	});
	return true;
}

async function handleLogin(event) {
	event.preventDefault();
	if (!supabaseClient) {
		showMessage(panelStatus, 'No se pudo conectar con Supabase. Verifique la configuración del proyecto.', 'error');
		return;
	}

	const button = loginForm.querySelector('button[type="submit"]');
	button.disabled = true;
	showMessage(panelStatus, 'Verificando acceso…', 'info');
	const { error } = await supabaseClient.auth.signInWithPassword({
		email: document.getElementById('loginEmail').value.trim(),
		password: document.getElementById('loginPassword').value
	});
	button.disabled = false;

	if (error) {
		showMessage(panelStatus, 'No se pudo iniciar sesión. Verifique sus credenciales o contacte al administrador.', 'error');
		return;
	}
	try {
		await verifyCoordinator();
	} catch (verifyError) {
		console.error('Error al verificar el acceso:', verifyError);
		showMessage(panelStatus, 'No se pudo validar el acceso del equipo. Revise la configuración de Supabase.', 'error');
	}
}

function defaultModality(template) {
	return {
		nombre: template.name,
		horas: template.defaultHours,
		inicio: null,
		fin: null,
		disponible: false,
		especialidades: [],
		catalogo: [...specialtyCatalog]
	};
}

function normalizeModalities(offer) {
	return modalityTemplates.map((template) => {
		const saved = offer?.modalidades?.find((modality) => modality.nombre === template.name);
		if (!saved) return defaultModality(template);
		const especialidades = Array.isArray(saved.especialidades) ? [...saved.especialidades] : [];
		const catalogo = Array.isArray(saved.catalogo) && saved.catalogo.length ? [...saved.catalogo] : [...specialtyCatalog];
		especialidades.forEach((name) => {
			if (!catalogo.includes(name)) catalogo.push(name);
		});
		return {
			nombre: template.name,
			horas: saved.horas,
			inicio: saved.inicio || null,
			fin: saved.fin || null,
			disponible: saved.disponible === true,
			especialidades,
			catalogo
		};
	});
}

function findOffer(ciclo) {
	return annualOffers.find((offer) => String(offer.ciclo) === String(ciclo)) || null;
}

function cycleStateLabel(estado) {
	return { borrador: 'Borrador', publicada: 'Publicada', cerrada: 'Cerrada' }[estado] || estado;
}

function isValidDate(value) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
	const date = new Date(`${value}T00:00:00Z`);
	return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function shiftYear(value, year) {
	if (!value) return null;
	const shifted = `${year}${value.slice(4)}`;
	return isValidDate(shifted) ? shifted : null;
}

function modalityStatus(modality) {
	if (!modality.disponible) return 'No disponible';
	return modality.inicio && modality.fin && modality.especialidades.length ? 'Disponible' : 'Incompleta';
}

function nextCycleYear() {
	return Math.min(2100, Math.max(new Date().getFullYear() + 1, ...annualOffers.map((offer) => offer.ciclo + 1)));
}

function startOfferDraft(ciclo) {
	const offer = findOffer(ciclo);
	offerDraft = offer ? { ciclo: offer.ciclo, estado: offer.estado, modalidades: normalizeModalities(offer) } : null;
	offerDirty = false;
}

function offerValidationError(draft) {
	for (const modality of draft.modalidades) {
		const horas = Number(modality.horas);
		if (!Number.isInteger(horas) || horas < 1) return `${modality.nombre}: las horas deben ser un número entero mayor a cero.`;
		const dates = [modality.inicio, modality.fin].filter(Boolean);
		if (dates.some((date) => !isValidDate(date))) return `${modality.nombre}: revise las fechas.`;
		if (dates.some((date) => Number(date.slice(0, 4)) !== draft.ciclo)) return `${modality.nombre}: las fechas deben corresponder al año ${draft.ciclo}.`;
		if (modality.inicio && modality.fin && modality.fin < modality.inicio) return `${modality.nombre}: la fecha de cierre no puede ser anterior al inicio.`;
		if (modality.disponible && (!modality.inicio || !modality.fin)) return `${modality.nombre}: una modalidad disponible necesita fecha de inicio y de cierre.`;
		if (modality.disponible && !modality.especialidades.length) return `${modality.nombre}: marque al menos una especialidad disponible.`;
	}
	return '';
}

function publishError(draft) {
	const error = offerValidationError(draft);
	if (error) return error;
	const today = localDateValue();
	const canPublish = draft.modalidades.some((modality) => modality.disponible && modality.fin >= today && modality.especialidades.length);
	return canPublish ? '' : 'Para publicar, habilite al menos una modalidad con fecha de cierre vigente y especialidades disponibles.';
}

function toPayload(modality) {
	return {
		nombre: modality.nombre,
		horas: Number(modality.horas),
		inicio: modality.inicio || null,
		fin: modality.fin || null,
		disponible: modality.disponible,
		especialidades: [...modality.especialidades],
		catalogo: [...modality.catalogo]
	};
}

function enqueueOfferSave(ciclo, estado, modalidades) {
	const payload = modalidades.map(toPayload);
	const run = offerSaveQueue.then(async () => {
		const { error } = await supabaseClient.rpc('guardar_oferta_anual', {
			p_ciclo: ciclo,
			p_estado: estado,
			p_modalidades: payload
		});
		if (error) throw error;
		const offer = findOffer(ciclo);
		if (offer) {
			offer.estado = estado;
			offer.modalidades = payload;
		}
	});
	offerSaveQueue = run.catch(() => {});
	return run;
}

function formatOfferDate(value) {
	if (!value) return 'Fecha por definir';
	return new Intl.DateTimeFormat('es-CR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
		.format(new Date(`${value}T00:00:00Z`));
}

function renderCycleSelect(selected = cycleModalSelect.value) {
	cycleModalSelect.replaceChildren(new Option('Nuevo ciclo', ''));
	annualOffers.forEach((offer) => cycleModalSelect.add(new Option(`${offer.ciclo} · ${cycleStateLabel(offer.estado)}`, String(offer.ciclo))));
	cycleModalSelect.value = String(selected ?? '');
}

function renderCycleModal() {
	const isNew = !offerDraft;
	const isPublished = offerDraft?.estado === 'publicada';
	document.getElementById('cycleModalState').textContent = isNew ? 'Nuevo ciclo' : cycleStateLabel(offerDraft.estado);
	document.getElementById('cycleYearField').classList.toggle('hidden', !isNew);

	const modalities = isNew ? modalityTemplates.map((template) => defaultModality(template)) : offerDraft.modalidades;
	document.getElementById('modalityChoices').replaceChildren(...modalities.map((modality, index) => {
		const status = modalityStatus(modality);
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'modality-choice';
		button.dataset.modalityIndex = String(index);
		const title = document.createElement('span');
		title.className = 'modality-title';
		title.textContent = modality.nombre;
		const meta = document.createElement('span');
		meta.className = 'modality-meta';
		meta.textContent = `${modality.horas} horas · ${modality.especialidades.length} especialidades disponibles`;
		const state = document.createElement('span');
		state.className = `modality-state ${status === 'Disponible' ? 'is-on' : status === 'Incompleta' ? 'is-warn' : 'is-off'}`;
		state.textContent = status;
		button.append(title, meta, state);
		return button;
	}));

	const publishButton = document.getElementById('publishCycleButton');
	publishButton.classList.toggle('hidden', isNew);
	publishButton.disabled = isPublished;
	publishButton.textContent = isPublished ? 'Ciclo publicado' : 'Publicar ciclo';
	document.getElementById('closeCycleButton').classList.toggle('hidden', !isPublished);
}

function openCycleModal() {
	hideMessage(cycleModalStatus);
	const initial = annualOffers.find((offer) => offer.estado === 'publicada') || annualOffers[0] || null;
	if (initial) startOfferDraft(initial.ciclo);
	else offerDraft = null;
	offerDirty = false;
	renderCycleSelect(initial ? initial.ciclo : '');
	cycleModalYear.value = nextCycleYear();
	renderCycleModal();
	cycleModal.classList.remove('hidden');
}

function closeCycleModal() {
	cycleModal.classList.add('hidden');
}

async function changeCycleSelection(value) {
	if (!(await resolvePendingChanges())) {
		renderCycleSelect(offerDraft?.ciclo ?? '');
		return;
	}
	if (value) {
		startOfferDraft(value);
	} else {
		offerDraft = null;
		offerDirty = false;
		cycleModalYear.value = nextCycleYear();
	}
	hideMessage(cycleModalStatus);
	renderCycleSelect(value);
	renderCycleModal();
}

async function createCycleFromModality(index) {
	const year = Number(cycleModalYear.value);
	if (!Number.isInteger(year) || year < 2026 || year > 2100) {
		showMessage(cycleModalStatus, 'El año del ciclo debe estar entre 2026 y 2100.', 'error');
		return;
	}
	if (findOffer(year)) {
		showMessage(cycleModalStatus, `El ciclo ${year} ya existe. Selecciónelo en la lista.`, 'error');
		return;
	}
	showMessage(cycleModalStatus, `Creando ciclo ${year}…`, 'info');
	try {
		await enqueueOfferSave(year, 'borrador', modalityTemplates.map((template) => defaultModality(template)));
		await loadAnnualOffers();
		startOfferDraft(year);
		renderCycleSelect(String(year));
		hideMessage(cycleModalStatus);
		openOfferEditor(index);
	} catch (error) {
		console.error('Error al crear el ciclo:', error);
		showMessage(cycleModalStatus, `No se pudo crear el ciclo: ${error.message}`, 'error');
	}
}

async function setCycleState(estado) {
	if (!offerDraft) return;
	const error = estado === 'publicada' ? publishError(offerDraft) : offerValidationError(offerDraft);
	if (error) {
		showMessage(cycleModalStatus, error, 'error');
		return;
	}
	const { ciclo } = offerDraft;
	clearTimeout(offerSaveTimer);
	offerDirty = false;
	showMessage(cycleModalStatus, 'Guardando ciclo…', 'info');
	try {
		await enqueueOfferSave(ciclo, estado, offerDraft.modalidades);
		await loadAnnualOffers();
		startOfferDraft(ciclo);
		renderCycleSelect(String(ciclo));
		renderCycleModal();
		showMessage(cycleModalStatus, estado === 'publicada' ? `Ciclo ${ciclo} publicado.` : `Ciclo ${ciclo} cerrado.`, 'success');
	} catch (saveError) {
		console.error('Error al cambiar el estado del ciclo:', saveError);
		showMessage(cycleModalStatus, `No se pudo guardar el ciclo: ${saveError.message}`, 'error');
	}
}

function currentModality() {
	return offerDraft.modalidades[offerModalityIndex];
}

function openOfferEditor(index) {
	offerModalityIndex = index;
	hideMessage(offerEditorStatus);
	cycleModal.classList.add('hidden');
	offerEditorModal.classList.remove('hidden');
	renderOfferEditor();
}

async function closeOfferEditor() {
	if (!(await resolvePendingChanges())) return;
	offerEditorModal.classList.add('hidden');
	cycleModal.classList.remove('hidden');
	renderCycleModal();
}

function renderOfferEditor() {
	const modality = currentModality();
	document.getElementById('offerEditorTitle').textContent = `${modality.nombre} · Ciclo ${offerDraft.ciclo}`;
	document.getElementById('offerEditorState').textContent = cycleStateLabel(offerDraft.estado);
	document.getElementById('offerPublishedNotice').classList.toggle('hidden', offerDraft.estado !== 'publicada');
	document.getElementById('offerAvailable').checked = modality.disponible;
	document.getElementById('offerHours').value = modality.horas;
	document.getElementById('offerStart').value = modality.inicio || '';
	document.getElementById('offerEnd').value = modality.fin || '';
	renderCopySources();
	renderSpecialtyRows();
}

function renderCopySources() {
	const select = document.getElementById('offerCopySource');
	const others = annualOffers.filter((offer) => Number(offer.ciclo) !== Number(offerDraft.ciclo));
	select.replaceChildren(new Option(others.length ? 'Seleccione un ciclo' : 'No hay otros ciclos', ''));
	others.forEach((offer) => select.add(new Option(`${offer.ciclo} · ${cycleStateLabel(offer.estado)}`, String(offer.ciclo))));
	document.getElementById('offerCopyButton').disabled = true;
}

function copyFromCycle() {
	const sourceOffer = findOffer(document.getElementById('offerCopySource').value);
	if (!sourceOffer) return;
	const target = currentModality();
	const source = normalizeModalities(sourceOffer).find((modality) => modality.nombre === target.nombre);
	Object.assign(target, {
		horas: source.horas,
		disponible: source.disponible,
		inicio: shiftYear(source.inicio, offerDraft.ciclo),
		fin: shiftYear(source.fin, offerDraft.ciclo),
		catalogo: [...source.catalogo],
		especialidades: [...source.especialidades]
	});
	renderOfferEditor();
	scheduleOfferSave();
}

function renderSpecialtyRows() {
	const modality = currentModality();
	const container = document.getElementById('specialtyRows');
	container.replaceChildren();
	if (!modality.catalogo.length) {
		const empty = document.createElement('p');
		empty.className = 'card-subtitle';
		empty.textContent = 'Aún no hay especialidades. Agregue la primera.';
		container.append(empty);
		return;
	}
	modality.catalogo.forEach((name) => {
		const row = document.createElement('div');
		row.className = 'specialty-row';
		const label = document.createElement('label');
		label.className = 'specialty-check';
		const checkbox = document.createElement('input');
		checkbox.type = 'checkbox';
		checkbox.checked = modality.especialidades.includes(name);
		const text = document.createElement('span');
		text.className = 'specialty-name';
		text.textContent = name;
		label.append(checkbox, text);

		const state = document.createElement('span');
		state.className = 'specialty-state';
		const setState = () => {
			state.textContent = checkbox.checked ? 'Disponible en el formulario' : 'No disponible en el formulario';
			state.classList.toggle('is-off', !checkbox.checked);
		};
		setState();
		checkbox.addEventListener('change', () => {
			modality.especialidades = checkbox.checked
				? [...modality.especialidades, name]
				: modality.especialidades.filter((item) => item !== name);
			setState();
			scheduleOfferSave();
		});

		const remove = document.createElement('button');
		remove.type = 'button';
		remove.className = 'btn btn-ghost specialty-remove';
		remove.textContent = 'Quitar';
		remove.addEventListener('click', () => {
			modality.catalogo = modality.catalogo.filter((item) => item !== name);
			modality.especialidades = modality.especialidades.filter((item) => item !== name);
			renderSpecialtyRows();
			scheduleOfferSave();
		});

		row.append(label, state, remove);
		container.append(row);
	});
}

function addSpecialty() {
	const input = document.getElementById('newSpecialtyInput');
	const name = input.value.trim().replace(/\s+/g, ' ');
	const modality = currentModality();
	if (!name) {
		showMessage(offerEditorStatus, 'Escriba el nombre de la especialidad.', 'error');
		return;
	}
	const exists = modality.catalogo.some((item) => item.toLocaleLowerCase('es-CR') === name.toLocaleLowerCase('es-CR'));
	if (exists) {
		showMessage(offerEditorStatus, 'Esa especialidad ya está en la lista.', 'error');
		return;
	}
	modality.catalogo = [...modality.catalogo, name];
	modality.especialidades = [...modality.especialidades, name];
	input.value = '';
	renderSpecialtyRows();
	scheduleOfferSave();
}

function scheduleOfferSave() {
	offerDirty = true;
	clearTimeout(offerSaveTimer);
	offerSaveTimer = setTimeout(saveOfferDraft, 600);
}

function saveOfferDraft() {
	clearTimeout(offerSaveTimer);
	if (!offerDraft || !offerDirty) return Promise.resolve(true);
	const error = offerValidationError(offerDraft);
	if (error) {
		showMessage(offerEditorStatus, error, 'error');
		return Promise.resolve(false);
	}
	offerDirty = false;
	showMessage(offerEditorStatus, 'Guardando cambios…', 'info');
	return enqueueOfferSave(offerDraft.ciclo, offerDraft.estado, offerDraft.modalidades)
		.then(() => {
			if (!offerDirty) showMessage(offerEditorStatus, 'Cambios guardados automáticamente.', 'success');
			return true;
		})
		.catch((saveError) => {
			console.error('Error al guardar la oferta:', saveError);
			offerDirty = true;
			showMessage(offerEditorStatus, `No se pudo guardar: ${saveError.message}`, 'error');
			return false;
		});
}

async function resolvePendingChanges() {
	await offerSaveQueue;
	clearTimeout(offerSaveTimer);
	if (!offerDirty) return true;
	if (await saveOfferDraft()) return true;
	if (!confirm('Hay cambios con errores que no se guardaron. ¿Desea descartarlos?')) return false;
	startOfferDraft(offerDraft.ciclo);
	return true;
}

async function loadAnnualOffers() {
	const { data, error } = await supabaseClient
		.from('ofertas_anuales')
		.select('ciclo, estado, modalidades, updated_at')
		.order('ciclo', { ascending: false });
	if (error) throw error;
	annualOffers = data || [];
	renderCycleSelect();
	const published = annualOffers.find((offer) => offer.estado === 'publicada');
	document.getElementById('activeOfferSummary').textContent = published
		? `Ciclo ${published.ciclo} publicado. ${published.modalidades.filter((modality) => modality.disponible).length} modalidades habilitadas.`
		: 'No hay un ciclo publicado. Configure y publique la siguiente oferta cuando el calendario esté aprobado.';
}

async function loadRequests() {
	showMessage(panelStatus, 'Cargando solicitudes…', 'info');
	const allRequests = [];
	const pageSize = 500;
	for (let offset = 0; ; offset += pageSize) {
		const { data, error } = await supabaseClient
			.from('solicitudes_estudiantes')
			.select('*')
			.order('created_at', { ascending: false })
			.range(offset, offset + pageSize - 1);
		if (error) throw error;
		allRequests.push(...data);
		if (data.length < pageSize) break;
	}
	requests = allRequests;
	refreshRequestCycleFilter();
	hideMessage(panelStatus);
	renderRequests();
}

function refreshRequestCycleFilter() {
	const filter = document.getElementById('cycleFilter');
	const selected = filter.value;
	filter.replaceChildren(new Option('Todos los ciclos', ''));
	[...new Set(requests.map((request) => request.ciclo).filter(Boolean))]
		.sort((first, second) => second - first)
		.forEach((cycle) => filter.add(new Option(String(cycle), String(cycle))));
	filter.value = selected;
}

function makeCell(text, className = 'p-3 align-top') {
	const cell = document.createElement('td');
	cell.className = className;
	cell.textContent = text || '—';
	return cell;
}

function formatSpecialties(request) {
	let details = request.detalle_especialidades;
	if (typeof details === 'string') {
		try { details = JSON.parse(details); } catch { details = []; }
	}
	if (Array.isArray(details) && details.length) {
		return details.map(({ especialidad, cantidad }) => `${especialidad} (${cantidad})`).join(', ');
	}
	return request.especialidades_requeridas || '—';
}

function filteredRequests() {
	const query = document.getElementById('searchFilter').value.trim().toLocaleLowerCase('es');
	const column = document.getElementById('columnFilter').value;
	const cycle = document.getElementById('cycleFilter').value;
	const modality = document.getElementById('modalityFilter').value;
	const status = document.getElementById('statusFilter').value;
	return requests.filter((request) => {
		const searchable = column
			? [request[column]]
			: [request.empresa, request.contacto, request.email, request.telefono];
		const text = searchable.join(' ').toLocaleLowerCase('es');
		return (!query || text.includes(query))
			&& (!cycle || String(request.ciclo) === cycle)
			&& (!modality || request.modalidad === modality)
			&& (!status || (request.estado || 'recibida') === status);
	});
}

function renderRequests() {
	const visibleRequests = filteredRequests();
	requestTable.replaceChildren();
	document.getElementById('recordCount').textContent = `${visibleRequests.length} solicitudes`;

	if (!visibleRequests.length) {
		const row = document.createElement('tr');
		const cell = makeCell('No hay solicitudes que coincidan con estos filtros.', 'empty-cell');
		cell.colSpan = 6;
		row.append(cell);
		requestTable.append(row);
		return;
	}

	visibleRequests.forEach((request) => {
		const row = document.createElement('tr');
		row.dataset.id = String(request.id);
		const requestDate = request.created_at ? new Date(request.created_at).toLocaleDateString('es-CR') : request.fecha;
		row.append(makeCell(`#${request.id} · ${requestDate}`));

		const contactCell = document.createElement('td');
		contactCell.className = 'p-3 align-top';
		const company = document.createElement('strong');
		company.className = 'company';
		company.textContent = request.empresa || 'Sin empresa';
		const contact = document.createElement('span');
		contact.className = 'muted-line';
		contact.textContent = `${request.contacto || 'Sin contacto'} · ${request.email || 'Sin correo'}`;
		const actions = document.createElement('div');
		actions.className = 'row-actions';
		const editButton = document.createElement('button');
		editButton.type = 'button';
		editButton.className = 'btn btn-outline btn-small';
		editButton.dataset.action = 'edit';
		editButton.dataset.id = String(request.id);
		editButton.setAttribute('aria-label', `Editar solicitud ${request.id}`);
		editButton.textContent = 'Editar';
		const deleteButton = document.createElement('button');
		deleteButton.type = 'button';
		deleteButton.className = 'btn btn-danger btn-small';
		deleteButton.dataset.action = 'delete';
		deleteButton.dataset.id = String(request.id);
		deleteButton.setAttribute('aria-label', `Eliminar solicitud ${request.id}`);
		deleteButton.textContent = 'Eliminar';
		actions.append(editButton, deleteButton);
		contactCell.append(company, contact, actions);
		row.append(
			contactCell,
			makeCell(request.ciclo),
			makeCell(request.modalidad),
			makeCell(formatSpecialties(request)),
			makeCell(statusLabels[request.estado || 'recibida'])
		);
		requestTable.append(row);
	});
}

function findRequest(id) {
	return requests.find((request) => String(request.id) === String(id));
}

function setSelectValue(select, value) {
	if (![...select.options].some((option) => option.value === value)) select.add(new Option(value, value));
	select.value = value;
}

function openEditModal(request) {
	document.getElementById('editRequestLabel').textContent = `#${request.id}`;
	document.getElementById('ed_empresa').value = request.empresa || '';
	document.getElementById('ed_actividad').value = request.actividad || '';
	document.getElementById('ed_contacto').value = request.contacto || '';
	document.getElementById('ed_email').value = request.email || '';
	document.getElementById('ed_telefono').value = request.telefono || '';
	document.getElementById('ed_fax').value = request.fax || '';
	document.getElementById('ed_direccion').value = request.direccion || '';
	document.getElementById('ed_puesto').value = request.puesto || '';
	setSelectValue(document.getElementById('ed_modalidad'), request.modalidad || 'Pasantía');
	document.getElementById('ed_estado').value = request.estado || 'recibida';
	setSelectValue(document.getElementById('ed_entrevista'), request.entrevista || 'No especificado');
	document.getElementById('ed_horario').value = request.horario || '';
	document.getElementById('ed_vestimenta').value = request.vestimenta || '';
	document.getElementById('ed_otro').value = request.otro || '';
	document.getElementById('ed_checks').value = request.checks || '';
	document.getElementById('ed_especialidades').value = formatSpecialties(request);
	editForm.dataset.id = String(request.id);
	editModal.classList.remove('hidden');
	document.getElementById('ed_empresa').focus();
}

function closeEditModal() {
	editModal.classList.add('hidden');
	editForm.reset();
}

async function handleEditSubmit(event) {
	event.preventDefault();
	if (!editForm.reportValidity()) return;
	const id = editForm.dataset.id;
	const button = document.getElementById('editSave');
	const payload = {
		empresa: document.getElementById('ed_empresa').value.trim(),
		actividad: document.getElementById('ed_actividad').value.trim(),
		contacto: document.getElementById('ed_contacto').value.trim(),
		email: document.getElementById('ed_email').value.trim(),
		telefono: document.getElementById('ed_telefono').value.trim(),
		fax: document.getElementById('ed_fax').value.trim(),
		direccion: document.getElementById('ed_direccion').value.trim(),
		puesto: document.getElementById('ed_puesto').value.trim(),
		modalidad: document.getElementById('ed_modalidad').value,
		estado: document.getElementById('ed_estado').value,
		entrevista: document.getElementById('ed_entrevista').value,
		horario: document.getElementById('ed_horario').value.trim(),
		vestimenta: document.getElementById('ed_vestimenta').value.trim(),
		otro: document.getElementById('ed_otro').value.trim(),
		checks: document.getElementById('ed_checks').value.trim()
	};

	button.disabled = true;
	try {
		const { data, error } = await supabaseClient
			.from('solicitudes_estudiantes')
			.update(payload)
			.eq('id', id)
			.select('id');
		if (error) throw error;
		if (!data?.length) throw new Error('Sin filas actualizadas');
		Object.assign(findRequest(id) || {}, payload);
		closeEditModal();
		renderRequests();
		showMessage(panelStatus, `Solicitud #${id} actualizada.`, 'success');
	} catch (error) {
		console.error('Error al actualizar la solicitud:', error);
		showMessage(panelStatus, 'No se pudo guardar los cambios. Revise su conexión o los permisos de la cuenta.', 'error');
	} finally {
		button.disabled = false;
	}
}

function openDeleteConfirm(request) {
	pendingDeleteId = String(request.id);
	document.getElementById('confirmText').textContent = `Se eliminará la solicitud #${request.id} de ${request.empresa || 'la empresa sin nombre'}. Esta acción no se puede deshacer.`;
	confirmModal.classList.remove('hidden');
}

function closeConfirm() {
	pendingDeleteId = null;
	confirmModal.classList.add('hidden');
}

async function confirmDelete() {
	const id = pendingDeleteId;
	if (!id) return;
	const button = document.getElementById('confirmDelete');
	button.disabled = true;
	try {
		const { data, error } = await supabaseClient
			.from('solicitudes_estudiantes')
			.delete()
			.eq('id', id)
			.select('id');
		if (error) throw error;
		if (!data?.length) throw new Error('Sin filas eliminadas');
		requests = requests.filter((request) => String(request.id) !== id);
		closeConfirm();
		refreshRequestCycleFilter();
		renderRequests();
		showMessage(panelStatus, `Solicitud #${id} eliminada.`, 'success');
	} catch (error) {
		console.error('Error al eliminar la solicitud:', error);
		showMessage(panelStatus, 'No se pudo eliminar la solicitud. Revise los permisos de la cuenta.', 'error');
		closeConfirm();
	} finally {
		button.disabled = false;
	}
}

function showContextMenu(request, x, y) {
	contextMenuRequestId = request.id;
	contextMenu.classList.remove('hidden');
	const { innerWidth, innerHeight } = window;
	const { offsetWidth, offsetHeight } = contextMenu;
	contextMenu.style.left = `${Math.min(x, innerWidth - offsetWidth - 8)}px`;
	contextMenu.style.top = `${Math.min(y, innerHeight - offsetHeight - 8)}px`;
}

function hideContextMenu() {
	contextMenu.classList.add('hidden');
	contextMenuRequestId = null;
}

function bindRequestActions() {
	requestTable.addEventListener('click', (event) => {
		const button = event.target.closest('button[data-action]');
		if (!button) return;
		const request = findRequest(button.dataset.id);
		const action = button.dataset.action;
		if (!request) return;
		if (action === 'edit') openEditModal(request);
		if (action === 'delete') openDeleteConfirm(request);
	});

	requestTable.addEventListener('contextmenu', (event) => {
		const row = event.target.closest('tr[data-id]');
		const request = row ? findRequest(row.dataset.id) : null;
		if (!request) return;
		event.preventDefault();
		showContextMenu(request, event.clientX, event.clientY);
	});

	contextMenu.addEventListener('click', (event) => {
		const button = event.target.closest('button[data-menu-action]');
		const request = contextMenuRequestId !== null ? findRequest(contextMenuRequestId) : null;
		hideContextMenu();
		if (!button || !request) return;
		if (button.dataset.menuAction === 'edit') openEditModal(request);
		if (button.dataset.menuAction === 'delete') openDeleteConfirm(request);
	});
	document.addEventListener('click', (event) => {
		if (!contextMenu.contains(event.target)) hideContextMenu();
	});
	window.addEventListener('scroll', hideContextMenu, true);
	window.addEventListener('resize', hideContextMenu);

	document.addEventListener('keydown', (event) => {
		if (event.key !== 'Escape') return;
		if (!contextMenu.classList.contains('hidden')) {
			hideContextMenu();
			return;
		}
		if (!offerEditorModal.classList.contains('hidden')) {
			closeOfferEditor();
			return;
		}
		if (!cycleModal.classList.contains('hidden')) closeCycleModal();
		if (!editModal.classList.contains('hidden')) closeEditModal();
		if (!confirmModal.classList.contains('hidden')) closeConfirm();
	});
}

const THEME_KEY = 'adminTheme';

function applyTheme(theme) {
	document.documentElement.dataset.theme = theme;
	const toggle = document.getElementById('themeToggle');
	toggle.textContent = theme === 'dark' ? 'Modo claro' : 'Modo oscuro';
	toggle.setAttribute('aria-pressed', String(theme === 'dark'));
}

function bindTheme() {
	let saved = 'light';
	try {
		saved = localStorage.getItem(THEME_KEY) || 'light';
	} catch {
		saved = 'light';
	}
	applyTheme(saved);
	document.getElementById('themeToggle').addEventListener('click', () => {
		const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
		applyTheme(next);
		try {
			localStorage.setItem(THEME_KEY, next);
		} catch {
			// Sin almacenamiento disponible, el tema solo dura esta sesión.
		}
	});
}

function bindOfferEditor() {
	document.getElementById('configureCycleButton').addEventListener('click', openCycleModal);
	document.getElementById('cycleModalClose').addEventListener('click', closeCycleModal);
	cycleModal.addEventListener('click', (event) => {
		if (event.target === cycleModal) closeCycleModal();
	});
	cycleModalSelect.addEventListener('change', (event) => changeCycleSelection(event.target.value));
	document.getElementById('modalityChoices').addEventListener('click', (event) => {
		const button = event.target.closest('button[data-modality-index]');
		if (!button) return;
		const index = Number(button.dataset.modalityIndex);
		if (offerDraft) openOfferEditor(index);
		else createCycleFromModality(index);
	});
	document.getElementById('publishCycleButton').addEventListener('click', () => setCycleState('publicada'));
	document.getElementById('closeCycleButton').addEventListener('click', () => setCycleState('cerrada'));
	document.getElementById('offerBack').addEventListener('click', closeOfferEditor);
	offerEditorModal.addEventListener('click', (event) => {
		if (event.target === offerEditorModal) closeOfferEditor();
	});
	document.getElementById('offerAvailable').addEventListener('change', (event) => {
		currentModality().disponible = event.target.checked;
		renderOfferEditor();
		scheduleOfferSave();
	});
	document.getElementById('offerHours').addEventListener('input', (event) => {
		currentModality().horas = event.target.value;
		scheduleOfferSave();
	});
	document.getElementById('offerStart').addEventListener('change', (event) => {
		currentModality().inicio = event.target.value || null;
		scheduleOfferSave();
	});
	document.getElementById('offerEnd').addEventListener('change', (event) => {
		currentModality().fin = event.target.value || null;
		scheduleOfferSave();
	});
	document.getElementById('offerCopySource').addEventListener('change', (event) => {
		document.getElementById('offerCopyButton').disabled = !event.target.value;
	});
	document.getElementById('offerCopyButton').addEventListener('click', copyFromCycle);
	document.getElementById('addSpecialtyButton').addEventListener('click', addSpecialty);
	document.getElementById('newSpecialtyInput').addEventListener('keydown', (event) => {
		if (event.key !== 'Enter') return;
		event.preventDefault();
		addSpecialty();
	});
}

document.addEventListener('DOMContentLoaded', () => {
	bindTheme();
	if (!supabaseClient) {
		showMessage(panelStatus, 'No se pudo cargar la configuración de Supabase.', 'error');
		return;
	}

	loginForm.addEventListener('submit', handleLogin);
	document.getElementById('logoutButton').addEventListener('click', async () => {
		await supabaseClient.auth.signOut();
		setAccess(false);
		requests = [];
		renderRequests();
		showMessage(panelStatus, 'Sesión cerrada.', 'info');
	});
	document.getElementById('refreshButton').addEventListener('click', () => loadRequests().catch((error) => {
		console.error('Error al cargar solicitudes:', error);
		showMessage(panelStatus, 'No se pudieron cargar las solicitudes. Revise la conexión y los permisos.', 'error');
	}));
	['searchFilter', 'columnFilter', 'cycleFilter', 'modalityFilter', 'statusFilter'].forEach((id) => {
		document.getElementById(id).addEventListener('input', renderRequests);
		document.getElementById(id).addEventListener('change', renderRequests);
	});
	bindOfferEditor();
	bindRequestActions();

	editForm.addEventListener('submit', handleEditSubmit);
	document.getElementById('editCancel').addEventListener('click', closeEditModal);
	editModal.addEventListener('click', (event) => {
		if (event.target === editModal) closeEditModal();
	});
	document.getElementById('confirmCancel').addEventListener('click', closeConfirm);
	document.getElementById('confirmDelete').addEventListener('click', confirmDelete);
	confirmModal.addEventListener('click', (event) => {
		if (event.target === confirmModal) closeConfirm();
	});

	supabaseClient.auth.getSession()
		.then(({ data, error }) => {
			if (error || !data.session) {
				setAccess(false);
				return null;
			}
			return verifyCoordinator();
		})
		.catch((verifyError) => {
			console.error('Error al verificar la sesión:', verifyError);
			setAccess(false);
			showMessage(panelStatus, 'No se pudo verificar el acceso guardado. Inicie sesión de nuevo.', 'error');
		});
});
