let users = [];
let plans = [];
let date = null;
let classSlots = []; // clases del día que se está viendo, para el formulario de Mover

function addDays(d, n) {
  const x = new Date(`${d}T12:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}

function isWeekend(d) {
  const w = new Date(`${d}T12:00:00Z`).getUTCDay();
  return w === 0 || w === 6;
}

// Avanza o retrocede saltando sábados y domingos.
function stepWeekday(d, dir) {
  let x = addDays(d, dir);
  while (isWeekend(x)) x = addDays(x, dir);
  return x;
}

async function init() {
  const { user } = await api('GET', '/api/me');
  if (!user) { location.href = '/'; return; }
  if (!hasRole(user, 'admin')) { location.href = roleHome(user); return; }
  renderNav(user, 'admin');
  const { today } = await api('GET', '/api/days');
  date = isWeekend(today) ? stepWeekday(today, 1) : today;
  $('#today').onclick = () => setDate(isWeekend(today) ? stepWeekday(today, 1) : today);
  $('#st-from').value = `${today.slice(0, 8)}01`;
  $('#st-to').value = today;
  await Promise.all([loadAnnouncements(), loadUsers()]);
  await setDate(date);
}

$('#prev').onclick = () => setDate(stepWeekday(date, -1));
$('#next').onclick = () => setDate(stepWeekday(date, 1));
$('#date').onchange = (e) => e.target.value && setDate(e.target.value);

const TAB_LOADERS = {
  turnos: () => loadSlots(),
  usuarios: () => loadUsers(),
  grilla: () => loadGrid(),
  fijos: () => renderFixedManager($('#fixed'), users.filter((u) => hasRole(u, 'alumno'))),
  avisos: () => loadAnnouncementList(),
  estadisticas: () => loadStats(),
};
document.querySelectorAll('[data-tab]').forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll('[data-tab]').forEach((t) => {
      t.setAttribute('aria-selected', String(t === tab));
      $(`#${t.dataset.tab}`).hidden = t !== tab;
    });
    TAB_LOADERS[tab.dataset.tab]().catch((err) => toast(err.message, 'error'));
  };
});

// ---------- turnos del día ----------

async function setDate(d) {
  date = d;
  $('#date').value = d;
  await loadSlots();
}

function studentOptions(exclude = []) {
  return users.filter((u) => hasRole(u, 'alumno') && !exclude.includes(u.id))
    .map((u) => `<option value="${u.id}">N° de entrenado ${u.memberNumber} · ${esc(u.name)}${u.plan ? '' : ' (sin plan)'}</option>`).join('');
}

// Opciones "hora · clase" para mover un turno (si se cambia de día, la API valida que esa clase exista).
function classOptions(selected) {
  return classSlots.map((s) => {
    const value = `${s.hour}|${s.classKey}`;
    return `<option value="${value}" ${value === selected ? 'selected' : ''}>${s.label} · ${esc(s.className)}</option>`;
  }).join('');
}

