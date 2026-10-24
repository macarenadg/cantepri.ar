const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const S = require('./schedule');

const PORT = Number(process.env.PORT) || 3000;
const SESSION_DAYS = 30;
const SECURE_COOKIE = process.env.NODE_ENV === 'production';
const ROLES = ['admin', 'profesor', 'alumno'];

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Express 4 no captura errores de funciones async: los pasamos a next().
const route = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// ---------- utilidades ----------

function fail(res, status, error) {
  return res.status(status).json({ error });
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function getCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function isUniqueViolation(err) {
  return /UNIQUE constraint failed/i.test(String(err && err.message));
}

const USERNAME_RE = /^[a-z0-9._-]{3,30}$/;

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function phoneProblem(phone) {
  const digits = normalizePhone(phone);
  if (digits.length < 8 || digits.length > 15) return 'El celular no es válido. Escribilo con código de área, solo números.';
  return null;
}

// Nombre y apellido con mayúscula inicial en cada palabra ("maría de los ángeles" -> "María de los Ángeles").
// Los conectores quedan en minúscula salvo al principio; una palabra escrita toda en mayúsculas
// se pasa a minúsculas, y si no se respeta el resto como está (ej. "McLaren").
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

function validateNewUser({ name, username, phone, password }) {
  if (String(name || '').trim().length < 2) return 'Escribí nombre y apellido.';
  if (!USERNAME_RE.test(normalizeUsername(username))) {
    return 'El usuario tiene que tener entre 3 y 30 letras o números, sin espacios (podés usar punto o guion).';
  }
  if (String(password || '').length < 4) return 'La clave tiene que tener al menos 4 caracteres.';
  return phoneProblem(phone);
}

// Un usuario puede tener varios roles (ej. admin y profesor). Se guardan como "admin,profesor".
function parseRoles(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(',');
  return ROLES.filter((r) => list.map((x) => String(x).trim()).includes(r));
}

// Rol principal, para elegir la página de inicio: admin > profesor > alumno.
function primaryRole(roles) {
  return ROLES.find((r) => roles.includes(r)) || 'alumno';
}

function hasRole(user, role) {
  return !!user && user.roles.includes(role);
}

// Condición SQL "el usuario `alias` tiene el rol `role`".
function roleSql(alias, role) {
  return `(',' || ${alias}.roles || ',') LIKE '%,${role},%'`;
}

// Valida roles, plan y fecha de pago; el plan solo aplica a quien es alumno.
function rolesAndPlan(rolesInput, plan, planUntil) {
  const roles = parseRoles(rolesInput);
  if (!roles.length) return { error: 'Elegí al menos un rol.' };
  if (!roles.includes('alumno')) return { roles, plan: null, planUntil: null };
  const cleanPlan = plan === undefined || plan === null || plan === '' ? null : plan;
  if (cleanPlan && !S.PLANS[cleanPlan]) return { error: 'Plan no válido.' };
  const until = planUntil === undefined || planUntil === null || planUntil === '' ? null : String(planUntil);
  if (until && !S.isValidDate(until)) return { error: 'La fecha de pago no es válida.' };
  return { roles, plan: cleanPlan, planUntil: until };
}

// Estado del pago del plan: 'vencido', 'por-vencer' (5 días o menos) o 'al-dia'; null si no hay fecha.
function planStatus(planUntil) {
  if (!planUntil) return null;
  const today = S.now().date;
  if (planUntil < today) return 'vencido';
  if (planUntil <= S.addDays(today, 5)) return 'por-vencer';
  return 'al-dia';
}

function hashPassword(password) {
  return db.hashPassword(String(password));
}

function publicUser(u) {
  const roles = parseRoles(u.roles || u.role);
  return {
    id: u.id,
    name: u.name,
    username: u.username,
    phone: u.phone || '',
    roles,
    role: primaryRole(roles),
    plan: u.plan || null,
    planName: u.plan && S.PLANS[u.plan] ? S.PLANS[u.plan].name : null,
    planUntil: u.plan_until || null,
    planStatus: planStatus(u.plan_until),
    memberNumber: u.member_number,
    isAdmin: roles.includes('admin'),
  };
}

// El número de entrenado se calcula en la misma sentencia para que sea correlativo.
async function createUser(body, { roles = ['alumno'], plan = null, planUntil = null } = {}) {
  return db.run(`
    INSERT INTO users (username, name, phone, password_hash, role, roles, plan, plan_until, member_number)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(member_number), 0) + 1 FROM users))`,
  normalizeUsername(body.username), formatName(body.name), normalizePhone(body.phone), hashPassword(body.password),
  primaryRole(roles), roles.join(','), plan, planUntil);
}

async function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  await db.run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
    sha256(token), userId, Date.now() + maxAge * 1000);
  res.setHeader('Set-Cookie',
    `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${SECURE_COOKIE ? '; Secure' : ''}`);
}

// Devuelve un mensaje de error si no se puede ocupar esa clase en ese horario, o null si está disponible.
async function slotProblem(date, hour, classKey, { staff = false } = {}) {
  if (!S.isValidDate(date) || !S.isClassHour(hour)) return 'Horario no válido.';
  if (!S.isClassDay(date)) return 'Solo hay clases de lunes a viernes.';
  if (!S.classAt(date, hour, classKey)) return 'Esa clase no se da en ese horario.';
  if (S.isPast(date, hour)) return 'Ese horario ya pasó.';
  if (!staff && !S.withinWindow(date)) return `Por ahora se puede reservar hasta el ${dateText(S.windowEnd())}.`;
  if (await db.get('SELECT 1 FROM blocks WHERE date = ? AND (hour IS NULL OR hour = ?)', date, hour)) {
    return 'Ese horario está cerrado.';
  }
  return null;
}

// Inserta la reserva solo si queda cupo en esa clase, en una única sentencia (sin carreras entre
// pedidos simultáneos). UNIQUE (user_id, date, hour) impide anotarse en dos clases del mismo horario.
async function insertBooking(userId, date, hour, classKey, fixedId = null) {
  const { changes } = await db.run(`
    INSERT INTO bookings (user_id, date, hour, class_key, fixed_id)
    SELECT ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM bookings WHERE date = ? AND hour = ? AND class_key = ?) < ?`,
  userId, date, hour, classKey, fixedId, date, hour, classKey, S.classAt(date, hour, classKey).capacity);
  return changes > 0;
}

// ---------- turnos fijos ----------

