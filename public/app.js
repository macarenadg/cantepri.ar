let me = null;
let days = [];
let selectedDay = null;
let showAllMine = false;
const openFixed = new Set(); // desplegables de turnos fijos abiertos (se mantienen al recargar la lista)

async function init() {
  me = (await api('GET', '/api/me')).user;
  // Quien no es alumno (admin, profe) tiene su propia página de inicio.
  if (me && !hasRole(me, 'alumno')) { location.href = roleHome(me); return; }
  $('#auth').hidden = !!me;
  $('#app').hidden = !me;
  if (me) {
    renderNav(me, 'alumno');
    $('#hello').innerHTML = `Hola, ${esc(me.name.split(' ')[0])} ${memberTag(me.memberNumber)}`;
    await Promise.all([loadAnnouncements(), loadNotifications(), loadDays(), loadMine()]);
  } else {
    $('.userbox').innerHTML = '';
  }
}

// Mensajes para el alumno (ej. "te anotamos desde la lista de espera").
async function loadNotifications() {
  const { notifications } = await api('GET', '/api/notifications');
  $('#notifications').innerHTML = notifications.length
    ? `<div class="notification" role="status">${notifications.map((n) => `<p style="margin:0 0 6px">🔔 ${esc(n.message)}</p>`).join('')}
        <button class="small" type="button" id="notif-ok">Entendido</button></div>`
    : '';
  const ok = $('#notif-ok');
  if (ok) ok.onclick = () => run(ok, async () => { await api('POST', '/api/notifications/read'); $('#notifications').innerHTML = ''; });
}

// Plan del alumno, cuánto usó en la semana del día elegido y si el pago vence.
function renderPlan(plan) {
  if (!plan) {
    $('#plan-info').innerHTML = `<div class="banner warn">Todavía no tenés un plan asignado, así que no podés reservar.
      Consultá en el gimnasio para que te lo asignen.</div>`;
    return;
  }
  const lines = plan.categories.map((c) => {
    const name = c.label.charAt(0).toUpperCase() + c.label.slice(1);
    if (c.limit === null) return `<li>${name}: libres (${c.used} esta semana)</li>`;
    if (c.limit === 0) return `<li>${name}: no incluidas</li>`;
    return `<li>${name}: ${c.used} de ${c.limit} esta semana</li>`;
  }).join('');
  let payment = '';
  if (plan.status === 'vencido') payment = `<div class="banner warn">Tu plan venció el ${longDate(plan.until)}. Acercate a renovarlo.</div>`;
  else if (plan.status === 'por-vencer') payment = `<div class="banner warn">Tu plan vence el ${longDate(plan.until)}. Acordate de renovarlo.</div>`;
  $('#plan-info').innerHTML = `${payment}<div class="plan-box">Tu plan: <b>${esc(plan.name)}</b>${plan.until && !payment ? ` <span class="muted">· pago hasta ${shortDateText(plan.until)}</span>` : ''}<ul>${lines}</ul></div>`;
}

// ---------- ingresar / crear cuenta ----------

function showTab(register) {
  $('#tab-login').setAttribute('aria-selected', String(!register));
  $('#tab-register').setAttribute('aria-selected', String(register));
  $('#login-form').hidden = register;
  $('#register-form').hidden = !register;
}
$('#tab-login').onclick = () => showTab(false);
$('#tab-register').onclick = () => showTab(true);

$('#login-form').onsubmit = (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  run(e.submitter, async () => {
    const { user } = await api('POST', '/api/login', { username: form.get('username'), password: form.get('password') });
    if (!hasRole(user, 'alumno')) { location.href = roleHome(user); return; }
    await init();
  });
};

$('#register-form').onsubmit = (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  run(e.submitter, async () => {
    await api('POST', '/api/register', Object.fromEntries(form));
    toast('¡Listo! Tu cuenta está creada.');
    await init();
  });
};

// ---------- turnos ----------

async function loadDays() {
  const data = await api('GET', '/api/days');
  days = data.days;
  if (!days.includes(selectedDay)) selectedDay = days[0];
  renderDays();
  await loadSlots();
}