async function loadSlots() {
  const data = await api('GET', `/api/slots?date=${date}`);
  classSlots = data.slots;
  const total = data.slots.reduce((n, s) => n + s.taken, 0);
  $('#day-title').textContent = `${longDate(date)} · ${total} ${total === 1 ? 'reserva' : 'reservas'}`;

  if (!data.classDay) {
    $('#day-actions').innerHTML = '<p class="empty">Sábados y domingos no hay clases.</p>';
    $('#slots').innerHTML = '';
    return;
  }

  $('#day-actions').innerHTML = data.dayBlock
    ? `<div class="banner" style="flex:1">Día cerrado${data.dayBlock.reason ? `: ${esc(data.dayBlock.reason)}` : ''}</div>
       <button class="secondary" data-unblock="${data.dayBlock.id}">Abrir el día</button>`
    : '<button class="danger" id="block-day">Cerrar el día completo</button>';
  const blockDay = $('#block-day');
  if (blockDay) blockDay.onclick = () => block(blockDay, null);

  $('#slots').innerHTML = data.slots.map((s, i) => {
    const people = s.people.map((p) => `<li>
        <span>${memberTag(p.memberNumber)} <b>${esc(p.name)}</b> ${p.fixed ? fixedTag() : ''} <span class="muted">${esc(p.phone || p.username)}</span> ${planTag(p.plan)} ${planStatusTag(p.planStatus)}</span>
        <span class="row">
          ${waLink(p.phone)}
          ${s.canAttend ? attendanceButtons(p) : ''}
          <button class="secondary small" data-move="${p.bookingId}" data-hour="${s.hour}">Mover</button>
          <button class="danger small" data-remove="${p.bookingId}" data-name="${esc(p.name)}" data-label="${s.label}">Quitar</button>
        </span>
        <form class="row move-form" data-booking="${p.bookingId}" hidden style="width:100%">
          <input type="date" name="date" value="${date}" required>
          <select name="slot">${classOptions(`${s.hour}|${s.classKey}`)}</select>
          <button class="small" type="submit">Guardar</button>
        </form>
      </li>`).join('');

    const canAdd = !s.blocked && !s.past && s.free > 0;
    return `${sectionTitle(data.slots, i, 'h3')}<div class="admin-slot ${s.blocked ? 'closed' : ''}">
      <header>
        <span><span class="hour" style="font-size:1.3rem;font-weight:800">${s.label}</span> ${classTag(s)}
          <span class="muted">${s.taken}/${s.capacity}${s.past ? ' · ya pasó' : ''}${s.blocked ? ` · cerrado${s.reason ? ` (${esc(s.reason)})` : ''}` : ''}</span>
          <br><span class="teacher">${s.teacher ? `Profe: ${esc(s.teacher.name)}` : 'Sin profe asignado'}</span></span>
        ${data.dayBlock || !s.firstOfHour ? '' : s.hourBlockId
          ? `<button class="secondary small" data-unblock="${s.hourBlockId}">Abrir horario</button>`
          : `<button class="danger small" data-block="${s.hour}">Cerrar horario</button>`}
      </header>
      ${people ? `<ul>${people}</ul>` : '<p class="empty" style="margin:8px 0">Sin reservas.</p>'}
      ${s.waiting && s.waiting.length ? `<p class="waiting">⏳ En lista de espera: ${s.waiting.map((w) => `${esc(w.name)} (N° de entrenado ${w.memberNumber})`).join(', ')}</p>` : ''}
      ${canAdd ? `<form class="row add-form" data-hour="${s.hour}" data-class="${s.classKey}">
          <select name="userId" required><option value="">Agregar alumno…</option>${studentOptions(s.people.map((p) => p.userId))}</select>
          <button class="small" type="submit">Agregar</button>
        </form>` : ''}
    </div>`;
  }).join('');

  const slots = $('#slots');
  slots.querySelectorAll('[data-attend]').forEach((b) => { b.onclick = () => toggleAttendance(b, loadSlots); });
  slots.querySelectorAll('[data-block]').forEach((b) => { b.onclick = () => block(b, Number(b.dataset.block)); });
  document.querySelectorAll('[data-unblock]').forEach((b) => {
    b.onclick = () => run(b, async () => {
      await api('DELETE', `/api/admin/blocks/${b.dataset.unblock}`);
      toast('Abierto de nuevo.');
      await loadSlots();
    });
  });
  slots.querySelectorAll('[data-remove]').forEach((b) => {
    b.onclick = async () => {
      const ok = await ask({ title: '¿Quitar la reserva?', message: `${b.dataset.name} · ${longDate(date)} a las ${b.dataset.label} hs`, ok: 'Quitar', danger: true });
      if (!ok) return;
      run(b, async () => {
        await api('DELETE', `/api/bookings/${b.dataset.remove}`);
        toast('Reserva eliminada.');
        await loadSlots();
      });
    };
  });
  slots.querySelectorAll('[data-move]').forEach((b) => {
    b.onclick = () => {
      const form = slots.querySelector(`.move-form[data-booking="${b.dataset.move}"]`);
      form.hidden = !form.hidden;
    };
  });
  slots.querySelectorAll('.move-form').forEach((f) => {
    f.onsubmit = (e) => {
      e.preventDefault();
      const fd = new FormData(f);
      run(e.submitter, async () => {
        const [hour, classKey] = fd.get('slot').split('|');
        const result = await api('PATCH', `/api/admin/bookings/${f.dataset.booking}`, { date: fd.get('date'), hour: Number(hour), classKey });
        toastBooking(result, 'Turno movido.');
        await loadSlots();
      });
    };
  });
  slots.querySelectorAll('.add-form').forEach((f) => {
    f.onsubmit = (e) => {
      e.preventDefault();
      const userId = Number(new FormData(f).get('userId'));
      if (!userId) return;
      run(e.submitter, async () => {
        const result = await api('POST', '/api/staff/bookings', { userId, date, hour: Number(f.dataset.hour), classKey: f.dataset.class });
        toastBooking(result, 'Alumno agregado al turno.');
        await loadSlots();
      });
    };
  });
}