// Crea las reservas de los turnos fijos que falten, desde hoy hasta unos días después de lo que
// pueden reservar los alumnos (así los fijos tienen prioridad). Se salta los días cancelados
// (fixed_skips), cerrados o ya completos. Corre como mucho cada 10 minutos, salvo `force`.
let lastFixedRun = 0;
async function materializeFixed({ force = false } = {}) {
  if (!force && Date.now() - lastFixedRun < 10 * 60 * 1000) return;
  lastFixedRun = Date.now();
  const n = S.now();
  const until = S.addDays(S.windowEnd(), S.FIXED_HEAD_START);
  const [fixed, skips, blocks, existing] = await Promise.all([
    db.all('SELECT * FROM fixed_slots'),
    db.all('SELECT fixed_id, date FROM fixed_skips WHERE date >= ?', n.date),
    db.all('SELECT date, hour FROM blocks WHERE date >= ?', n.date),
    db.all('SELECT user_id, date, hour FROM bookings WHERE date >= ?', n.date),
  ]);
  if (!fixed.length) return;
  const booked = new Set(existing.map((b) => `${b.user_id}|${b.date}|${b.hour}`));
  const skipped = new Set(skips.map((s) => `${s.fixed_id}|${s.date}`));
  for (let d = n.date; d <= until; d = S.addDays(d, 1)) {
    if (!S.isClassDay(d)) continue;
    for (const f of fixed) {
      if (f.weekday !== S.weekday(d) || S.isPast(d, f.hour) || !S.classAt(d, f.hour, f.class_key)) continue;
      if (skipped.has(`${f.id}|${d}`) || booked.has(`${f.user_id}|${d}|${f.hour}`)) continue;
      if (blocks.some((b) => b.date === d && (b.hour === null || b.hour === f.hour))) continue;
      try {
        if (await insertBooking(f.user_id, d, f.hour, f.class_key, f.id)) {
          booked.add(`${f.user_id}|${d}|${f.hour}`);
          await leaveWaitlistsAt(f.user_id, d, f.hour);
        }
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
    }
  }
}

// Fecha de referencia para consultar la grilla por día de semana (2024-01-01 fue lunes).
function sampleDate(weekday) {
  return S.addDays('2024-01-01', weekday - 1);
}

// Si un turno fijo no va un día (cancelado o movido), se recuerda para no volver a reservarlo.
async function skipFixed(booking) {
  if (!booking.fixed_id) return;
  await db.run('INSERT OR IGNORE INTO fixed_skips (fixed_id, date) VALUES (?, ?)', booking.fixed_id, booking.date);
}

// ---------- planes ----------

// Cuántas clases de cada categoría tiene reservadas el alumno en la semana (lunes a viernes) de esa fecha.
async function weekUsage(userId, date, ignoreBookingId = null) {
  const { from, to } = S.weekRange(date);
  const rows = await db.all('SELECT class_key FROM bookings WHERE user_id = ? AND date BETWEEN ? AND ? AND id IS NOT ?',
    userId, from, to, ignoreBookingId);
  const usage = { personalizado: 0, grupal: 0 };
  for (const b of rows) usage[S.categoryOf(b.class_key)]++;
  return usage;
}

// Mensaje si el plan del alumno no le permite esa clase, o null si puede.
// `self` = lo reserva el propio alumno (cambia la redacción).
async function planProblem(student, date, classKey, { self, ignoreBookingId = null }) {
  const plan = S.PLANS[student.plan];
  if (!plan) {
    return self ? 'Todavía no tenés un plan asignado. Consultá en el gimnasio para poder reservar.'
      : `${student.name} no tiene un plan asignado.`;
  }
  const category = S.categoryOf(classKey);
  const limit = plan.limits[category];
  const what = S.CATEGORY_NAMES[category];
  if (limit === null) return null;
  if (limit === 0) return self ? `Tu plan (${plan.name}) no incluye ${what}.` : `El ${plan.name} de ${student.name} no incluye ${what}.`;
  const used = (await weekUsage(student.id, date, ignoreBookingId))[category];
  if (used < limit) return null;
  return self ? `Ya usaste tus ${limit} ${what} de esta semana.` : `${student.name} ya usó sus ${limit} ${what} de esta semana.`;
}

function planSummary(plan, usage, planUntil = null) {
  const p = S.PLANS[plan];
  if (!p) return null;
  return {
    key: plan,
    name: p.name,
    until: planUntil,
    status: planStatus(planUntil),
    categories: Object.entries(p.limits).map(([category, limit]) => ({
      category, label: S.CATEGORY_NAMES[category], limit, used: usage[category],
    })),
  };
}

// ---------- grilla y profesores ----------

async function teacherAt(date, hour, classKey) {
  return db.get(`
    SELECT u.id, u.name FROM slot_teachers st JOIN users u ON u.id = st.teacher_id
    WHERE st.weekday = ? AND st.hour = ? AND st.class_key = ? AND ${roleSql('u', 'profesor')}`, S.weekday(date), hour, classKey);
}

async function canManageSlot(user, date, hour, classKey) {
  if (hasRole(user, 'admin')) return true;
  if (!hasRole(user, 'profesor')) return false;
  const teacher = await teacherAt(date, hour, classKey);
  return !!teacher && teacher.id === user.id;
}

// Arma las clases de cada día entre `from` y `to` con pocas consultas: una entrada por cada clase
// de cada horario (ej. a las 19, Boxeo recreativo y Personalizado).
// Los anotados (`people`) solo se incluyen si quien mira puede gestionar esa clase.
async function buildDays(from, to, viewer) {
  const [bookings, blocks, teachers, waits] = await Promise.all([
    db.all(`
      SELECT b.id, b.date, b.hour, b.class_key, b.user_id, b.attendance, b.fixed_id, u.name, u.username, u.phone, u.member_number, u.plan, u.plan_until
      FROM bookings b JOIN users u ON u.id = b.user_id
      WHERE b.date BETWEEN ? AND ? ORDER BY b.created_at, b.id`, from, to),
    db.all('SELECT id, date, hour, reason FROM blocks WHERE date BETWEEN ? AND ?', from, to),
    db.all(`
      SELECT st.weekday, st.hour, st.class_key, u.id, u.name FROM slot_teachers st JOIN users u ON u.id = st.teacher_id
      WHERE ${roleSql('u', 'profesor')}`),
    db.all(`
      SELECT w.id, w.date, w.hour, w.class_key, w.user_id, u.name, u.member_number
      FROM waitlist w JOIN users u ON u.id = w.user_id
      WHERE w.date BETWEEN ? AND ? ORDER BY w.created_at, w.id`, from, to),
  ]);

  const days = [];
  for (let date = from; date <= to; date = S.addDays(date, 1)) {
    const dayBlocks = blocks.filter((b) => b.date === date);
    const dayBlock = dayBlocks.find((b) => b.hour === null) || null;
    const slots = S.HOURS.flatMap((hour) => S.classesAt(date, hour).map((cls, i) => {
      const atHour = bookings.filter((b) => b.date === date && b.hour === hour);
      const list = atHour.filter((b) => b.class_key === cls.key);
      const hourBlock = dayBlocks.find((b) => b.hour === hour) || null;
      const block = dayBlock || hourBlock;
      const teacher = teachers.find((t) => t.weekday === S.weekday(date) && t.hour === hour && t.class_key === cls.key) || null;
      const mine = list.find((b) => b.user_id === viewer.id);
      const slot = {
        myFixed: !!(mine && mine.fixed_id),
        hour,
        label: S.hourLabel(hour),
        firstOfHour: i === 0,
        end: cls.end,
        classKey: cls.key,
        className: cls.name,
        category: cls.category,
        capacity: cls.capacity,
        taken: list.length,
        free: Math.max(0, cls.capacity - list.length),
        myBookingId: mine ? mine.id : null,
        // Ya está anotado en otra clase de este mismo horario.
        busyHour: !mine && atHour.some((b) => b.user_id === viewer.id),
        blocked: !!block,
        reason: block ? block.reason : null,
        past: S.isPast(date, hour),
        teacher: teacher ? { id: teacher.id, name: teacher.name } : null,
      };
      const queue = waits.filter((w) => w.date === date && w.hour === hour && w.class_key === cls.key);
      const myWait = queue.findIndex((w) => w.user_id === viewer.id);
      slot.waitCount = queue.length;
      slot.myWait = myWait >= 0 ? { id: queue[myWait].id, position: myWait + 1 } : null;
      if (hasRole(viewer, 'admin') || (hasRole(viewer, 'profesor') && teacher && teacher.id === viewer.id)) {
        slot.canManage = true;
        slot.canAttend = date <= S.now().date;
        slot.hourBlockId = hourBlock ? hourBlock.id : null;
        slot.people = list.map((b) => ({
          bookingId: b.id, userId: b.user_id, name: b.name, username: b.username, phone: b.phone || '',
          memberNumber: b.member_number, plan: b.plan, planStatus: planStatus(b.plan_until), attendance: b.attendance,
          fixed: !!b.fixed_id,
        }));
        slot.waiting = queue.map((w) => ({ name: w.name, memberNumber: w.member_number }));
      }
      return slot;
    }));
    days.push({
      date,
      classDay: S.isClassDay(date),
      dayBlock: dayBlock ? { id: dayBlock.id, reason: dayBlock.reason } : null,
      slots,
    });
  }
  return days;
}

// Límite simple de intentos de ingreso por IP.
const loginAttempts = new Map();
function tooManyAttempts(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry || entry.until < Date.now()) return false;
  return entry.count >= 10;
}
function recordFailure(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry || entry.until < Date.now()) loginAttempts.set(ip, { count: 1, until: Date.now() + 15 * 60 * 1000 });
  else entry.count++;
}

