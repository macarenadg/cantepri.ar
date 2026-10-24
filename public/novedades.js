async function init() {
  const { user } = await api('GET', '/api/me');
  if (user) $('#back').href = roleHome(user);
  const { version, releases } = await api('GET', '/api/changelog');
  $('#releases').innerHTML = releases.map((r) => `<article class="release card ${r.version === version ? 'current' : ''}">
      <h2>Versión ${esc(r.version)} ${r.version === version ? '<span class="tag plan-premium">Actual</span>' : ''}</h2>
      ${r.date ? `<p class="muted" style="margin:0">${longDate(r.date)}</p>` : ''}
      ${r.sections.map((s) => `<h3>${esc(s.title)}</h3><ul>${s.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`).join('')}
    </article>`).join('') || '<p class="empty">Todavía no hay novedades.</p>';
}

init().catch((err) => toast(err.message, 'error'));