async function block(button, hour) {
  const what = hour === null ? `todo el ${longDate(date)}` : `el horario de las ${hourLabel(hour)} del ${longDate(date)}`;
  const reason = await ask({
    title: hour === null ? '¿Cerrar el día completo?' : '¿Cerrar este horario?',
    message: `Vas a cerrar ${what}${hour === null ? '' : ' (todas las clases de esa hora)'}. Los alumnos no van a poder reservar.`,
    input: { label: 'Motivo (opcional, lo ven los alumnos)', value: hour === null ? 'Feriado' : '' },
    ok: 'Cerrar',
    danger: true,
  });
  if (reason === null) return;
  run(button, async () => {
    await api('POST', '/api/admin/blocks', { date, hour, reason });
    toast('Cerrado. Si ya había reservas, siguen anotadas: avisales o quitalas.');
    await loadSlots();
  });
}

// ---------- usuarios ----------

async function loadUsers() {
  const data = await api('GET', '/api/admin/users');
  users = data.users;
  plans = data.plans;
  $('#nu-plan').innerHTML = `<option value="">Sin plan por ahora</option>${plans.map((p) => `<option value="${p.key}">${esc(p.name)}</option>`).join('')}`;
  renderUsers();
}

function matchesFilter(u, filter) {
  if (!filter) return true;
  if (filter === 'sin-plan') return hasRole(u, 'alumno') && !u.plan;
  if (filter === 'vencidos') return hasRole(u, 'alumno') && ['vencido', 'por-vencer'].includes(u.planStatus);
  return hasRole(u, filter);
}