// ---------- sesión ----------

app.use('/api', route(async (req, res, next) => {
  const token = getCookie(req, 'sid');
  if (token) {
    const user = await db.get(`
      SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?`, sha256(token), Date.now());
    if (user) req.user = publicUser(user);
  }
  next();
}));

function requireUser(req, res, next) {
  if (!req.user) return fail(res, 401, 'Tenés que ingresar de nuevo.');
  next();
}

function requireAdmin(req, res, next) {
  if (!hasRole(req.user, 'admin')) return fail(res, 403, 'Solo el administrador puede hacer esto.');
  next();
}

function requireStaff(req, res, next) {
  if (!hasRole(req.user, 'admin') && !hasRole(req.user, 'profesor')) return fail(res, 403, 'Solo el personal del gimnasio puede hacer esto.');
  next();
}

function requireProfesor(req, res, next) {
  if (!hasRole(req.user, 'profesor')) return fail(res, 403, 'Esta sección es para profesores.');
  next();
}

// Los que se registran solos son alumnos sin plan: el admin se lo asigna después.
app.post('/api/register', route(async (req, res) => {
  const problem = validateNewUser(req.body);
  if (problem) return fail(res, 400, problem);
  try {
    const { lastInsertRowid } = await createUser(req.body);
    await startSession(res, lastInsertRowid);
    res.json({ user: publicUser(await db.get('SELECT * FROM users WHERE id = ?', lastInsertRowid)) });
  } catch (err) {
    if (isUniqueViolation(err)) return fail(res, 409, 'Ese usuario ya existe. Elegí otro o, si es tuyo, ingresá.');
    throw err;
  }
}));

app.post('/api/login', route(async (req, res) => {
  if (tooManyAttempts(req.ip)) return fail(res, 429, 'Demasiados intentos. Esperá unos minutos.');
  let user = await db.get('SELECT * FROM users WHERE username = ?', normalizeUsername(req.body.username));
  // Las cuentas creadas antes del cambio tienen el celular como usuario: aceptarlo aunque lo escriban con espacios o guiones.
  if (!user && normalizePhone(req.body.username).length >= 8) {
    user = await db.get('SELECT * FROM users WHERE username = ?', normalizePhone(req.body.username));
  }
  if (!user || !db.verifyPassword(String(req.body.password || ''), user.password_hash)) {
    recordFailure(req.ip);
    return fail(res, 401, 'Usuario o clave incorrectos.');
  }
  loginAttempts.delete(req.ip);
  await startSession(res, user.id);
  res.json({ user: publicUser(user) });
}));

app.post('/api/logout', route(async (req, res) => {
  const token = getCookie(req, 'sid');
  if (token) await db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
}));

// ---------- versión y novedades ----------

const VERSION = require('./package.json').version;

