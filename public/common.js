// Funciones compartidas entre las páginas de alumnos, profesores y administración.
const DAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

const $ = (sel) => document.querySelector(sel);

function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Algo salió mal. Probá de nuevo.');
  return data;
}

function dateParts(date) {
  const d = new Date(`${date}T12:00:00Z`);
  return { weekday: DAYS[d.getUTCDay()], day: d.getUTCDate(), month: d.getUTCMonth() };
}

// "Lunes 26 de octubre"
function longDate(date) {
  const p = dateParts(date);
  return `${p.weekday} ${p.day} de ${MONTHS[p.month]}`;
}

// "Lun 26/10"
function shortDate(date) {
  const p = dateParts(date);
  return { weekday: p.weekday.slice(0, 3), day: `${p.day}/${p.month + 1}` };
}

function hourLabel(hour) {
  return `${String(hour).padStart(2, '0')}:00`;
}

function classTag(slot) {
  return `<span class="class-tag tag-${slot.classKey}">${esc(slot.className)}</span>`;
}

// Título "Por la mañana" / "Por la tarde" antes del primer turno de cada bloque.
function sectionTitle(slots, i, tag = 'li') {
  const pm = slots[i].hour >= 13;
  if (i > 0 && (slots[i - 1].hour >= 13) === pm) return '';
  return `<${tag} class="slots-section">${pm ? 'Por la tarde' : 'Por la mañana'}</${tag}>`;
}

const ROLE_NAMES = { admin: 'Administrador', profesor: 'Profesor', alumno: 'Alumno' };

function hasRole(user, role) {
  return !!user && (user.roles || [user.role]).includes(role);
}

// Página de inicio según los roles (admin > profesor > alumno).
function roleHome(user) {
  if (hasRole(user, 'admin')) return '/admin.html';
  if (hasRole(user, 'profesor')) return '/profe.html';
  return '/';
}

// Menú del encabezado: un enlace a cada sección de los roles del usuario (menos la actual),
// "Mi cuenta" y "Salir".
const SECTIONS = [
  { role: 'admin', href: '/admin.html', label: 'Panel admin' },
  { role: 'profesor', href: '/profe.html', label: 'Mis clases' },
  { role: 'alumno', href: '/', label: 'Reservar' },
];

function renderNav(user, current) {
  const box = $('.userbox');
  box.innerHTML = `${SECTIONS.filter((s) => s.role !== current && hasRole(user, s.role))
    .map((s) => `<a href="${s.href}">${s.label}</a>`).join('')}
    <button class="link" type="button" data-account>Mi cuenta</button>
    <button class="link" type="button" data-logout>Salir</button>`;
  box.querySelector('[data-account]').onclick = () => myAccount(user);
  box.querySelector('[data-logout]').onclick = logout;
}

// "Mi cuenta": datos del usuario y cambio de clave propia.
async function myAccount(user) {
  const data = await ask({
    title: 'Mi cuenta',
    message: `${user.name} · usuario: ${user.username}${user.memberNumber ? ` · N° de entrenado ${user.memberNumber}` : ''}\nPara cambiar tu clave, completá los dos campos.`,
    fields: [
      { name: 'current', label: 'Clave actual', type: 'password', required: true },
      { name: 'password', label: 'Clave nueva (mínimo 4 caracteres)', type: 'password', required: true, minlength: 4 },
    ],
    ok: 'Cambiar clave',
  });
  if (!data) return;
  try {
    await api('POST', '/api/me/password', data);
    toast('Listo, tu clave se cambió.');
  } catch (err) {
    toast(err.message, 'error');
  }
}

// Avisos vigentes del gimnasio, arriba de todo.
async function loadAnnouncements() {
  const { announcements } = await api('GET', '/api/announcements');
  let box = $('#announcements');
  if (!box) {
    box = document.createElement('div');
    box.id = 'announcements';
    $('main').prepend(box);
  }
  box.innerHTML = announcements.map((a) => `<div class="announcement" role="note">📢 ${esc(a.message)}</div>`).join('');
}