function renderUsers() {
  const q = $('#user-search').value.trim().toLowerCase();
  const filter = $('#user-filter').value;
  const list = users.filter((u) => matchesFilter(u, filter) && (!q || u.name.toLowerCase().includes(q) || u.username.includes(q)
    || u.phone.includes(q) || String(u.memberNumber) === q.replace(/^n°?\s*(de entrenado)?\s*/, '')));
  $('#user-count').textContent = `(${list.length})`;
  $('#users').innerHTML = list.map((u) => {
    const alumno = hasRole(u, 'alumno');
    return `<li>
      <span>${memberTag(u.memberNumber)} <b>${esc(u.name)}</b> ${u.roles.map(roleTag).join(' ')}
        ${alumno ? `${planTag(u.plan)} ${planStatusTag(u.planStatus, u.planUntil)}` : ''}<br>
        <span class="muted">usuario: ${esc(u.username)}${u.phone ? ` · cel: ${esc(u.phone)}` : ''}${alumno ? ` · ${u.upcoming} turnos próximos` : ''}${alumno && u.planStatus === 'al-dia' ? ` · pago hasta ${shortDateText(u.planUntil)}` : ''}</span></span>
      <span class="row">
        ${waLink(u.phone)}
        <button class="secondary small" data-edit="${u.id}">Editar datos</button>
        <button class="secondary small" data-pass="${u.id}">Cambiar clave</button>
        ${hasRole(u, 'admin') ? '' : `<button class="danger small" data-del="${u.id}">Eliminar</button>`}
      </span>
    </li>`;
  }).join('') || '<p class="empty">No hay usuarios con ese filtro.</p>';

  const find = (id) => users.find((u) => u.id === Number(id));
  $('#users').querySelectorAll('[data-edit]').forEach((b) => {
    b.onclick = async () => {
      const u = find(b.dataset.edit);
      const data = await ask({
        title: `Editar datos de ${u.name}`,
        message: `Usuario: ${u.username}`,
        fields: [
          { name: 'name', label: 'Nombre y apellido', value: u.name, required: true, format: 'name' },
          { name: 'memberNumber', label: 'N° de entrenado', type: 'number', value: u.memberNumber, required: true, min: 1 },
          { name: 'phone', label: 'Celular', value: u.phone, inputmode: 'tel', required: true },
          { name: 'roles', label: 'Roles (podés marcar más de uno)', type: 'checks', value: u.roles, options: Object.entries(ROLE_NAMES).map(([value, label]) => ({ value, label })) },
          { name: 'plan', label: 'Plan (solo alumnos)', type: 'select', value: u.plan || '', options: [{ value: '', label: 'Sin plan' }, ...plans.map((p) => ({ value: p.key, label: p.name }))] },
          { name: 'planUntil', label: 'Pago hasta (solo alumnos, opcional)', type: 'date', value: u.planUntil || '' },
        ],
        ok: 'Guardar',
      });
      if (!data) return;
      run(b, async () => { await api('PATCH', `/api/admin/users/${u.id}`, data); toast('Datos actualizados.'); await loadUsers(); });
    };
  });
  $('#users').querySelectorAll('[data-pass]').forEach((b) => {
    b.onclick = async () => {
      const u = find(b.dataset.pass);
      const password = await ask({
        title: `Nueva clave para ${u.name}`,
        input: { label: 'Clave nueva (mínimo 4 caracteres)', required: true, minlength: 4 },
        ok: 'Cambiar clave',
      });
      if (!password) return;
      run(b, async () => { await api('PATCH', `/api/admin/users/${u.id}`, { password }); toast('Clave cambiada. Pasale la nueva clave.'); });
    };
  });
  $('#users').querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      const u = find(b.dataset.del);
      const ok = await ask({ title: `¿Eliminar a ${u.name}?`, message: 'También se borran todos sus turnos y sus clases asignadas.', ok: 'Eliminar', danger: true });
      if (!ok) return;
      run(b, async () => { await api('DELETE', `/api/admin/users/${u.id}`); toast('Usuario eliminado.'); await loadUsers(); });
    };
  });
}

$('#user-search').oninput = renderUsers;
$('#user-filter').onchange = renderUsers;
// El plan y la fecha de pago solo aplican si está marcado "Alumno".
$('#nu-roles').onchange = () => { $('#nu-plan-wrap').hidden = !$('#nu-roles input[value="alumno"]').checked; };

$('#new-user').onsubmit = (e) => {
  e.preventDefault();
  const form = e.target;
  const fd = new FormData(form);
  const body = { ...Object.fromEntries(fd), roles: fd.getAll('roles') };
  if (!body.roles.length) { toast('Marcá al menos un rol.', 'error'); return; }
  run(e.submitter, async () => {
    await api('POST', '/api/admin/users', body);
    toast('Usuario agregado.');
    form.reset();
    $('#nu-plan-wrap').hidden = false;
    await loadUsers();
  });
};

// ---------- avisos ----------

async function loadAnnouncementList() {
  const { announcements } = await api('GET', '/api/admin/announcements');
  const today = new Date().toISOString().slice(0, 10);
  $('#ann-list').innerHTML = announcements.map((a) => {
    const expired = a.until && a.until < today;
    return `<li>
      <span>📢 ${esc(a.message)}<br><span class="muted">${a.until ? `${expired ? 'Terminó' : 'Hasta'} el ${longDate(a.until)}` : 'Sin fecha de fin'}</span></span>
      <button class="danger small" data-del-ann="${a.id}">Borrar</button>
    </li>`;
  }).join('') || '<p class="empty">No hay avisos publicados.</p>';
  $('#ann-list').querySelectorAll('[data-del-ann]').forEach((b) => {
    b.onclick = () => run(b, async () => {
      await api('DELETE', `/api/admin/announcements/${b.dataset.delAnn}`);
      toast('Aviso borrado.');
      await Promise.all([loadAnnouncementList(), loadAnnouncements()]);
    });
  });
}