// Lunes de la semana de una fecha (los días se muestran de a una semana).
function mondayOf(date) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function weekLabel(weekDays) {
  const a = dateParts(weekDays[0]);
  const b = dateParts(weekDays[weekDays.length - 1]);
  if (weekDays.length === 1) return `${a.weekday} ${a.day} de ${MONTHS[a.month]}`;
  return a.month === b.month
    ? `Semana del ${a.day} al ${b.day} de ${MONTHS[b.month]}`
    : `Semana del ${a.day} de ${MONTHS[a.month]} al ${b.day} de ${MONTHS[b.month]}`;
}

function renderDays() {
  const weeks = [...new Set(days.map(mondayOf))];
  const current = weeks.indexOf(mondayOf(selectedDay));
  const weekDays = days.filter((d) => mondayOf(d) === weeks[current]);
  let nav = $('#week-nav');
  if (!nav) {
    nav = document.createElement('div');
    nav.id = 'week-nav';
    nav.className = 'week-nav';
    $('#days').before(nav);
  }
  nav.innerHTML = `
    <button type="button" class="secondary" data-week="-1" aria-label="Semana anterior" ${current === 0 ? 'disabled' : ''}>◀</button>
    <span class="week-label">${weekLabel(weekDays)}</span>
    <button type="button" class="secondary" data-week="1" aria-label="Semana siguiente" ${current === weeks.length - 1 ? 'disabled' : ''}>▶</button>`;
  nav.querySelectorAll('[data-week]').forEach((b) => {
    b.onclick = () => {
      const target = weeks[current + Number(b.dataset.week)];
      selectedDay = days.find((d) => mondayOf(d) === target);
      renderDays();
      loadSlots();
    };
  });
  $('#days').innerHTML = weekDays.map((d) => {
    const s = shortDate(d);
    return `<button type="button" data-day="${d}" aria-pressed="${d === selectedDay}">${s.weekday}<small>${s.day}</small></button>`;
  }).join('');
  $('#days').querySelectorAll('button').forEach((b) => {
    b.onclick = () => { selectedDay = b.dataset.day; renderDays(); loadSlots(); };
  });
}

function dots(taken, capacity) {
  return `<span class="dots" aria-hidden="true">${Array.from({ length: capacity }, (_, i) => `<i class="${i < taken ? 'on' : ''}"></i>`).join('')}</span>`;
}