// Enlace de WhatsApp a un celular argentino (agrega 54 9 si no lo tiene).
function waLink(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  const full = digits.startsWith('54') ? digits : `549${digits}`;
  return `<a class="wa" href="https://wa.me/${full}" target="_blank" rel="noopener" title="Escribir por WhatsApp a ${esc(phone)}">WhatsApp</a>`;
}

// Botones de asistencia de un anotado (presente / ausente).
function attendanceButtons(p) {
  return `<span class="attendance" role="group" aria-label="Asistencia de ${esc(p.name)}">
    <button type="button" class="small att ${p.attendance === 'presente' ? 'on-present' : ''}" data-attend="${p.bookingId}" data-status="presente" aria-pressed="${p.attendance === 'presente'}">✔ Presente</button>
    <button type="button" class="small att ${p.attendance === 'ausente' ? 'on-absent' : ''}" data-attend="${p.bookingId}" data-status="ausente" aria-pressed="${p.attendance === 'ausente'}">✖ Ausente</button>
  </span>`;
}

// Click en Presente/Ausente: marca, o desmarca si ya estaba en ese estado.
async function toggleAttendance(button, reload) {
  const status = button.getAttribute('aria-pressed') === 'true' ? null : button.dataset.status;
  await run(button, async () => {
    await api('PUT', `/api/staff/bookings/${button.dataset.attend}/attendance`, { status });
    await reload();
  });
}

