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

const form = document.getElementById('solicitudForm');
const formStatus = document.getElementById('formStatus');
let currentOffer = null;
let completedSubmission = null;

function localDateValue() {
	const now = new Date();
	const offset = now.getTimezoneOffset() * 60000;
	return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function formatOfferDate(value) {
	if (!value) return 'Fecha por definir';
	return new Intl.DateTimeFormat('es-CR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
		.format(new Date(`${value}T00:00:00Z`));
}

function selectedOfferModality() {
	const selected = form.querySelector('input[name="modalidad"]:checked');
	return currentOffer?.modalidades?.find((modality) => modality.nombre === selected?.value) || null;
}

function renderModalityOptions() {
	const options = document.getElementById('modalityOptions');
	const intro = document.getElementById('offerIntro');
	const submitButton = document.getElementById('submitButton');
	options.replaceChildren();

	if (!currentOffer || currentOffer.estado !== 'publicada') {
		intro.textContent = 'En este momento no hay un ciclo abierto para recibir solicitudes.';
		document.getElementById('specialtyOptions').replaceChildren();
		submitButton.disabled = true;
		return;
	}

	submitButton.disabled = false;
	intro.textContent = `Ciclo ${currentOffer.ciclo}. La duración y el período distinguen las opciones de este ciclo.`;
	document.getElementById('cycleTitle').textContent = currentOffer.ciclo;
	let requiredAssigned = false;
	let hasAvailableModality = false;

	currentOffer.modalidades.forEach((modality) => {
		const expired = modality.fin && modality.fin < localDateValue();
		const available = modality.disponible === true && modality.especialidades?.length > 0 && !expired;
		if (available) hasAvailableModality = true;
		const label = document.createElement('label');
		label.className = `modality-option block rounded-md border border-slate-300 bg-white p-3${available ? '' : ' modality-pending'}`;
		const wrapper = document.createElement('span');
		wrapper.className = 'flex items-start gap-2';
		const radio = document.createElement('input');
		radio.type = 'radio';
		radio.name = 'modalidad';
		radio.value = modality.nombre;
		radio.disabled = !available;
		radio.required = available && !requiredAssigned;
		if (radio.required) requiredAssigned = true;
		radio.addEventListener('change', renderSpecialties);
		const details = document.createElement('span');
		const title = document.createElement('span');
		title.className = 'block font-bold text-slate-800';
		title.textContent = modality.nombre;
		const dates = document.createElement('span');
		dates.className = 'mt-1 block text-xs text-slate-600';
		dates.textContent = `${modality.horas} horas · ${formatOfferDate(modality.inicio)} al ${formatOfferDate(modality.fin)}`;
		const status = document.createElement('span');
		status.className = `mt-2 inline-block text-xs font-semibold ${available ? 'text-emerald-800' : 'text-slate-600'}`;
		status.textContent = expired ? 'Plazo finalizado' : available ? 'Disponible' : 'No disponible en este ciclo';
		details.append(title, dates, status);
		wrapper.append(radio, details);
		label.append(wrapper);
		options.append(label);
	});

	submitButton.disabled = !hasAvailableModality;
	if (!hasAvailableModality) intro.textContent = `El ciclo ${currentOffer.ciclo} no tiene plazos de solicitud vigentes.`;
	renderSpecialties();
}

function renderSpecialties() {
	const body = document.getElementById('specialtyOptions');
	body.replaceChildren();
	const selectedModality = selectedOfferModality();
	const availableSpecialties = new Set(selectedModality?.especialidades || []);

	const catalog = selectedModality?.catalogo?.length ? selectedModality.catalogo : specialtyCatalog;

	catalog.forEach((specialty, index) => {
		const row = document.createElement('tr');
		row.className = index % 2 === 0 ? 'bg-white' : 'bg-slate-50';
		const nameCell = document.createElement('td');
		nameCell.className = 'border-t border-slate-200 p-2';
		const label = document.createElement('label');
		const available = availableSpecialties.has(specialty);
		label.className = available ? 'flex items-center gap-2' : 'flex items-center gap-2 text-slate-500';

		if (available) {
			const checkbox = document.createElement('input');
			checkbox.type = 'checkbox';
			checkbox.className = 'specialty-checkbox';
			checkbox.value = specialty;
			checkbox.setAttribute('aria-label', `Solicitar ${specialty}`);
			label.append(checkbox, document.createTextNode(specialty));
		} else {
			label.append(document.createTextNode(specialty));
			const unavailable = document.createElement('span');
			unavailable.className = 'ml-1 text-[11px] font-semibold text-slate-500';
			unavailable.textContent = selectedModality ? 'No disponible' : 'Seleccione una modalidad';
			label.append(unavailable);
		}

		nameCell.append(label);
		const quantityCell = document.createElement('td');
		quantityCell.className = 'border-t border-slate-200 p-2';
		if (available) {
			const quantity = document.createElement('input');
			quantity.type = 'number';
			quantity.min = '1';
			quantity.step = '1';
			quantity.disabled = true;
			quantity.className = 'specialty-quantity w-full rounded border border-slate-300 px-2 py-1 text-center disabled:bg-slate-100';
			quantity.dataset.specialty = specialty;
			quantity.setAttribute('aria-label', `Cantidad para ${specialty}`);
			label.querySelector('input').addEventListener('change', (event) => {
				quantity.disabled = !event.target.checked;
				if (!event.target.checked) quantity.value = '';
				if (event.target.checked) quantity.focus();
			});
			quantityCell.append(quantity);
		} else {
			quantityCell.textContent = '—';
			quantityCell.className += ' text-center text-slate-400';
		}

		row.append(nameCell, quantityCell);
		body.append(row);
	});
}

async function loadPublicOffer() {
	if (!supabaseClient) return;
	const { data, error } = await supabaseClient
		.from('ofertas_anuales')
		.select('ciclo, estado, modalidades')
		.eq('estado', 'publicada')
		.maybeSingle();
	if (error) throw error;
	currentOffer = data;
	renderModalityOptions();
	if (!currentOffer) showMessage(formStatus, 'No hay una convocatoria publicada por el momento. La próxima oferta aparecerá cuando el calendario sea aprobado.', 'info');
	else hideMessage(formStatus);
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

function selectedSpecialties() {
	return Array.from(document.querySelectorAll('.specialty-checkbox:checked')).map((checkbox) => {
		const quantityInput = Array.from(document.querySelectorAll('.specialty-quantity'))
			.find((input) => input.dataset.specialty === checkbox.value);
		return { especialidad: checkbox.value, cantidad: Number(quantityInput.value) };
	});
}

function selectedBenefits() {
	const benefitIds = [
		['beneficio_uniforme', 'Uniforme'],
		['beneficio_transporte', 'Transporte'],
		['beneficio_alimentacion', 'Alimentación'],
		['beneficio_gratificacion', 'Gratificación económica'],
		['beneficio_empleo', 'Posibilidad de empleo']
	];
	const values = benefitIds.filter(([id]) => document.getElementById(id).checked).map(([, label]) => label);
	const otherText = document.getElementById('beneficio_otro_texto').value.trim();
	if (document.getElementById('beneficio_otro_check').checked) values.push(`Otro: ${otherText || 'Sí'}`);
	if (document.getElementById('beneficio_ninguno').checked) values.push('Ninguno');
	return values;
}

function buildSubmission() {
	const details = selectedSpecialties();
	const interview = document.querySelector('input[name="entrevista"]:checked');
	return {
		ciclo: currentOffer.ciclo,
		empresa: document.getElementById('empresa').value.trim(),
		actividad: document.getElementById('actividad').value.trim(),
		direccion: document.getElementById('direccion').value.trim(),
		contacto: document.getElementById('contacto').value.trim(),
		fecha: document.getElementById('fecha').value,
		telefono: document.getElementById('telefono').value.trim(),
		fax: document.getElementById('fax').value.trim(),
		email: document.getElementById('email').value.trim(),
		puesto: document.getElementById('puesto').value.trim(),
		especialidades_requeridas: details.map(({ especialidad, cantidad }) => `${especialidad}: ${cantidad}`).join('; '),
		detalle_especialidades: details,
		modalidad: form.querySelector('input[name="modalidad"]:checked').value,
		entrevista: interview ? interview.value : 'No especificado',
		horario: document.getElementById('req_horario').value.trim(),
		vestimenta: document.getElementById('req_vestimenta').value.trim(),
		otro: document.getElementById('req_otros').value.trim(),
		checks: selectedBenefits().join(', ') || 'Ninguno seleccionado'
	};
}

function downloadSubmissionExcel(submission) {
	if (!window.XLSX) throw new Error('La herramienta para generar el archivo no está disponible.');

	const excelData = [
		[`SOLICITUD DE ESTUDIANTES ${submission.ciclo} - CTP ULADISLAO GÁMEZ SOLANO`],
		[],
		['Campo', 'Información'],
		['Ciclo', submission.ciclo],
		['Empresa o institución', submission.empresa],
		['Fecha de solicitud', submission.fecha],
		['Actividad', submission.actividad],
		['Teléfono', submission.telefono],
		['Dirección', submission.direccion],
		['Fax', submission.fax],
		['Nombre y apellidos de contacto', submission.contacto],
		['Correo electrónico', submission.email],
		['Puesto', submission.puesto],
		['Modalidad', submission.modalidad],
		[],
		['Especialidades y cantidad'],
		['Especialidad', 'Cantidad'],
		...submission.detalle_especialidades.map(({ especialidad, cantidad }) => [especialidad, cantidad]),
		[],
		['Requisitos de la empresa'],
		['Entrevista', submission.entrevista],
		['Horario', submission.horario],
		['Vestimenta', submission.vestimenta],
		['Otros requisitos', submission.otro],
		[],
		['Beneficios', submission.checks]
	];
	const workbook = window.XLSX.utils.book_new();
	const worksheet = window.XLSX.utils.aoa_to_sheet(excelData);
	worksheet['!cols'] = [{ wch: 52 }, { wch: 48 }];
	window.XLSX.utils.book_append_sheet(workbook, worksheet, 'Solicitud');
	const company = submission.empresa.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30) || 'Empresa';
	window.XLSX.writeFile(workbook, `Solicitud_${submission.ciclo}_${company}.xlsx`);
}

function closeConfirmationModal() {
	const modal = document.getElementById('modalConfirm');
	modal.classList.add('hidden');
	modal.classList.remove('flex');
	document.getElementById('submitButton').focus();
}

async function submitRequest(event) {
	event.preventDefault();
	hideMessage(formStatus);
	const modality = selectedOfferModality();
	if (!currentOffer || !modality || modality.disponible !== true) {
		showMessage(formStatus, 'No hay una modalidad disponible para registrar en este ciclo.', 'error');
		return;
	}

	if (!supabaseClient) {
		showMessage(formStatus, 'No se pudo conectar con el servicio de solicitudes. Avise a coordinación.', 'error');
		return;
	}

	const specialties = selectedSpecialties();
	if (specialties.length === 0) {
		showMessage(formStatus, 'Seleccione al menos una especialidad disponible.', 'error');
		return;
	}
	if (specialties.some(({ cantidad }) => !Number.isInteger(cantidad) || cantidad < 1)) {
		showMessage(formStatus, 'Indique una cantidad válida para cada especialidad seleccionada.', 'error');
		return;
	}

	const submitButton = document.getElementById('submitButton');
	submitButton.disabled = true;
	submitButton.textContent = 'Registrando…';
	try {
		const submission = buildSubmission();
		const { error } = await supabaseClient.from('solicitudes_estudiantes').insert(submission);
		if (error) throw error;

		completedSubmission = submission;
		form.reset();
		document.getElementById('fecha').value = localDateValue();
		renderSpecialties();
		showMessage(formStatus, 'Solicitud registrada correctamente. La coordinación revisará la información.', 'success');
		const modal = document.getElementById('modalConfirm');
		modal.classList.remove('hidden');
		modal.classList.add('flex');
		document.getElementById('closeModalButton').focus();
	} catch (error) {
		console.error('Error al registrar la solicitud:', error);
		showMessage(formStatus, 'No se pudo registrar la solicitud. Revise su conexión e inténtelo de nuevo; los datos siguen en el formulario.', 'error');
	} finally {
		submitButton.disabled = false;
		submitButton.textContent = 'Registrar solicitud';
	}
}

function resetForm() {
	if (!window.confirm('¿Está seguro de que desea limpiar todos los campos del formulario?')) return;
	form.reset();
	document.getElementById('fecha').value = localDateValue();
	renderSpecialties();
	hideMessage(formStatus);
}

document.addEventListener('DOMContentLoaded', () => {
	document.getElementById('fecha').value = localDateValue();
	renderSpecialties();
	form.addEventListener('submit', submitRequest);
	document.getElementById('resetButton')?.addEventListener('click', resetForm);
	document.getElementById('downloadSubmissionButton').addEventListener('click', () => {
		if (!completedSubmission) return;
		try {
			downloadSubmissionExcel(completedSubmission);
		} catch (error) {
			console.error('Error al generar la copia Excel:', error);
			closeConfirmationModal();
			showMessage(formStatus, 'No se pudo generar la copia Excel. La solicitud sí quedó registrada.', 'error');
		}
	});
	document.getElementById('closeModalButton').addEventListener('click', closeConfirmationModal);
	document.getElementById('modalConfirm').addEventListener('click', (event) => {
		if (event.target.id === 'modalConfirm') closeConfirmationModal();
	});
	document.addEventListener('keydown', (event) => {
		if (event.key === 'Escape' && !document.getElementById('modalConfirm').classList.contains('hidden')) {
			closeConfirmationModal();
		}
	});

	document.getElementById('beneficio_ninguno').addEventListener('change', (event) => {
		if (event.target.checked) {
			['beneficio_uniforme', 'beneficio_transporte', 'beneficio_alimentacion', 'beneficio_gratificacion', 'beneficio_empleo', 'beneficio_otro_check'].forEach((id) => {
				document.getElementById(id).checked = false;
			});
			document.getElementById('beneficio_otro_texto').value = '';
		}
	});
	['beneficio_uniforme', 'beneficio_transporte', 'beneficio_alimentacion', 'beneficio_gratificacion', 'beneficio_empleo', 'beneficio_otro_check'].forEach((id) => {
		document.getElementById(id).addEventListener('change', (event) => {
			if (event.target.checked) document.getElementById('beneficio_ninguno').checked = false;
		});
	});

	if (!supabaseClient) {
		showMessage(formStatus, 'El servicio de solicitudes no está disponible. Avise a coordinación.', 'error');
		document.getElementById('submitButton').disabled = true;
		return;
	}
	loadPublicOffer().catch((error) => {
		console.error('Error al cargar la oferta:', error);
		showMessage(formStatus, 'No se pudo consultar la convocatoria vigente. Avise a coordinación.', 'error');
	});
});

window.resetForm = resetForm;
