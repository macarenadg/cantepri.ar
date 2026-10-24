const { createClient } = require('@libsql/client');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const S = require('./schedule');

// Con TURSO_DATABASE_URL usa la base en la nube (Turso); si no, un archivo SQLite local.
let url = process.env.TURSO_DATABASE_URL;
if (!url) {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  url = `file:${path.join(dataDir, 'turnero.db').replace(/\\/g, '/')}`;
}
const isLocal = url.startsWith('file:');
const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });

function toObjects(result) {
  return result.rows.map((row) => Object.fromEntries(result.columns.map((c, i) => [c, row[i]])));
}

async function all(sql, ...args) {
  return toObjects(await client.execute({ sql, args }));
}

async function get(sql, ...args) {
  return (await all(sql, ...args))[0];
}

async function run(sql, ...args) {
  const r = await client.execute({ sql, args });
  return { changes: r.rowsAffected, lastInsertRowid: r.lastInsertRowid === undefined ? null : Number(r.lastInsertRowid) };
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}

async function init() {
  if (isLocal) await client.execute('PRAGMA journal_mode = WAL');
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,      -- en minúsculas; las cuentas viejas usan el celular
      name TEXT NOT NULL,
      phone TEXT,                         -- celular de contacto (solo números)
      password_hash TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0, -- en desuso: el rol está en "role"
      role TEXT NOT NULL DEFAULT 'alumno', -- rol principal (admin > profesor > alumno), derivado de roles
      roles TEXT,                          -- roles separados por coma, ej. "admin,profesor"
      plan TEXT,                           -- premium | basico (solo alumnos; NULL = sin plan)
      plan_until TEXT,                     -- plan pago hasta (AAAA-MM-DD); NULL = sin fecha
      member_number INTEGER,               -- número de entrenado, correlativo
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      date TEXT NOT NULL,                 -- AAAA-MM-DD
      hour INTEGER NOT NULL,              -- 7..20
      class_key TEXT,                     -- clase dentro del horario (personalizado, recreativo, ...)
      attendance TEXT,                    -- presente | ausente | NULL (sin tomar)
      fixed_id INTEGER,                   -- si la creó un turno fijo
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (user_id, date, hour)        -- una sola clase por horario para cada alumno
    );
    CREATE INDEX IF NOT EXISTS bookings_slot ON bookings (date, hour);

    -- Horarios o días cerrados por el administrador (hour NULL = día completo).
    CREATE TABLE IF NOT EXISTS blocks (
      id INTEGER PRIMARY KEY,
      date TEXT NOT NULL,
      hour INTEGER,
      reason TEXT NOT NULL DEFAULT ''
    );

    -- Lista de espera de clases completas: el primero se anota solo cuando se libera un lugar.
    CREATE TABLE IF NOT EXISTS waitlist (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      hour INTEGER NOT NULL,
      class_key TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (user_id, date, hour, class_key)
    );

    -- Mensajes para un usuario (ej. "te anotamos desde la lista de espera").
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      message TEXT NOT NULL,
      read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Turnos fijos: un alumno va siempre ese día de la semana a esa hora (por ahora, solo Personalizado).
    -- Las reservas se crean solas (bookings.fixed_id) antes de que se abra el día para el resto.
    CREATE TABLE IF NOT EXISTS fixed_slots (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      weekday INTEGER NOT NULL,           -- 1 = lunes ... 5 = viernes
      hour INTEGER NOT NULL,
      class_key TEXT NOT NULL DEFAULT 'personalizado',
      created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (user_id, weekday, hour)
    );

    -- Días puntuales en que un turno fijo no va (lo canceló o se movió): no se vuelve a reservar.
    CREATE TABLE IF NOT EXISTS fixed_skips (
      fixed_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      PRIMARY KEY (fixed_id, date)
    );

    -- Avisos del gimnasio que ven todos al ingresar.
    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY,
      message TEXT NOT NULL,
      until TEXT,                         -- se muestra hasta esta fecha inclusive; NULL = hasta que se borre
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // La primera versión de slot_teachers (sin class_key) nunca se publicó: si existe, se recrea.
  const teacherCols = (await all('PRAGMA table_info(slot_teachers)')).map((c) => c.name);
  if (teacherCols.length && !teacherCols.includes('class_key')) await run('DROP TABLE slot_teachers');
  await client.execute(`
    -- Qué profesor da cada clase de la grilla semanal (weekday: 1 = lunes ... 5 = viernes).
    CREATE TABLE IF NOT EXISTS slot_teachers (
      weekday INTEGER NOT NULL,
      hour INTEGER NOT NULL,
      class_key TEXT NOT NULL,
      teacher_id INTEGER NOT NULL,
      PRIMARY KEY (weekday, hour, class_key)
    )`);

  // Migraciones de bases creadas con versiones anteriores.
  // Antes había una sola clase por horario: las reservas viejas son de la grupal si había, si no del Personalizado.
  const bookingCols = (await all('PRAGMA table_info(bookings)')).map((c) => c.name);
  if (!bookingCols.includes('class_key')) await run('ALTER TABLE bookings ADD COLUMN class_key TEXT');
  if (!bookingCols.includes('attendance')) await run('ALTER TABLE bookings ADD COLUMN attendance TEXT');
  if (!bookingCols.includes('fixed_id')) await run('ALTER TABLE bookings ADD COLUMN fixed_id INTEGER');
  for (const b of await all('SELECT id, date, hour FROM bookings WHERE class_key IS NULL')) {
    const group = (S.WEEKLY[S.weekday(b.date)] || {})[b.hour];
    await run('UPDATE bookings SET class_key = ? WHERE id = ?', group || 'personalizado', b.id);
  }
  await run('CREATE INDEX IF NOT EXISTS bookings_class ON bookings (date, hour, class_key)');

  const columns = (await all('PRAGMA table_info(users)')).map((c) => c.name);
  // Antes el usuario era el celular; ahora el celular es un dato aparte.
  if (!columns.includes('phone')) {
    await run('ALTER TABLE users ADD COLUMN phone TEXT');
    await run("UPDATE users SET phone = username WHERE is_admin = 0 AND username NOT GLOB '*[^0-9]*'");
  }
  // Roles: antes solo existía is_admin.
  if (!columns.includes('role')) {
    await run("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'alumno'");
    await run("UPDATE users SET role = 'admin' WHERE is_admin = 1");
  }
  if (!columns.includes('plan')) await run('ALTER TABLE users ADD COLUMN plan TEXT');
  if (!columns.includes('plan_until')) await run('ALTER TABLE users ADD COLUMN plan_until TEXT');
  // Varios roles por usuario: antes había uno solo en "role".
  if (!columns.includes('roles')) await run('ALTER TABLE users ADD COLUMN roles TEXT');
  await run('UPDATE users SET roles = role WHERE roles IS NULL');
  // Número de entrenado: a las cuentas existentes se les asigna por orden de creación.
  if (!columns.includes('member_number')) {
    await run('ALTER TABLE users ADD COLUMN member_number INTEGER');
    await run('UPDATE users SET member_number = (SELECT COUNT(*) FROM users u2 WHERE u2.id <= users.id)');
  }
  await run('CREATE UNIQUE INDEX IF NOT EXISTS users_member_number ON users (member_number)');

  // Crea el administrador inicial si todavía no hay ninguno. Sin ADMIN_PASSWORD, en producción
  // no arranca; en desarrollo genera una clave al azar y la muestra una sola vez.
  if (!(await get("SELECT 1 FROM users WHERE role = 'admin'"))) {
    const username = (process.env.ADMIN_USER || 'admin').toLowerCase();
    let password = process.env.ADMIN_PASSWORD;
    if (!password) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('Falta ADMIN_PASSWORD para crear el administrador inicial.');
      }
      password = crypto.randomBytes(6).toString('base64url');
    }
    await run(`INSERT INTO users (username, name, password_hash, is_admin, role, roles, member_number)
      VALUES (?, ?, ?, 1, 'admin', 'admin', (SELECT COALESCE(MAX(member_number), 0) + 1 FROM users))`,
    username, 'Administrador', hashPassword(password));
    console.log(`Administrador creado -> usuario: "${username}"${process.env.ADMIN_PASSWORD ? '' : `, clave: "${password}" (anotala, no se vuelve a mostrar)`}`);
  }

  await run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
}

module.exports = { all, get, run, init, hashPassword, verifyPassword, isLocal };