async function loadSlots() {
  if (!selectedDay) { $('#slots').innerHTML = '<p class="empty">No hay días disponibles.</p>'; return; }
  const data = await api('GET', `/api/slots?date=${selectedDay}`);
  $('#day-title').textContent = longDate(selectedDay);
  renderPlan(data.plan);
  $('#day-banner').innerHTML = data.dayBlock
    ? `<div class="banner">Este día no hay clases${data.dayBlock.reason ? `: ${esc(data.dayBlock.reason)}` : ''}.</div>` : '';

  $('#slots').innerHTML = data.slots.map((s, i) => {
    let cls, status, action = '';
    const label = `${s.label} hs · ${s.className}`;
    if (s.myBookingId) {
      cls = 'mine'; status = `✔ Tenés este turno${s.myFixed ? ` ${fixedTag()}` : ''}`;
      if (!s.past) action = `<button class="danger" data-cancel="${s.myBookingId}" data-label="${esc(label)}" data-fixed="${s.myFixed ? 1 : ''}">Cancelar</button>`;
    } else if (s.blocked) {
      cls = 'closed'; status = `Cerrado${s.reason ? ` (${esc(s.reason)})` : ''}`;
    } else if (s.past) {
      cls = 'past'; status = 'Ya pasó';
    } else if (s.busyHour) {
      cls = 'full'; status = 'Ya estás anotado en otra clase a esta hora';
    } else if (s.myWait) {
      cls = 'full'; status = `Estás en la lista de espera (puesto ${s.myWait.position}). Si se libera un lugar, te anotamos solo.`;
      action = `<button class="secondary" data-unwait="${s.myWait.id}">Salir de la lista</button>`;
    } else if (s.free === 0 && !s.planBlock) {
      cls = 'full'; status = `Completo${s.waitCount ? ` · ${s.waitCount} en espera` : ''}`;
      action = `<button class="secondary" data-wait="${s.hour}" data-class="${s.classKey}" data-label="${esc(label)}">Anotarme en lista de espera</button>`;
    } else if (s.free === 0) {
      cls = 'full'; status = 'Completo';
    } else if (s.planBlock) {
      cls = 'full'; status = esc(s.planBlock);
    } else {
      cls = 'free'; status = s.free === 1 ? 'Queda 1 lugar' : `${s.free} lugares libres`;
      action = `<button data-book="${s.hour}" data-class="${s.classKey}" data-label="${esc(label)}">Reservar</button>`;
    }
    return `${sectionTitle(data.slots, i)}<li class="slot ${cls}">
      <span class="hour">${s.label}</span>
      <span class="info">
        ${classTag(s)} <small class="muted">hasta ${s.end}</small><br>
        <span class="status">${status}</span>${s.blocked || s.capacity > 3 ? '' : dots(s.taken, s.capacity)}
      </span>
      ${action}
    </li>`;
  }).join('');

  $('#slots').querySelectorAll('[data-book]').forEach((b) => {
    b.onclick = () => book(b, Number(b.dataset.book), b.dataset.class, b.dataset.label);
  });
  $('#slots').querySelectorAll('[data-cancel]').forEach((b) => {
    b.onclick = () => cancel(b, b.dataset.cancel, selectedDay, b.dataset.label, !!b.dataset.fixed);
  });
  $('#slots').querySelectorAll('[data-wait]').forEach((b) => {
    b.onclick = () => joinWaitlist(b, Number(b.dataset.wait), b.dataset.class, b.dataset.label);
  });
  $('#slots').querySelectorAll('[data-unwait]').forEach((b) => {
    b.onclick = () => leaveWaitlist(b, b.dataset.unwait);
  });
}

