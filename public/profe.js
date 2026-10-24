let students = [];

async function init() {
  const { user } = await api('GET', '/api/me');
  if (!user) { location.href = '/'; return; }
  if (!hasRole(user, 'profesor')) { location.href = roleHome(user); return; }
  renderNav(user, 'profesor');
  $('#hello').innerHTML = `Hola, ${esc(user.name.split(' ')[0])} ${memberTag(user.memberNumber)}`;
  students = (await api('GET', '/api/staff/students')).students;
  await Promise.all([loadAnnouncements(), load(), renderFixedManager($('#fixed'), students, load)]);
}

async function load() {
  const data = await api('GET', '/api/profe/agenda');
  renderDay($('#today'), 'Hoy', data.today);
  renderDay($('#next'), 'Próximo día de clases', data.next);
  renderUpcoming(data.upcoming);
}

function studentOptions(exclude) {
  return students.filter((s) => !exclude.includes(s.id))
    .map((s) => `<option value="${s.id}">${s.memberNumber ? `N° de entrenado ${s.memberNumber} · ` : ''}${esc(s.name)}</option>`).join('');
}

function renderDay(el, title, day) {
  const total = day.slots.reduce((n, s) => n + s.taken, 0);
  let body;
  if (!day.classDay) body = '<p class="empty">Sábados y domingos no hay clases.</p>';
  else if (!day.slots.length) body = '<p class="empty">No tenés clases asignadas este día.</p>';
  else {
    body = `${day.dayBlock ? `<div class="banner">Día cerrado${day.dayBlock.reason ? `: ${esc(day.dayBlock.reason)}` : ''}</div>` : ''}
      <p class="hint">${day.slots.length} ${day.slots.length === 1 ? 'clase' : 'clases'} · ${total} ${total === 1 ? 'alumno anotado' : 'alumnos anotados'}</p>
      <div class="slots">${day.slots.map((s) => slotCard(day.date, s)).join('')}</div>`;
  }
  el.innerHTML = `<h2>${title} · ${longDate(day.date)}</h2>${body}`;
}

function slotCard(date, s) {
  const people = s.people.map((p) => `<li>
      <span>${memberTag(p.memberNumber)} <b>${esc(p.name)}</b> ${p.fixed ? fixedTag() : ''} ${planStatusTag(p.planStatus)}</span>
      <span class="row">
        ${waLink(p.phone)}
        ${s.canAttend ? attendanceButtons(p) : ''}
        ${s.past ? '' : `<button class="danger small" data-remove="${p.bookingId}" data-name="${esc(p.name)}" data-date="${date}" data-label="${s.label}">Quitar</button>`}
      </span>
    </li>`).join('');
  const canAdd = !s.blocked && !s.past && s.free > 0;
  return `<div class="admin-slot ${s.blocked ? 'closed' : ''}">
    <header>
      <span><span style="font-size:1.3rem;font-weight:800">${s.label}</span> ${classTag(s)}
        <span class="muted">${s.taken}/${s.capacity}${s.past ? ' · ya pasó' : ''}${s.blocked ? ` · cerrado${s.reason ? ` (${esc(s.reason)})` : ''}` : ''}</span></span>
    </header>
    ${people ? `<ul>${people}</ul>` : '<p class="empty" style="margin:8px 0">Todavía no hay anotados.</p>'}
    ${s.waiting && s.waiting.length ? `<p class="waiting">⏳ En lista de espera: ${s.waiting.map((w) => esc(w.name)).join(', ')}</p>` : ''}
    ${canAdd ? `<form class="row add-form" data-date="${date}" data-hour="${s.hour}" data-class="${s.classKey}">
        <select name="userId" required><option value="">Agregar alumno…</option>${studentOptions(s.people.map((p) => p.userId))}</select>
        <button class="small" type="submit">Agregar</button>
      </form>` : ''}
  </div>`;
}

function renderUpcoming(list) {
  $('#upcoming').innerHTML = list.length
    ? `<table class="upcoming"><thead><tr><th>Día</th><th>Hora</th><th>Clase</th><th>Anotados</th></tr></thead><tbody>
        ${list.map((u) => `<tr><td>${shortDate(u.date).weekday} ${shortDate(u.date).day}</td><td>${u.label}</td>
          <td>${esc(u.className)}</td><td>${u.blocked ? 'Cerrado' : `${u.taken}/${u.capacity}`}</td></tr>`).join('')}
      </tbody></table>`
    : '<p class="empty">No tenés más clases asignadas en las próximas dos semanas.</p>';
}

// Acciones de las tarjetas (las tarjetas se vuelven a dibujar, así que se escuchan desde el documento).
document.addEventListener('click', async (e) => {
  const att = e.target.closest('[data-attend]');
  if (att) { toggleAttendance(att, load); return; }
  const b = e.target.closest('[data-remove]');
  if (!b) return;
  const ok = await ask({ title: '¿Quitar de la clase?', message: `${b.dataset.name}\n${longDate(b.dataset.date)} a las ${b.dataset.label} hs`, ok: 'Quitar', danger: true });
  if (!ok) return;
  run(b, async () => {
    await api('DELETE', `/api/bookings/${b.dataset.remove}`);
    toast('Alumno quitado de la clase.');
    await load();
  });
});

document.addEventListener('submit', (e) => {
  const f = e.target.closest('.add-form');
  if (!f) return;
  e.preventDefault();
  const userId = Number(new FormData(f).get('userId'));
  if (!userId) return;
  run(e.submitter, async () => {
    const result = await api('POST', '/api/staff/bookings', { userId, date: f.dataset.date, hour: Number(f.dataset.hour), classKey: f.dataset.class });
    toastBooking(result, 'Alumno agregado a la clase.');
    await load();
  });
});

init().catch((err) => toast(err.message, 'error'));