$('#new-ann').onsubmit = (e) => {
  e.preventDefault();
  const form = e.target;
  run(e.submitter, async () => {
    await api('POST', '/api/admin/announcements', Object.fromEntries(new FormData(form)));
    toast('Aviso publicado.');
    form.reset();
    await Promise.all([loadAnnouncementList(), loadAnnouncements()]);
  });
};

// ---------- estadísticas ----------

// Barras horizontales de un solo color. `max` fijo (ej. 100 para porcentajes) o el mayor valor.
function bars(rows, value, label, total, max = Math.max(1, ...rows.map(value))) {
  return `<ul class="bars">${rows.map((r) => {
    const v = value(r);
    return `<li class="bar-row" title="${esc(label(r))}: ${total ? total(r) : v}">
      <span class="name">${esc(label(r))}</span>
      <span class="track"><span class="fill" style="width:${(v / max) * 100}%"></span></span>
      <span class="num">${total ? total(r) : v}</span>
    </li>`;
  }).join('')}</ul>`;
}

function tile(value, label) {
  return `<div class="stat-tile"><div class="value">${value}</div><div class="label">${label}</div></div>`;
}

async function loadStats() {
  const from = $('#st-from').value;
  const to = $('#st-to').value;
  $('#export-bookings').href = `/api/admin/export/bookings?from=${from}&to=${to}`;
  const s = await api('GET', `/api/admin/stats?from=${from}&to=${to}`);
  const t = s.totals;
  const marked = t.present + t.absent;
  const occupancy = (c) => (c.seats ? Math.round((c.bookings / c.seats) * 100) : 0);
  const studentRows = (list, cols) => `<div class="table-wrap"><table class="stats-table"><thead><tr><th>Alumno</th>${cols.map((c) => `<th>${c[0]}</th>`).join('')}</tr></thead><tbody>
    ${list.map((r) => `<tr><td>${memberTag(r.memberNumber)} ${esc(r.name)}</td>${cols.map((c) => `<td class="n">${c[1](r)}</td>`).join('')}</tr>`).join('')}
    </tbody></table></div>`;

  $('#stats').innerHTML = `
    <h3>Reservas del ${longDate(s.from)} al ${longDate(s.to)}</h3>
    <div class="stat-tiles">
      ${tile(t.bookings, 'reservas en total')}
      ${tile(t.upcoming, 'todavía por venir')}
      ${tile(t.present, 'presentes')}
      ${tile(t.absent, 'ausentes')}
      ${tile(marked ? `${Math.round((t.present / marked) * 100)}%` : '—', 'asistencia (de lo marcado)')}
      ${tile(t.unmarked, 'clases pasadas sin tomar asistencia')}
    </div>
    <h3>Ocupación por clase</h3>
    <p class="hint">Reservas sobre el total de lugares de esa clase en el período (sin contar días u horarios cerrados).</p>
    ${bars(s.byClass, occupancy, (c) => c.name, (c) => `${occupancy(c)}%`, 100)}
    <div class="table-wrap"><table class="stats-table"><thead><tr><th>Clase</th><th>Reservas</th><th>Lugares</th><th>Veces</th></tr></thead><tbody>
      ${s.byClass.map((c) => `<tr><td>${esc(c.name)}</td><td class="n">${c.bookings}</td><td class="n">${c.seats}</td><td class="n">${c.times}</td></tr>`).join('')}
    </tbody></table></div>
    <h3>Reservas por horario</h3>
    ${bars(s.byHour, (h) => h.bookings, (h) => `${h.label} hs`)}
    <h3>Alumnos que más reservaron</h3>
    ${s.topStudents.length ? studentRows(s.topStudents, [['Reservas', (r) => r.bookings], ['Pres.', (r) => r.present], ['Aus.', (r) => r.absent]]) : '<p class="empty">Sin reservas en el período.</p>'}
    <p class="hint">Pres. = presentes · Aus. = ausentes (según la asistencia tomada).</p>
    <h3>Más ausencias</h3>
    ${s.topAbsences.length ? studentRows(s.topAbsences, [['Aus.', (r) => r.absent], ['Reservas', (r) => r.bookings]]) : '<p class="empty">Sin ausencias marcadas en el período.</p>'}
    <h3>Alumnos</h3>
    <div class="stat-tiles">
      ${tile(s.students.total, 'alumnos')}
      ${tile(s.students.active, 'reservaron en los últimos 30 días')}
      ${tile(s.students.withoutPlan, 'sin plan')}
      ${tile(s.students.expired, 'con el plan vencido')}
      ${tile(s.students.expiring, 'vencen en 5 días o menos')}
    </div>`;
}

