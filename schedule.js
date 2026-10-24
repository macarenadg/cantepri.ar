// Reglas de horarios: días, horas, clases, cupos y zona horaria del gimnasio.
const TZ = process.env.APP_TZ || 'America/Argentina/Buenos_Aires';
const DAYS_AHEAD = 14; // días que muestra el resumen "próximas clases" del profe
// Los turnos fijos se reservan solos esta cantidad de días antes de que el resto pueda reservar.
const FIXED_HEAD_START = 7;

// Turnos de lunes a viernes: mañana de 7 a 12 y tarde de 17 a 21 (cada uno empieza en punto).
const HOURS = [7, 8, 9, 10, 11, 17, 18, 19, 20];
const LAST_HOUR = HOURS[HOURS.length - 1];

const CLASSES = {
  personalizado: { name: 'Personalizado', capacity: 3, minutes: 60, group: false },
  tecnica: { name: 'Técnica de boxeo', capacity: 8, minutes: 90, group: true },
  recreativo: { name: 'Boxeo recreativo', capacity: 8, minutes: 60, group: true },
  flexibilidad: { name: 'Flexibilidad', capacity: 7, minutes: 60, group: true },
};

// Planes de los alumnos: cuántas clases por semana (lunes a viernes) habilita cada uno.
// null = sin límite, 0 = no incluido.
const PLANS = {
  premium: { name: 'Plan premium', limits: { personalizado: 2, grupal: null } },
  basico: { name: 'Plan básico', limits: { personalizado: 0, grupal: 2 } },
};
const CATEGORY_NAMES = { personalizado: 'clases personalizadas', grupal: 'clases grupales' };

// Grilla semanal. El Personalizado se da en todos los horarios; además, por día
// (1 = lunes ... 5 = viernes), estas clases grupales en paralelo. Un alumno puede
// anotarse en una sola clase por horario.
const WEEKLY = {
  1: { 9: 'recreativo', 19: 'flexibilidad' },
  2: { 8: 'tecnica', 19: 'recreativo' },
  3: { 9: 'recreativo' },
  4: { 8: 'tecnica', 19: 'recreativo' },
  5: { 9: 'recreativo', 19: 'tecnica' },
};

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
});

function now() {
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

function toUTC(date) {
  return new Date(`${date}T12:00:00Z`);
}

function addDays(date, n) {
  const d = toUTC(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function isValidDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = toUTC(date);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

function isClassDay(date) {
  const w = toUTC(date).getUTCDay();
  return w >= 1 && w <= 5;
}

function isClassHour(hour) {
  return HOURS.includes(hour);
}

function hourLabel(hour) {
  return `${String(hour).padStart(2, '0')}:00`;
}

function timeLabel(totalMinutes) {
  return `${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}`;
}

// Qué clase se da en ese día y horario, con su cupo y horario de fin.
function classInfo(key, hour) {
  const c = CLASSES[key];
  return {
    key, name: c.name, capacity: c.capacity, end: timeLabel(hour * 60 + c.minutes),
    category: c.group ? 'grupal' : 'personalizado',
  };
}

// Clases que se dan en ese día y horario: la grupal (si hay) y el Personalizado.
function classesAt(date, hour) {
  const group = (WEEKLY[toUTC(date).getUTCDay()] || {})[hour];
  return [...(group ? [group] : []), 'personalizado'].map((key) => classInfo(key, hour));
}

// La clase `key` en ese día y horario, o null si no se da.
function classAt(date, hour, key) {
  return classesAt(date, hour).find((c) => c.key === key) || null;
}

function categoryOf(key) {
  return CLASSES[key] && CLASSES[key].group ? 'grupal' : 'personalizado';
}

function weekday(date) {
  return toUTC(date).getUTCDay();
}

// Lunes y viernes de la semana de esa fecha.
function weekRange(date) {
  const monday = addDays(date, -((weekday(date) + 6) % 7));
  return { from: monday, to: addDays(monday, 4) };
}

// El próximo día con clases después de esa fecha.
function nextClassDay(date) {
  let d = addDays(date, 1);
  while (!isClassDay(d)) d = addDays(d, 1);
  return d;
}

// Un turno se considera pasado desde que empieza.
function isPast(date, hour) {
  const n = now();
  return date < n.date || (date === n.date && hour <= n.hour);
}

// Último día que pueden reservar los alumnos: el fin del mes siguiente.
function windowEnd() {
  const [y, m] = now().date.split('-').map(Number);
  return new Date(Date.UTC(y, m + 1, 0, 12)).toISOString().slice(0, 10); // día 0 del mes m+2 = último del m+1
}

function withinWindow(date) {
  return date >= now().date && date <= windowEnd();
}

function bookableDays() {
  const n = now();
  const end = windowEnd();
  const days = [];
  for (let d = n.date; d <= end; d = addDays(d, 1)) {
    if (d === n.date && n.hour >= LAST_HOUR) continue;
    if (isClassDay(d)) days.push(d);
  }
  return days;
}

module.exports = {
  HOURS, DAYS_AHEAD, FIXED_HEAD_START, PLANS, CATEGORY_NAMES, now, addDays, isValidDate, isClassDay, isClassHour, isPast,
  withinWindow, windowEnd, bookableDays, hourLabel, classesAt, classAt, categoryOf, weekday, weekRange, nextClassDay,
  WEEKLY, CLASSES,
};