// Lee CHANGELOG.md: "## [1.0.0] - 2026-10-24", secciones "### Nuevo" y líneas "- cambio".
function readChangelog() {
  let text = '';
  try {
    text = fs.readFileSync(path.join(__dirname, 'CHANGELOG.md'), 'utf8');
  } catch {
    return [];
  }
  const releases = [];
  let current = null;
  let section = null;
  for (const line of text.split(/\r?\n/)) {
    const release = line.match(/^## \[(.+?)\](?: - (\d{4}-\d{2}-\d{2}))?/);
    const heading = line.match(/^### (.+)/);
    const item = line.match(/^- (.+)/);
    if (release) {
      current = { version: release[1], date: release[2] || null, sections: [] };
      releases.push(current);
      section = null;
    } else if (heading && current) {
      section = { title: heading[1].trim(), items: [] };
      current.sections.push(section);
    } else if (item && section) {
      section.items.push(item[1].trim());
    }
  }
  return releases;
}
const CHANGELOG = readChangelog();

app.get('/api/version', (req, res) => {
  const latest = CHANGELOG.find((r) => r.version === VERSION);
  res.json({ version: VERSION, date: latest ? latest.date : null });
});

app.get('/api/changelog', (req, res) => {
  res.json({ version: VERSION, releases: CHANGELOG });
});

app.get('/api/me', (req, res) => {
  res.json({ user: req.user || null });
});

app.post('/api/me/password', requireUser, route(async (req, res) => {
  const user = await db.get('SELECT * FROM users WHERE id = ?', req.user.id);
  if (!db.verifyPassword(String(req.body.current || ''), user.password_hash)) return fail(res, 400, 'La clave actual no es correcta.');
  if (String(req.body.password || '').length < 4) return fail(res, 400, 'La clave nueva tiene que tener al menos 4 caracteres.');
  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(req.body.password), user.id);
  res.json({ ok: true });
}));

// ---------- turnos ----------

app.get('/api/days', requireUser, route(async (req, res) => {
  await materializeFixed();
  res.json({ days: S.bookableDays(), today: S.now().date, until: S.windowEnd() });
}));

app.get('/api/slots', requireUser, route(async (req, res) => {
  const date = String(req.query.date || '');
  if (!S.isValidDate(date)) return fail(res, 400, 'Fecha no válida.');
  await materializeFixed();
  const [day] = await buildDays(date, date, req.user);

  // Para alumnos: su plan, cuánto usó esa semana y por qué no puede reservar un horario.
  if (hasRole(req.user, 'alumno')) {
    const usage = await weekUsage(req.user.id, date);
    day.plan = planSummary(req.user.plan, usage, req.user.planUntil);
    for (const slot of day.slots) {
      slot.planBlock = null;
      if (slot.myBookingId || slot.busyHour) continue;
      const plan = S.PLANS[req.user.plan];
      if (!plan) slot.planBlock = 'Sin plan asignado';
      else {
        const limit = plan.limits[slot.category];
        if (limit === 0) slot.planBlock = 'No incluido en tu plan';
        else if (limit !== null && usage[slot.category] >= limit) slot.planBlock = 'Ya usaste tus clases de la semana';
      }
    }
  }
  res.json(day);
}));

app.get('/api/my-bookings', requireUser, route(async (req, res) => {
  await materializeFixed();
  const n = S.now();
  const [rows, waits, fixed] = await Promise.all([
    db.all(`
      SELECT id, date, hour, class_key, fixed_id FROM bookings
      WHERE user_id = ? AND (date > ? OR (date = ? AND hour > ?))
      ORDER BY date, hour`, req.user.id, n.date, n.date, n.hour),
    db.all(`
      SELECT w.id, w.date, w.hour, w.class_key,
        (SELECT COUNT(*) FROM waitlist w2 WHERE w2.date = w.date AND w2.hour = w.hour AND w2.class_key = w.class_key
          AND (w2.created_at < w.created_at OR (w2.created_at = w.created_at AND w2.id <= w.id))) AS position
      FROM waitlist w WHERE w.user_id = ? AND (w.date > ? OR (w.date = ? AND w.hour > ?))
      ORDER BY w.date, w.hour`, req.user.id, n.date, n.date, n.hour),
    db.all('SELECT weekday, hour, class_key FROM fixed_slots WHERE user_id = ? ORDER BY weekday, hour', req.user.id),
  ]);
  const className = (key) => (S.CLASSES[key] || {}).name || '';
  res.json({
    bookings: rows.map((b) => ({
      id: b.id, date: b.date, hour: b.hour, label: S.hourLabel(b.hour), className: className(b.class_key), fixed: !!b.fixed_id,
    })),
    fixed: fixed.map((f) => ({ weekday: f.weekday, hour: f.hour, label: S.hourLabel(f.hour), className: className(f.class_key) })),
    waitlist: waits.map((w) => ({
      id: w.id, date: w.date, hour: w.hour, label: S.hourLabel(w.hour), className: className(w.class_key), position: w.position,
    })),
  });
}));

// ---------- lista de espera y notificaciones ----------

const DAY_NAMES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

function dateText(date) {
  const d = new Date(`${date}T12:00:00Z`);
  return `${DAY_NAMES[d.getUTCDay()]} ${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
}

async function notify(userId, message) {
  await db.run('INSERT INTO notifications (user_id, message) VALUES (?, ?)', userId, message);
}

// Quien ya está en una clase de ese horario deja de esperar en las otras de la misma hora.
async function leaveWaitlistsAt(userId, date, hour) {
  await db.run('DELETE FROM waitlist WHERE user_id = ? AND date = ? AND hour = ?', userId, date, hour);
}

// Cuando se libera un lugar, anota al primero de la lista de espera que pueda (según su plan)
// y le deja una notificación. Los que no pueden por su plan siguen esperando.
async function promoteWaitlist(date, hour, classKey) {
  const cls = S.classAt(date, hour, classKey);
  if (!cls || S.isPast(date, hour)) return;
  if (await db.get('SELECT 1 FROM blocks WHERE date = ? AND (hour IS NULL OR hour = ?)', date, hour)) return;
  const queue = await db.all(`
    SELECT w.id AS wait_id, u.* FROM waitlist w JOIN users u ON u.id = w.user_id
    WHERE w.date = ? AND w.hour = ? AND w.class_key = ? ORDER BY w.created_at, w.id`, date, hour, classKey);
  for (const student of queue) {
    if (await planProblem(student, date, classKey, { self: true })) continue;
    try {
      if (!(await insertBooking(student.id, date, hour, classKey))) return; // se volvió a llenar
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      await db.run('DELETE FROM waitlist WHERE id = ?', student.wait_id); // ya está en otra clase a esa hora
      continue;
    }
    await leaveWaitlistsAt(student.id, date, hour);
    await notify(student.id, `¡Se liberó un lugar! Te anotamos en ${cls.name} el ${dateText(date)} a las ${S.hourLabel(hour)} hs. `
      + 'Si no podés ir, cancelalo desde "Mis próximos turnos".');
    return;
  }
}

app.post('/api/waitlist', requireUser, route(async (req, res) => {
  if (!hasRole(req.user, 'alumno')) return fail(res, 403, 'La lista de espera es para alumnos.');
  const date = String(req.body.date || '');
  const hour = Number(req.body.hour);
  const classKey = String(req.body.classKey || '');
  const problem = await slotProblem(date, hour, classKey);
  if (problem) return fail(res, 400, problem);
  const { c } = await db.get('SELECT COUNT(*) AS c FROM bookings WHERE date = ? AND hour = ? AND class_key = ?', date, hour, classKey);
  if (c < S.classAt(date, hour, classKey).capacity) return fail(res, 400, 'Hay lugar en esa clase: podés reservar directamente.');
  if (await db.get('SELECT 1 FROM bookings WHERE user_id = ? AND date = ? AND hour = ?', req.user.id, date, hour)) {
    return fail(res, 409, 'Ya estás anotado en una clase de ese horario.');
  }
  const student = await db.get('SELECT * FROM users WHERE id = ?', req.user.id);
  const planMessage = await planProblem(student, date, classKey, { self: true });
  if (planMessage) return fail(res, 400, planMessage);
  try {
    await db.run('INSERT INTO waitlist (user_id, date, hour, class_key) VALUES (?, ?, ?, ?)', req.user.id, date, hour, classKey);
  } catch (err) {
    if (isUniqueViolation(err)) return fail(res, 409, 'Ya estás en la lista de espera de esa clase.');
    throw err;
  }
  const { position } = await db.get('SELECT COUNT(*) AS position FROM waitlist WHERE date = ? AND hour = ? AND class_key = ?', date, hour, classKey);
  res.json({ ok: true, position });
}));

app.delete('/api/waitlist/:id', requireUser, route(async (req, res) => {
  await db.run('DELETE FROM waitlist WHERE id = ? AND user_id = ?', Number(req.params.id), req.user.id);
  res.json({ ok: true });
}));

app.get('/api/notifications', requireUser, route(async (req, res) => {
  const rows = await db.all('SELECT id, message, created_at FROM notifications WHERE user_id = ? AND read = 0 ORDER BY id', req.user.id);
  res.json({ notifications: rows });
}));

app.post('/api/notifications/read', requireUser, route(async (req, res) => {
  await db.run('UPDATE notifications SET read = 1 WHERE user_id = ?', req.user.id);
  res.json({ ok: true });
}));

// Avisos vigentes del gimnasio, para todos los que ingresan.
app.get('/api/announcements', requireUser, route(async (req, res) => {
  const rows = await db.all('SELECT id, message, until FROM announcements WHERE until IS NULL OR until >= ? ORDER BY id DESC', S.now().date);
  res.json({ announcements: rows });
}));

// Reserva un turno para un alumno. Si lo anota el personal (`staff`), el límite del plan no bloquea:
// se devuelve como aviso en `warning`.
async function book(res, student, date, hour, classKey, { staff }) {
  const problem = await slotProblem(date, hour, classKey, { staff });
  if (problem) return fail(res, 400, problem);
  const planMessage = await planProblem(student, date, classKey, { self: !staff });
  if (planMessage && !staff) return fail(res, 400, planMessage);
  try {
    if (!(await insertBooking(student.id, date, hour, classKey))) return fail(res, 400, 'Esa clase está completa.');
  } catch (err) {
    if (isUniqueViolation(err)) {
      return fail(res, 409, staff ? 'Ese alumno ya está anotado en una clase de ese horario.'
        : 'Ya estás anotado en una clase de ese horario. Si querés cambiarte, cancelá esa primero.');
    }
    throw err;
  }
  await leaveWaitlistsAt(student.id, date, hour);
  res.json({ ok: true, warning: staff ? planMessage : null });
}

app.post('/api/bookings', requireUser, route(async (req, res) => {
  if (!hasRole(req.user, 'alumno')) return fail(res, 403, 'Los turnos son para alumnos. Para anotar a alguien, usá tu panel.');
  const student = await db.get('SELECT * FROM users WHERE id = ?', req.user.id);
  await book(res, student, String(req.body.date || ''), Number(req.body.hour), String(req.body.classKey || ''), { staff: false });
}));

// Cancelar (el propio alumno, hasta que empiece) o quitar (admin o el profe de esa clase).
app.delete('/api/bookings/:id', requireUser, route(async (req, res) => {
  const booking = await db.get('SELECT * FROM bookings WHERE id = ?', Number(req.params.id));
  if (!booking) return fail(res, 404, 'Ese turno ya no existe.');
  if (!(await canManageSlot(req.user, booking.date, booking.hour, booking.class_key))) {
    if (booking.user_id !== req.user.id) return fail(res, 403, 'Solo podés quitar alumnos de tus propias clases.');
    if (S.isPast(booking.date, booking.hour)) return fail(res, 400, 'No se puede cancelar un turno que ya empezó.');
  }
  await db.run('DELETE FROM bookings WHERE id = ?', booking.id);
  await skipFixed(booking); // si era de un turno fijo, ese día no se vuelve a reservar
  await promoteWaitlist(booking.date, booking.hour, booking.class_key);
  res.json({ ok: true });
}));

// ---------- personal (admin y profesores) ----------

app.use('/api/staff', requireStaff);

app.get('/api/staff/students', route(async (req, res) => {
  const rows = await db.all(`SELECT * FROM users u WHERE ${roleSql('u', 'alumno')} ORDER BY name COLLATE NOCASE`);
  res.json({ students: rows.map(publicUser) });
}));

// Asistencia: la marca el profe de la clase o el admin, desde el día de la clase.
app.put('/api/staff/bookings/:id/attendance', route(async (req, res) => {
  const booking = await db.get('SELECT * FROM bookings WHERE id = ?', Number(req.params.id));
  if (!booking) return fail(res, 404, 'Ese turno ya no existe.');
  if (!(await canManageSlot(req.user, booking.date, booking.hour, booking.class_key))) {
    return fail(res, 403, 'Solo podés tomar asistencia en tus propias clases.');
  }
  if (booking.date > S.now().date) return fail(res, 400, 'La asistencia se toma el día de la clase.');
  const status = req.body.status === null ? null : String(req.body.status || '');
  if (status !== null && !['presente', 'ausente'].includes(status)) return fail(res, 400, 'Asistencia no válida.');
  await db.run('UPDATE bookings SET attendance = ? WHERE id = ?', status, booking.id);
  res.json({ ok: true });
}));

app.post('/api/staff/bookings', route(async (req, res) => {
  const student = await db.get('SELECT * FROM users WHERE id = ?', Number(req.body.userId));
  if (!student || !parseRoles(student.roles || student.role).includes('alumno')) return fail(res, 404, 'Ese alumno no existe.');
  const date = String(req.body.date || '');
  const hour = Number(req.body.hour);
  const classKey = String(req.body.classKey || '');
  if (S.isValidDate(date) && S.isClassHour(hour) && !(await canManageSlot(req.user, date, hour, classKey))) {
    return fail(res, 403, 'Solo podés anotar alumnos en tus propias clases.');
  }
  await book(res, student, date, hour, classKey, { staff: true });
}));

// Turnos fijos. El admin ve y gestiona todos; el profe, los de los Personalizados que da.
async function fixedOptions(user) {
  if (hasRole(user, 'admin')) {
    return [1, 2, 3, 4, 5].flatMap((weekday) => S.HOURS.map((hour) => ({ weekday, hour, label: S.hourLabel(hour) })));
  }
  const rows = await db.all("SELECT weekday, hour FROM slot_teachers WHERE class_key = 'personalizado' AND teacher_id = ? ORDER BY weekday, hour",
    user.id);
  return rows.map((r) => ({ weekday: r.weekday, hour: r.hour, label: S.hourLabel(r.hour) }));
}

app.get('/api/staff/fixed', route(async (req, res) => {
  await materializeFixed();
  const options = await fixedOptions(req.user);
  const rows = await db.all(`
    SELECT f.id, f.user_id, f.weekday, f.hour, f.class_key, u.name, u.member_number, u.plan
    FROM fixed_slots f JOIN users u ON u.id = f.user_id ORDER BY f.weekday, f.hour, u.name`);
  const mine = rows.filter((f) => options.some((o) => o.weekday === f.weekday && o.hour === f.hour));
  res.json({
    options,
    fixed: mine.map((f) => ({
      id: f.id, userId: f.user_id, weekday: f.weekday, hour: f.hour, label: S.hourLabel(f.hour),
      className: (S.CLASSES[f.class_key] || {}).name || '', name: f.name, memberNumber: f.member_number, plan: f.plan,
    })),
  });
}));

app.post('/api/staff/fixed', route(async (req, res) => {
  const student = await db.get('SELECT * FROM users WHERE id = ?', Number(req.body.userId));
  if (!student || !parseRoles(student.roles || student.role).includes('alumno')) return fail(res, 404, 'Ese alumno no existe.');
  const weekday = Number(req.body.weekday);
  const hour = Number(req.body.hour);
  if (!(weekday >= 1 && weekday <= 5) || !S.classAt(sampleDate(weekday), hour, 'personalizado')) {
    return fail(res, 400, 'Ese horario no es válido.');
  }
  if (!(await canManageSlot(req.user, sampleDate(weekday), hour, 'personalizado'))) {
    return fail(res, 403, 'Solo podés crear turnos fijos en los Personalizados que das.');
  }
  // Aviso (no bloquea) si con este fijo se pasa de lo que le da su plan por semana.
  const plan = S.PLANS[student.plan];
  const { c } = await db.get("SELECT COUNT(*) AS c FROM fixed_slots WHERE user_id = ? AND class_key = 'personalizado'", student.id);
  let warning = null;
  if (!plan) warning = `${student.name} no tiene un plan asignado.`;
  else if (plan.limits.personalizado === 0) warning = `El ${plan.name} de ${student.name} no incluye clases personalizadas.`;
  else if (plan.limits.personalizado !== null && c + 1 > plan.limits.personalizado) {
    warning = `Con este, ${student.name} tiene ${c + 1} personalizados fijos por semana y su plan incluye ${plan.limits.personalizado}.`;
  }
  try {
    await db.run("INSERT INTO fixed_slots (user_id, weekday, hour, class_key, created_by) VALUES (?, ?, ?, 'personalizado', ?)",
      student.id, weekday, hour, req.user.id);
  } catch (err) {
    if (isUniqueViolation(err)) return fail(res, 409, `${student.name} ya tiene un turno fijo ese día a esa hora.`);
    throw err;
  }
  await materializeFixed({ force: true });
  res.json({ ok: true, warning });
}));

// Borrar un turno fijo también borra sus reservas futuras (y libera esos lugares).
app.delete('/api/staff/fixed/:id', route(async (req, res) => {
  const f = await db.get('SELECT * FROM fixed_slots WHERE id = ?', Number(req.params.id));
  if (!f) return fail(res, 404, 'Ese turno fijo ya no existe.');
  if (!(await canManageSlot(req.user, sampleDate(f.weekday), f.hour, f.class_key))) {
    return fail(res, 403, 'Solo podés borrar turnos fijos de los Personalizados que das.');
  }
  const n = S.now();
  const future = await db.all('SELECT * FROM bookings WHERE fixed_id = ? AND (date > ? OR (date = ? AND hour > ?))', f.id, n.date, n.date, n.hour);
  for (const b of future) await db.run('DELETE FROM bookings WHERE id = ?', b.id);
  await db.run('UPDATE bookings SET fixed_id = NULL WHERE fixed_id = ?', f.id); // las pasadas quedan como reservas comunes
  await db.run('DELETE FROM fixed_skips WHERE fixed_id = ?', f.id);
  await db.run('DELETE FROM fixed_slots WHERE id = ?', f.id);
  for (const b of future) await promoteWaitlist(b.date, b.hour, b.class_key);
  res.json({ ok: true, removed: future.length });
}));

// Dashboard del profesor: sus clases de hoy y del próximo día con clases, y un resumen de las siguientes.
app.get('/api/profe/agenda', requireProfesor, route(async (req, res) => {
  await materializeFixed();
  const today = S.now().date;
  const next = S.nextClassDay(today);
  const until = S.addDays(today, S.DAYS_AHEAD);
  const all = await buildDays(today, until, req.user);
  const own = (day) => ({ ...day, slots: day.slots.filter((s) => s.teacher && s.teacher.id === req.user.id) });

  const todayDay = own(all.find((d) => d.date === today));
  const nextDay = own(all.find((d) => d.date === next));
  const upcoming = [];
  for (const day of all) {
    if (day.date <= next || !day.classDay) continue;
    for (const s of own(day).slots) {
      upcoming.push({ date: day.date, label: s.label, className: s.className, taken: s.taken, capacity: s.capacity, blocked: s.blocked });
    }
  }
  res.json({ today: todayDay, next: nextDay, upcoming });
}));

// ---------- administración ----------

app.use('/api/admin', requireAdmin);

app.patch('/api/admin/bookings/:id', route(async (req, res) => {
  const booking = await db.get('SELECT * FROM bookings WHERE id = ?', Number(req.params.id));
  if (!booking) return fail(res, 404, 'Ese turno ya no existe.');
  const date = String(req.body.date || '');
  const hour = Number(req.body.hour);
  const classKey = String(req.body.classKey || booking.class_key);
  const problem = await slotProblem(date, hour, classKey, { staff: true });
  if (problem) return fail(res, 400, problem);
  const student = await db.get('SELECT * FROM users WHERE id = ?', booking.user_id);
  const warning = await planProblem(student, date, classKey, { self: false, ignoreBookingId: booking.id });
  try {
    // Un turno fijo movido deja de ser fijo ese día (el día original queda salteado).
    const { changes } = await db.run(`
      UPDATE bookings SET date = ?, hour = ?, class_key = ?, fixed_id = NULL
      WHERE id = ? AND (SELECT COUNT(*) FROM bookings WHERE date = ? AND hour = ? AND class_key = ? AND id <> ?) < ?`,
    date, hour, classKey, booking.id, date, hour, classKey, booking.id, S.classAt(date, hour, classKey).capacity);
    if (!changes) return fail(res, 400, 'Esa clase está completa.');
  } catch (err) {
    if (isUniqueViolation(err)) return fail(res, 409, 'Ese alumno ya está anotado en una clase de ese horario.');
    throw err;
  }
  await leaveWaitlistsAt(booking.user_id, date, hour);
  await skipFixed(booking);
  await promoteWaitlist(booking.date, booking.hour, booking.class_key); // se liberó su lugar anterior
  res.json({ ok: true, warning });
}));

app.post('/api/admin/blocks', route(async (req, res) => {
  const date = String(req.body.date || '');
  const hour = req.body.hour === null || req.body.hour === undefined ? null : Number(req.body.hour);
  const reason = String(req.body.reason || '').trim().slice(0, 120);
  if (!S.isValidDate(date)) return fail(res, 400, 'Fecha no válida.');
  if (hour !== null && !S.isClassHour(hour)) return fail(res, 400, 'Horario no válido.');
  const existing = await db.get('SELECT id FROM blocks WHERE date = ? AND hour IS ?', date, hour);
  if (existing) await db.run('UPDATE blocks SET reason = ? WHERE id = ?', reason, existing.id);
  else await db.run('INSERT INTO blocks (date, hour, reason) VALUES (?, ?, ?)', date, hour, reason);
  res.json({ ok: true });
}));

app.delete('/api/admin/blocks/:id', route(async (req, res) => {
  await db.run('DELETE FROM blocks WHERE id = ?', Number(req.params.id));
  res.json({ ok: true });
}));

// Grilla semanal: qué clases van en cada horario y qué profesor da cada una.
app.get('/api/admin/grid', route(async (req, res) => {
  const [assigned, teachers] = await Promise.all([
    db.all('SELECT weekday, hour, class_key, teacher_id FROM slot_teachers'),
    db.all(`SELECT id, name FROM users u WHERE ${roleSql('u', 'profesor')} ORDER BY name COLLATE NOCASE`),
  ]);
  const days = [1, 2, 3, 4, 5].map((weekday) => ({
    weekday,
    cells: S.HOURS.flatMap((hour) => S.classesAt(sampleDate(weekday), hour).map((cls) => {
      const a = assigned.find((x) => x.weekday === weekday && x.hour === hour && x.class_key === cls.key);
      const teacherId = a && teachers.some((t) => t.id === a.teacher_id) ? a.teacher_id : null;
      return { hour, label: S.hourLabel(hour), classKey: cls.key, className: cls.name, teacherId };
    })),
  }));
  res.json({ days, teachers, classes: Object.entries(S.CLASSES).map(([key, c]) => ({ key, name: c.name })) });
}));

async function setTeacher(weekday, hour, classKey, teacherId) {
  if (teacherId === null) {
    await db.run('DELETE FROM slot_teachers WHERE weekday = ? AND hour = ? AND class_key = ?', weekday, hour, classKey);
  } else {
    await db.run(`
      INSERT INTO slot_teachers (weekday, hour, class_key, teacher_id) VALUES (?, ?, ?, ?)
      ON CONFLICT (weekday, hour, class_key) DO UPDATE SET teacher_id = excluded.teacher_id`, weekday, hour, classKey, teacherId);
  }
}

async function teacherProblem(teacherId) {
  if (teacherId === null) return null;
  return (await db.get(`SELECT 1 FROM users u WHERE id = ? AND ${roleSql('u', 'profesor')}`, teacherId)) ? null : 'Ese usuario no es profesor.';
}

app.put('/api/admin/grid', route(async (req, res) => {
  const weekday = Number(req.body.weekday);
  const hour = Number(req.body.hour);
  const classKey = String(req.body.classKey || '');
  const teacherId = req.body.teacherId ? Number(req.body.teacherId) : null;
  if (!(weekday >= 1 && weekday <= 5) || !S.isClassHour(hour) || !S.classAt(sampleDate(weekday), hour, classKey)) {
    return fail(res, 400, 'Esa clase no se da en ese horario.');
  }
  const problem = await teacherProblem(teacherId);
  if (problem) return fail(res, 400, problem);
  await setTeacher(weekday, hour, classKey, teacherId);
  res.json({ ok: true });
}));

// Asignación rápida: un profesor (o nadie) para todas las clases elegidas de un turno, de lunes a viernes.
app.put('/api/admin/grid/bulk', route(async (req, res) => {
  const classKeys = Array.isArray(req.body.classKeys) ? req.body.classKeys.map(String) : [];
  const period = String(req.body.period || 'todo');
  const teacherId = req.body.teacherId ? Number(req.body.teacherId) : null;
  if (!classKeys.length || classKeys.some((k) => !S.CLASSES[k])) return fail(res, 400, 'Elegí al menos una clase.');
  if (!['manana', 'tarde', 'todo'].includes(period)) return fail(res, 400, 'Turno no válido.');
  const problem = await teacherProblem(teacherId);
  if (problem) return fail(res, 400, problem);
  let count = 0;
  for (let weekday = 1; weekday <= 5; weekday++) {
    for (const hour of S.HOURS) {
      if ((period === 'manana' && hour >= 13) || (period === 'tarde' && hour < 13)) continue;
      for (const cls of S.classesAt(sampleDate(weekday), hour)) {
        if (!classKeys.includes(cls.key)) continue;
        await setTeacher(weekday, hour, cls.key, teacherId);
        count++;
      }
    }
  }
  res.json({ ok: true, count });
}));

app.get('/api/admin/users', route(async (req, res) => {
  const n = S.now();
  const users = await db.all(`
    SELECT u.*,
      (SELECT COUNT(*) FROM bookings b WHERE b.user_id = u.id AND (b.date > ? OR (b.date = ? AND b.hour > ?))) AS upcoming
    FROM users u ORDER BY u.member_number`, n.date, n.date, n.hour);
  res.json({
    users: users.map((u) => ({ ...publicUser(u), createdAt: u.created_at, upcoming: u.upcoming })),
    plans: Object.entries(S.PLANS).map(([key, p]) => ({ key, name: p.name })),
  });
}));

app.post('/api/admin/users', route(async (req, res) => {
  const problem = validateNewUser(req.body);
  if (problem) return fail(res, 400, problem);
  const rp = rolesAndPlan(req.body.roles || req.body.role || ['alumno'], req.body.plan, req.body.planUntil);
  if (rp.error) return fail(res, 400, rp.error);
  try {
    await createUser(req.body, rp);
  } catch (err) {
    if (isUniqueViolation(err)) return fail(res, 409, 'Ese usuario ya existe. Elegí otro.');
    throw err;
  }
  res.json({ ok: true });
}));

app.patch('/api/admin/users/:id', route(async (req, res) => {
  const user = await db.get('SELECT * FROM users WHERE id = ?', Number(req.params.id));
  if (!user) return fail(res, 404, 'Ese usuario no existe.');
  if (req.body.name !== undefined) {
    const name = formatName(req.body.name);
    if (name.length < 2) return fail(res, 400, 'Escribí nombre y apellido.');
    await db.run('UPDATE users SET name = ? WHERE id = ?', name, user.id);
  }
  if (req.body.phone !== undefined) {
    const problem = phoneProblem(req.body.phone);
    if (problem) return fail(res, 400, problem);
    await db.run('UPDATE users SET phone = ? WHERE id = ?', normalizePhone(req.body.phone), user.id);
  }
  // N° de entrenado: entero positivo y único.
  if (req.body.memberNumber !== undefined && Number(req.body.memberNumber) !== user.member_number) {
    const number = Number(req.body.memberNumber);
    if (!Number.isInteger(number) || number < 1 || number > 999999) return fail(res, 400, 'El N° de entrenado tiene que ser un número entero mayor que 0.');
    const owner = await db.get('SELECT name FROM users WHERE member_number = ? AND id <> ?', number, user.id);
    if (owner) return fail(res, 409, `El N° de entrenado ${number} ya lo tiene ${owner.name}.`);
    await db.run('UPDATE users SET member_number = ? WHERE id = ?', number, user.id);
  }
  if (req.body.roles !== undefined || req.body.plan !== undefined || req.body.planUntil !== undefined) {
    const before = parseRoles(user.roles || user.role);
    const rp = rolesAndPlan(
      req.body.roles !== undefined ? req.body.roles : before,
      req.body.plan !== undefined ? req.body.plan : user.plan,
      req.body.planUntil !== undefined ? req.body.planUntil : user.plan_until,
    );
    if (rp.error) return fail(res, 400, rp.error);
    if (user.id === req.user.id && !rp.roles.includes('admin')) return fail(res, 400, 'No podés quitarte el rol de administrador.');
    await db.run('UPDATE users SET role = ?, roles = ?, plan = ?, plan_until = ?, is_admin = ? WHERE id = ?',
      primaryRole(rp.roles), rp.roles.join(','), rp.plan, rp.planUntil, rp.roles.includes('admin') ? 1 : 0, user.id);
    if (before.includes('profesor') && !rp.roles.includes('profesor')) await db.run('DELETE FROM slot_teachers WHERE teacher_id = ?', user.id);
  }
  if (req.body.password !== undefined) {
    if (String(req.body.password).length < 4) return fail(res, 400, 'La clave tiene que tener al menos 4 caracteres.');
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(req.body.password), user.id);
    if (user.id !== req.user.id) await db.run('DELETE FROM sessions WHERE user_id = ?', user.id);
  }
  res.json({ ok: true });
}));

app.delete('/api/admin/users/:id', route(async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return fail(res, 400, 'No podés borrar tu propia cuenta.');
  const n = S.now();
  const freed = await db.all('SELECT date, hour, class_key FROM bookings WHERE user_id = ? AND (date > ? OR (date = ? AND hour > ?))',
    id, n.date, n.date, n.hour);
  for (const table of ['bookings', 'sessions', 'waitlist', 'notifications']) await db.run(`DELETE FROM ${table} WHERE user_id = ?`, id);
  await db.run('DELETE FROM fixed_skips WHERE fixed_id IN (SELECT id FROM fixed_slots WHERE user_id = ?)', id);
  await db.run('DELETE FROM fixed_slots WHERE user_id = ?', id);
  await db.run('DELETE FROM slot_teachers WHERE teacher_id = ?', id);
  await db.run('DELETE FROM users WHERE id = ?', id);
  for (const b of freed) await promoteWaitlist(b.date, b.hour, b.class_key);
  res.json({ ok: true });
}));

// ---------- avisos ----------

app.get('/api/admin/announcements', route(async (req, res) => {
  res.json({ announcements: await db.all('SELECT id, message, until, created_at FROM announcements ORDER BY id DESC') });
}));

app.post('/api/admin/announcements', route(async (req, res) => {
  const message = String(req.body.message || '').trim().slice(0, 300);
  const until = req.body.until ? String(req.body.until) : null;
  if (message.length < 3) return fail(res, 400, 'Escribí el aviso.');
  if (until && !S.isValidDate(until)) return fail(res, 400, 'La fecha no es válida.');
  await db.run('INSERT INTO announcements (message, until) VALUES (?, ?)', message, until);
  res.json({ ok: true });
}));

app.delete('/api/admin/announcements/:id', route(async (req, res) => {
  await db.run('DELETE FROM announcements WHERE id = ?', Number(req.params.id));
  res.json({ ok: true });
}));

// ---------- estadísticas y exportación ----------

function rangeFromQuery(query) {
  const today = S.now().date;
  const from = S.isValidDate(String(query.from || '')) ? String(query.from) : `${today.slice(0, 8)}01`;
  const to = S.isValidDate(String(query.to || '')) ? String(query.to) : today;
  if (from > to) return { error: 'La fecha "desde" tiene que ser anterior a "hasta".' };
  if (S.addDays(from, 366) < to) return { error: 'Elegí un rango de hasta un año.' };
  return { from, to };
}

app.get('/api/admin/stats', route(async (req, res) => {
  const range = rangeFromQuery(req.query);
  if (range.error) return fail(res, 400, range.error);
  const { from, to } = range;
  const n = S.now();
  const [bookings, blocks, users] = await Promise.all([
    db.all(`SELECT b.date, b.hour, b.class_key, b.attendance, b.user_id, u.name, u.member_number
      FROM bookings b JOIN users u ON u.id = b.user_id WHERE b.date BETWEEN ? AND ?`, from, to),
    db.all('SELECT date, hour FROM blocks WHERE date BETWEEN ? AND ?', from, to),
    db.all('SELECT * FROM users'),
  ]);
  const isDone = (b) => S.isPast(b.date, b.hour);
  const done = bookings.filter(isDone);

  // Ocupación por clase: reservas sobre el cupo de todas las veces que se dio esa clase (sin contar cierres).
  const byClass = Object.fromEntries(Object.entries(S.CLASSES).map(([key, c]) => [key, { key, name: c.name, bookings: 0, seats: 0, times: 0 }]));
  for (let d = from; d <= to; d = S.addDays(d, 1)) {
    if (!S.isClassDay(d)) continue;
    for (const hour of S.HOURS) {
      if (blocks.some((b) => b.date === d && (b.hour === null || b.hour === hour))) continue;
      for (const cls of S.classesAt(d, hour)) { byClass[cls.key].seats += cls.capacity; byClass[cls.key].times++; }
    }
  }
  for (const b of bookings) if (byClass[b.class_key]) byClass[b.class_key].bookings++;

  const byHour = S.HOURS.map((hour) => ({ hour, label: S.hourLabel(hour), bookings: bookings.filter((b) => b.hour === hour).length }));

  const perStudent = new Map();
  for (const b of bookings) {
    const s = perStudent.get(b.user_id) || { name: b.name, memberNumber: b.member_number, bookings: 0, present: 0, absent: 0 };
    s.bookings++;
    if (b.attendance === 'presente') s.present++;
    if (b.attendance === 'ausente') s.absent++;
    perStudent.set(b.user_id, s);
  }
  const students = [...perStudent.values()];
  const alumnos = users.map(publicUser).filter((u) => u.roles.includes('alumno'));

  res.json({
    from,
    to,
    totals: {
      bookings: bookings.length,
      upcoming: bookings.length - done.length,
      present: done.filter((b) => b.attendance === 'presente').length,
      absent: done.filter((b) => b.attendance === 'ausente').length,
      unmarked: done.filter((b) => !b.attendance).length,
    },
    byClass: Object.values(byClass).filter((c) => c.times > 0),
    byHour,
    topStudents: [...students].sort((a, b) => b.bookings - a.bookings).slice(0, 10),
    topAbsences: students.filter((s) => s.absent > 0).sort((a, b) => b.absent - a.absent).slice(0, 10),
    students: {
      total: alumnos.length,
      withoutPlan: alumnos.filter((u) => !u.plan).length,
      expired: alumnos.filter((u) => u.planStatus === 'vencido').length,
      expiring: alumnos.filter((u) => u.planStatus === 'por-vencer').length,
      active: new Set(bookings.filter((b) => b.date >= S.addDays(n.date, -30)).map((b) => b.user_id)).size,
    },
  });
}));

// CSV con ";" y BOM para que Excel en español lo abra bien con acentos.
function sendCsv(res, filename, header, rows) {
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = [header, ...rows].map((r) => r.map(cell).join(';')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(`﻿${body}`);
}

const PLAN_LABEL = (plan) => (S.PLANS[plan] ? S.PLANS[plan].name : 'Sin plan');
const ROLE_LABELS = { admin: 'Administrador', profesor: 'Profesor', alumno: 'Alumno' };

app.get('/api/admin/export/bookings', route(async (req, res) => {
  const range = rangeFromQuery(req.query);
  if (range.error) return fail(res, 400, range.error);
  const [rows, teachers] = await Promise.all([
    db.all(`SELECT b.date, b.hour, b.class_key, b.attendance, u.name, u.username, u.phone, u.member_number, u.plan
      FROM bookings b JOIN users u ON u.id = b.user_id WHERE b.date BETWEEN ? AND ? ORDER BY b.date, b.hour, b.class_key, u.name`,
    range.from, range.to),
    db.all('SELECT st.weekday, st.hour, st.class_key, u.name FROM slot_teachers st JOIN users u ON u.id = st.teacher_id'),
  ]);
  const teacher = (b) => (teachers.find((t) => t.weekday === S.weekday(b.date) && t.hour === b.hour && t.class_key === b.class_key) || {}).name || '';
  sendCsv(res, `turnos_${range.from}_a_${range.to}.csv`,
    ['Fecha', 'Día', 'Hora', 'Clase', 'Profe', 'N° entrenado', 'Alumno', 'Usuario', 'Celular', 'Plan', 'Asistencia'],
    rows.map((b) => [b.date, DAY_NAMES[S.weekday(b.date)], S.hourLabel(b.hour), (S.CLASSES[b.class_key] || {}).name || '', teacher(b),
      b.member_number, b.name, b.username, b.phone, PLAN_LABEL(b.plan), b.attendance || '']));
}));

app.get('/api/admin/export/users', route(async (req, res) => {
  const rows = (await db.all('SELECT * FROM users ORDER BY member_number')).map((u) => ({ ...publicUser(u), createdAt: u.created_at }));
  sendCsv(res, 'usuarios.csv',
    ['N° entrenado', 'Nombre', 'Usuario', 'Celular', 'Roles', 'Plan', 'Pago hasta', 'Alta'],
    rows.map((u) => [u.memberNumber, u.name, u.username, u.phone, u.roles.map((r) => ROLE_LABELS[r]).join(' + '),
      u.roles.includes('alumno') ? PLAN_LABEL(u.plan) : '', u.planUntil || '', u.createdAt.slice(0, 10)]));
}));

app.use('/api', (req, res) => fail(res, 404, 'No encontrado.'));

app.use((err, req, res, next) => {
  console.error(err);
  fail(res, 500, 'Hubo un problema en el servidor. Probá de nuevo en un momento.');
});

// Corrige las mayúsculas de los nombres ya cargados (solo cambia los que no estaban bien).
async function fixExistingNames() {
  for (const u of await db.all('SELECT id, name FROM users')) {
    const formatted = formatName(u.name);
    if (formatted && formatted !== u.name) await db.run('UPDATE users SET name = ? WHERE id = ?', formatted, u.id);
  }
}

db.init().then(async () => {
  await fixExistingNames();
  await materializeFixed({ force: true });
  app.listen(PORT, () => {
    console.log(`Balance Center turnero en http://localhost:${PORT} (${db.isLocal ? 'base local' : 'base Turso'})`);
  });
}).catch((err) => {
  console.error('No se pudo iniciar la base de datos:', err);
  process.exit(1);
});