$('#stats-form').onsubmit = (e) => {
  e.preventDefault();
  run(e.submitter, loadStats);
};

// ---------- grilla: profesor de cada horario ----------


// Grupos de clases para la asignación rápida.
const CLASS_GROUPS = [
  { label: 'Boxeo (técnica y recreativo)', keys: ['tecnica', 'recreativo'] },
  { label: 'Flexibilidad', keys: ['flexibilidad'] },
  { label: 'Personalizado', keys: ['personalizado'] },
  { label: 'Todas las clases', keys: ['personalizado', 'tecnica', 'recreativo', 'flexibilidad'] },
];

async function loadGrid() {
  const { days, teachers } = await api('GET', '/api/admin/grid');
  if (!teachers.length) {
    $('#grid').innerHTML = '<div class="banner warn">Todavía no hay profesores. Creá uno en la pestaña Usuarios con el rol "Profesor".</div>';
    return;
  }
  const options = (selected) => `<option value="">Sin profe</option>${teachers.map((t) => `<option value="${t.id}" ${t.id === selected ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}`;
  $('#grid').innerHTML = `
    <form class="plan-box" id="bulk-form">
      <b>Asignación rápida</b>
      <p class="hint" style="margin:4px 0 0">Ej.: Boxeo · Por la mañana · Joaco. Se aplica de lunes a viernes.</p>
      <label for="bulk-class">Clase</label>
      <select id="bulk-class" name="group">${CLASS_GROUPS.map((g, i) => `<option value="${i}">${esc(g.label)}</option>`).join('')}</select>
      <label for="bulk-period">Turno</label>
      <select id="bulk-period" name="period">
        <option value="manana">Por la mañana</option>
        <option value="tarde">Por la tarde</option>
        <option value="todo">Todo el día</option>
      </select>
      <label for="bulk-teacher">Profe</label>
      <select id="bulk-teacher" name="teacherId">${options(null)}</select>
      <button class="full" type="submit">Asignar</button>
    </form>
    ${days.map((d) => `<div class="grid-day">
      <h3>${WEEKDAY_NAMES[d.weekday]}</h3>
      ${d.cells.map((c) => `<div class="grid-row">
          <span class="hour">${c.label}</span>${classTag(c)}
          <select data-weekday="${d.weekday}" data-hour="${c.hour}" data-class="${c.classKey}"
            aria-label="Profe de ${WEEKDAY_NAMES[d.weekday]} ${c.label} ${esc(c.className)}">${options(c.teacherId)}</select>
        </div>`).join('')}
    </div>`).join('')}`;

  $('#grid').querySelectorAll('select[data-weekday]').forEach((s) => {
    s.onchange = () => run(s, async () => {
      await api('PUT', '/api/admin/grid', {
        weekday: Number(s.dataset.weekday), hour: Number(s.dataset.hour), classKey: s.dataset.class, teacherId: s.value ? Number(s.value) : null,
      });
      toast('Guardado.');
    });
  });
  $('#bulk-form').onsubmit = (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const group = CLASS_GROUPS[Number(fd.get('group'))];
    run(e.submitter, async () => {
      const { count } = await api('PUT', '/api/admin/grid/bulk', {
        classKeys: group.keys, period: fd.get('period'), teacherId: fd.get('teacherId') ? Number(fd.get('teacherId')) : null,
      });
      toast(`Listo: ${count} ${count === 1 ? 'clase actualizada' : 'clases actualizadas'}.`);
      await loadGrid();
    });
  };
}

init().catch((err) => toast(err.message, 'error'));