const WEEKDAY_NAMES = ['', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes'];

function fixedTag() {
  return '<span class="tag fixed-tag" title="Turno fijo: se reserva solo cada semana">📌 Fijo</span>';
}

// Gestor de turnos fijos (Personalizado), para el profe (sus horarios) y el admin (todos).
// `students` es la lista de alumnos para elegir; `onChange` se llama después de crear o borrar.
async function renderFixedManager(container, students, onChange = () => {}) {
  const { options, fixed } = await api('GET', '/api/staff/fixed');
  if (!options.length) {
    container.innerHTML = '<p class="empty">Todavía no tenés Personalizados asignados en la grilla. Pedile al administrador que te los asigne.</p>';
    return;
  }
  const weekdays = [...new Set(options.map((o) => o.weekday))];
  const hoursFor = (wd) => options.filter((o) => o.weekday === wd);
  const byDay = weekdays.map((wd) => {
    const rows = fixed.filter((f) => f.weekday === wd);
    return rows.length ? `<h3 style="margin:12px 0 6px">${WEEKDAY_NAMES[wd]}</h3><ul class="users">${rows.map((f) => `<li>
        <span><b>${f.label}</b> · ${memberTag(f.memberNumber)} ${esc(f.name)} ${planTag(f.plan)}</span>
        <button class="danger small" data-del-fixed="${f.id}" data-text="${esc(`${f.name} · ${WEEKDAY_NAMES[f.weekday]} ${f.label}`)}">Quitar fijo</button>
      </li>`).join('')}</ul>` : '';
  }).join('');

  container.innerHTML = `
    <form class="plan-box" data-fixed-form>
      <b>Nuevo turno fijo</b>
      <p class="hint" style="margin:4px 0 0">El alumno queda anotado solo todas las semanas ese día y hora. Si cancela un día, se cancela solo ese día.</p>
      <label for="fx-user">Alumno</label>
      <select id="fx-user" name="userId" required><option value="">Elegí un alumno…</option>
        ${students.map((s) => `<option value="${s.id}">${s.memberNumber ? `N° de entrenado ${s.memberNumber} · ` : ''}${esc(s.name)}${s.plan ? '' : ' (sin plan)'}</option>`).join('')}</select>
      <div class="row" style="margin-top:8px">
        <div style="flex:1"><label for="fx-day">Día</label>
          <select id="fx-day" name="weekday">${weekdays.map((wd) => `<option value="${wd}">${WEEKDAY_NAMES[wd]}</option>`).join('')}</select></div>
        <div style="flex:1"><label for="fx-hour">Hora</label><select id="fx-hour" name="hour"></select></div>
      </div>
      <button class="full" type="submit">Crear turno fijo</button>
    </form>
    ${byDay || '<p class="empty">Todavía no hay turnos fijos.</p>'}`;

  const day = container.querySelector('#fx-day');
  const fillHours = () => {
    container.querySelector('#fx-hour').innerHTML = hoursFor(Number(day.value)).map((o) => `<option value="${o.hour}">${o.label}</option>`).join('');
  };
  day.onchange = fillHours;
  fillHours();

  container.querySelector('[data-fixed-form]').onsubmit = (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    run(e.submitter, async () => {
      const result = await api('POST', '/api/staff/fixed', { userId: Number(fd.get('userId')), weekday: Number(fd.get('weekday')), hour: Number(fd.get('hour')) });
      toastBooking(result, 'Turno fijo creado. Ya quedó anotado en las próximas semanas.');
      await renderFixedManager(container, students, onChange);
      await onChange();
    });
  };
  container.querySelectorAll('[data-del-fixed]').forEach((b) => {
    b.onclick = async () => {
      const ok = await ask({
        title: '¿Quitar este turno fijo?',
        message: `${b.dataset.text}\nSe borran también sus próximas reservas y esos lugares quedan libres.`,
        ok: 'Quitar fijo',
        danger: true,
      });
      if (!ok) return;
      run(b, async () => {
        const { removed } = await api('DELETE', `/api/staff/fixed/${b.dataset.delFixed}`);
        toast(`Turno fijo quitado${removed ? ` (se liberaron ${removed} ${removed === 1 ? 'reserva' : 'reservas'})` : ''}.`);
        await renderFixedManager(container, students, onChange);
        await onChange();
      });
    };
  });
}

function shortDateText(date) {
  const s = shortDate(date);
  return `${s.weekday} ${s.day}`;
}

// Etiqueta del pago del plan: vencido / vence pronto.
function planStatusTag(status, until) {
  if (status === 'vencido') return `<span class="tag plan-none">Vencido${until ? ` ${shortDateText(until)}` : ''}</span>`;
  if (status === 'por-vencer') return `<span class="tag plan-warn">Vence ${until ? shortDateText(until) : 'pronto'}</span>`;
  return '';
}

function memberTag(number) {
  return number ? `<span class="member-no">N° de entrenado ${esc(number)}</span>` : '';
}

const PLAN_NAMES = { premium: 'Plan premium', basico: 'Plan básico' };

function planTag(plan) {
  return plan ? `<span class="tag plan-${plan}">${esc(PLAN_NAMES[plan] || plan)}</span>` : '<span class="tag plan-none">Sin plan</span>';
}

function roleTag(role) {
  return `<span class="tag role-${role}">${esc(ROLE_NAMES[role] || role)}</span>`;
}

let toastTimer;
function toast(message, type = 'ok') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, type === 'warn' ? 7000 : 4000);
}

// Después de que el personal anota a alguien: aviso si se pasó del plan, o confirmación.
function toastBooking(result, okMessage) {
  if (result && result.warning) toast(`Anotado, pero ojo: ${result.warning}`, 'warn');
  else toast(okMessage);
}