function weekdayOf(date) {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

function cancelButton(b) {
  return `<button class="danger small" data-id="${b.id}" data-date="${b.date}" data-fixed="${b.fixed ? 1 : ''}"
    data-label="${esc(`${b.label} hs · ${b.className}`)}">Cancelar</button>`;
}

// Los turnos fijos se muestran en un renglón cada uno, con sus fechas en un desplegable,
// para no llenar la lista con la misma clase repetida todas las semanas.
function fixedGroup(f, dates) {
  const key = `${f.weekday}-${f.hour}`;
  const next = dates[0];
  return `<li class="fixed-group">
    <details data-fixed-key="${key}" ${openFixed.has(key) ? 'open' : ''}>
      <summary>
        <span>${fixedTag()} <b>${WEEKDAY_NAMES[f.weekday]} ${f.label} hs</b> · ${esc(f.className)}<br>
          <small class="muted">${next ? `Próximo: ${longDate(next.date)}` : 'Sin próximas fechas'}</small></span>
        <span class="btn out small">${openFixed.has(key) ? 'Ocultar' : `Ver fechas (${dates.length})`}</span>
      </summary>
      <p class="hint" style="margin:8px 0">Ya estás anotado todas las semanas. Si un día no podés, cancelá solo ese día.</p>
      <ul class="fixed-dates">${dates.map((b) => `<li><span>${longDate(b.date)}</span>${cancelButton(b)}</li>`).join('')}</ul>
    </details>
  </li>`;
}

async function loadMine() {
  const { bookings, waitlist, fixed } = await api('GET', '/api/my-bookings');
  const isFixedOf = (f) => (b) => b.fixed && b.hour === f.hour && weekdayOf(b.date) === f.weekday;
  const fixedHtml = fixed.map((f) => fixedGroup(f, bookings.filter(isFixedOf(f)))).join('');
  // Fijos que ya no están en la lista de fijos (ej. lo quitaron) se muestran como turnos comunes.
  const others = bookings.filter((b) => !fixed.some((f) => isFixedOf(f)(b)));
  const SHOW = 6;
  const visible = showAllMine ? others : others.slice(0, SHOW);
  const othersHtml = visible.map((b) => `<li><span>${longDate(b.date)} · ${b.label} hs · ${esc(b.className)}</span>${cancelButton(b)}</li>`).join('')
    + (others.length > SHOW ? `<li class="more"><button class="link" type="button" id="toggle-mine">${showAllMine ? 'Ver menos' : `Ver todos (${others.length})`}</button></li>` : '');

  $('#my').innerHTML = (bookings.length ? fixedHtml + othersHtml : '<p class="empty">Todavía no tenés turnos reservados.</p>')
    + waitlist.map((w) => `<li class="waiting-item"><span>⏳ En lista de espera (puesto ${w.position}): ${longDate(w.date)} · ${w.label} hs · ${esc(w.className)}</span>
        <button class="secondary small" data-unwait="${w.id}">Salir</button></li>`).join('');
  $('#my').querySelectorAll('details[data-fixed-key]').forEach((d) => {
    d.ontoggle = () => {
      if (d.open) openFixed.add(d.dataset.fixedKey); else openFixed.delete(d.dataset.fixedKey);
      const label = d.querySelector('summary .btn');
      label.textContent = d.open ? 'Ocultar' : `Ver fechas (${d.querySelectorAll('.fixed-dates li').length})`;
    };
  });
  $('#my').querySelectorAll('[data-id]').forEach((b) => {
    b.onclick = () => cancel(b, b.dataset.id, b.dataset.date, b.dataset.label, !!b.dataset.fixed);
  });
  const toggle = $('#toggle-mine');
  if (toggle) toggle.onclick = () => { showAllMine = !showAllMine; loadMine(); };
  $('#my').querySelectorAll('[data-unwait]').forEach((b) => {
    b.onclick = () => leaveWaitlist(b, b.dataset.unwait);
  });
}

async function joinWaitlist(button, hour, classKey, label) {
  const ok = await ask({
    title: '¿Anotarte en la lista de espera?',
    message: `${longDate(selectedDay)}\n${label}\nSi alguien cancela, te anotamos automáticamente y te avisamos acá.`,
    ok: 'Sí, anotarme',
  });
  if (!ok) return;
  run(button, async () => {
    const { position } = await api('POST', '/api/waitlist', { date: selectedDay, hour, classKey });
    toast(`Estás en la lista de espera (puesto ${position}).`);
    await Promise.all([loadSlots(), loadMine()]);
  });
}

function leaveWaitlist(button, id) {
  run(button, async () => {
    await api('DELETE', `/api/waitlist/${id}`);
    toast('Saliste de la lista de espera.');
    await Promise.all([loadSlots(), loadMine()]);
  });
}

async function book(button, hour, classKey, label) {
  const ok = await ask({ title: '¿Reservar este turno?', message: `${longDate(selectedDay)}\n${label}`, ok: 'Sí, reservar' });
  if (!ok) return;
  run(button, async () => {
    await api('POST', '/api/bookings', { date: selectedDay, hour, classKey });
    toast(`Turno reservado: ${longDate(selectedDay)}, ${label}.`);
    await Promise.all([loadSlots(), loadMine()]);
  });
}

async function cancel(button, id, date, label, fixed = false) {
  const ok = await ask({
    title: '¿Cancelar tu turno?',
    message: `${longDate(date)}\n${label}${fixed ? '\nEs un turno fijo: se cancela solo este día, las otras semanas seguís anotado.' : ''}`,
    ok: 'Sí, cancelar',
    danger: true,
  });
  if (!ok) return;
  run(button, async () => {
    await api('DELETE', `/api/bookings/${id}`);
    toast('Turno cancelado.');
    await Promise.all([loadSlots(), loadMine()]);
  });
}

init().catch((err) => toast(err.message, 'error'));