function fieldHtml(f, i) {
  const attrs = `id="ask-${i}" name="${esc(f.name)}" ${f.required ? 'required' : ''}`;
  if (f.type === 'select') {
    return `<select ${attrs}>${f.options.map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(f.value ?? '') ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
  }
  if (f.type === 'checks') {
    return `<div class="checks" id="ask-${i}">${f.options.map((o) => `<label class="check">
      <input type="checkbox" value="${esc(o.value)}" ${(f.value || []).includes(o.value) ? 'checked' : ''}> ${esc(o.label)}</label>`).join('')}</div>`;
  }
  const type = ['password', 'date', 'number'].includes(f.type) ? f.type : 'text';
  const inputmode = f.inputmode || (f.type === 'number' ? 'numeric' : '');
  const nameAttrs = f.format === 'name' ? 'data-name autocapitalize="words" autocomplete="name"' : '';
  return `<input ${attrs} ${nameAttrs} type="${type}" value="${esc(f.value ?? '')}" ${inputmode ? `inputmode="${inputmode}"` : ''}
    ${f.minlength ? `minlength="${f.minlength}"` : ''} ${f.min !== undefined ? `min="${f.min}" step="1"` : ''}>`;
}

function fieldValue(f, el) {
  if (f.type === 'checks') return [...el.querySelectorAll('input:checked')].map((c) => c.value);
  return el.value.trim();
}

// Diálogo propio en lugar de confirm()/prompt(), que algunos navegadores bloquean.
// Al aceptar devuelve true, el texto escrito (con `input`) o un objeto { name: valor } (con `fields`);
// al volver devuelve null.
function ask({ title, message = '', input = null, fields = null, ok = 'Aceptar', danger = false }) {
  const list = fields || (input ? [{ ...input, name: 'value' }] : []);
  return new Promise((resolve) => {
    let dlg = $('#ask');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'ask';
      document.body.append(dlg);
    }
    dlg.innerHTML = `<form method="dialog">
      <h2>${esc(title)}</h2>
      ${message ? `<p>${esc(message)}</p>` : ''}
      ${list.map((f, i) => `<label for="ask-${i}">${esc(f.label)}</label>${fieldHtml(f, i)}`).join('')}
      <div class="dialog-actions">
        <button type="button" class="secondary" data-cancel>Volver</button>
        <button value="ok" class="${danger ? 'danger-solid' : ''}">${esc(ok)}</button>
      </div>
    </form>`;
    dlg.querySelector('[data-cancel]').onclick = () => dlg.close();
    dlg.onclose = () => {
      if (dlg.returnValue !== 'ok') return resolve(null);
      const values = Object.fromEntries(list.map((f, i) => [f.name, fieldValue(f, dlg.querySelector(`#ask-${i}`))]));
      resolve(fields ? values : input ? values.value : true);
    };
    dlg.returnValue = '';
    dlg.showModal();
    (dlg.querySelector('#ask-0 input, input#ask-0, select#ask-0') || dlg.querySelector('[value="ok"]')).focus();
  });
}

// Ejecuta una acción deshabilitando el botón mientras tanto y mostrando errores.
async function run(button, action) {
  if (button) button.disabled = true;
  try {
    await action();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    if (button) button.disabled = false;
  }
}

// Misma regla que el servidor (formatName en server.js): mayúscula inicial en cada palabra del nombre.
const NAME_CONNECTORS = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'e', 'da', 'di']);
function formatName(value) {
  const capital = (part) => {
    const rest = part.slice(1);
    return part.charAt(0).toLocaleUpperCase('es') + (rest === rest.toLocaleUpperCase('es') ? rest.toLocaleLowerCase('es') : rest);
  };
  return String(value || '').trim().split(/\s+/).filter(Boolean).map((word, i) => {
    if (i > 0 && NAME_CONNECTORS.has(word.toLocaleLowerCase('es'))) return word.toLocaleLowerCase('es');
    return word.split(/([-'’])/).map((p) => (/^[-'’]$/.test(p) ? p : capital(p))).join('');
  }).join(' ');
}

// Los campos de nombre (data-name) se corrigen a la vista al salir del campo.
document.addEventListener('focusout', (e) => {
  if (e.target.matches && e.target.matches('input[data-name]')) e.target.value = formatName(e.target.value);
});

// Pie de página con la versión de la app y el enlace a Novedades, en todas las páginas.
(async function renderFooter() {
  try {
    const { version, date } = await api('GET', '/api/version');
    const footer = document.createElement('footer');
    footer.className = 'site-footer';
    footer.innerHTML = `Turnero Balance Center · <a href="/novedades.html">Versión ${esc(version)}</a>${date ? ` · ${esc(shortDateText(date))}` : ''}`;
    document.querySelector('main').after(footer);
  } catch {
    // Sin versión no se muestra el pie: no afecta al resto de la página.
  }
}());

async function logout() {
  await api('POST', '/api/logout');
  location.href = '/';
}
