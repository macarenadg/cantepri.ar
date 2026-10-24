# Turnero Balance Center

App web para reservar las clases personalizadas de **Balance Center**.

- Lunes a viernes, turnos cada hora de 7 a 12 y de 17 a 21. En todos los horarios hay Personalizado (3 personas) y, según la grilla semanal, en paralelo una clase grupal: Técnica de boxeo (8, dura 1 h 30), Boxeo recreativo (8) o Flexibilidad (7). Cada alumno se anota en una sola clase por horario.
- Tres roles combinables: **Administrador**, **Profesor** y **Alumno** (ej. alguien puede ser admin y profe). Cada usuario tiene un número de entrenado correlativo y puede cambiar su clave desde **Mi cuenta**.
- **Turnos fijos** de Personalizado (ej. martes y viernes 7:00): los crea el profe de ese horario o el admin, y el alumno queda anotado solo todas las semanas. Si cancela un día, se cancela solo ese día.
- Los alumnos pueden reservar **hasta el fin del mes siguiente**, eligiendo la semana.
- **Lista de espera** en clases completas: si alguien cancela, se anota automáticamente al primero y se le avisa.
- **Asistencia** (presente / ausente) que toman el profe de la clase y el admin; **WhatsApp** directo a cada alumno.
- **Avisos** del gimnasio para todos, **fecha de pago del plan** con aviso de vencimiento, **estadísticas** y **exportación a Excel** de turnos y usuarios.
- Planes de alumnos (por semana de lunes a viernes): **Premium** (grupales libres + 2 personalizados) y **Básico** (2 grupales, sin personalizado). Sin plan asignado no se puede reservar. El admin y los profes pueden anotar por encima del límite: la app les avisa.
- Profesores: el admin les asigna clases de la grilla (pestaña Grilla), una por una o en bloque (ej. "Boxeo · Por la mañana · Joaco"). Al ingresar ven las clases de hoy y del próximo día con los anotados, pueden agregar o quitar alumnos de sus clases y ven un resumen de las siguientes.
- Los alumnos crean su cuenta con **usuario y clave** (y su celular como dato de contacto), ven por día qué horarios están libres y reservan o cancelan sus turnos.
- El administrador ve quién está anotado en cada horario y puede agregar, mover o quitar reservas, cerrar horarios o días (por ejemplo feriados) y gestionar alumnos (crear, renombrar, cambiar clave, eliminar).

## Cómo correrla

Requisito: Node.js 22.13 o más nuevo. En tu PC los datos se guardan en un archivo SQLite (`data/turnero.db`); en internet, en Turso.

```bash
npm install
npm start          # http://localhost:3000
npm run dev        # igual, pero se reinicia sola al cambiar el código
```

La primera vez se crea el administrador con usuario `admin`. La clave es la de `ADMIN_PASSWORD`; si no la definís, en tu PC se genera una al azar y se muestra **una sola vez** en la consola. En producción (`NODE_ENV=production`), sin `ADMIN_PASSWORD` la app no arranca.

## Configuración (variables de entorno)

| Variable | Default | Para qué |
|---|---|---|
| `PORT` | `3000` | Puerto del servidor |
| `DATA_DIR` | `./data` | Carpeta donde se guarda la base local `turnero.db` |
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | — | Si están, usa la base en la nube de Turso en lugar del archivo local |
| `ADMIN_USER` / `ADMIN_PASSWORD` | `admin` / al azar | Admin inicial (solo se usan si todavía no hay ninguno) |
| `APP_TZ` | `America/Argentina/Buenos_Aires` | Zona horaria para saber qué turnos ya pasaron |
| `NODE_ENV` | — | En `production` la cookie de sesión se marca `Secure` (requiere HTTPS) |

## Publicarla gratis (Render + Turso)

Render corre la app gratis, pero su disco se borra en cada reinicio, así que los datos van en Turso (SQLite en la nube, plan gratuito).

1. **Turso**: entrá a https://turso.tech, registrate con GitHub y creá una base (por ejemplo `turnero`). En la base, copiá la **URL** (`libsql://...`) y generá un **token**.
2. **Render**: entrá a https://render.com, registrate con GitHub y elegí **New → Blueprint**. Seleccioná este repositorio (Render lee `render.yaml`) y completá:
   - `TURSO_DATABASE_URL`: la URL de Turso
   - `TURSO_AUTH_TOKEN`: el token de Turso
   - `ADMIN_PASSWORD`: la clave del admin (se usa solo la primera vez)
3. Al terminar, Render te da una dirección tipo `https://turnero-balance-center.onrender.com`. Cada `git push` a `main` la actualiza sola.

En el plan gratuito la app "se duerme" después de 15 minutos sin uso, y la primera visita después de eso tarda unos 30 a 60 segundos en cargar.

## Estructura

- `server.js`: API (Express) y sesiones.
- `db.js`: base de datos (libSQL: archivo local o Turso) y claves (scrypt).
- `schedule.js`: horarios, clases con su cupo (`CLASSES`), grilla semanal (`WEEKLY`) y zona horaria. Para cambiar la grilla o un cupo se edita solo este archivo.
- `public/`: páginas para alumnos (`index.html`, `app.js`), profesores (`profe.html`, `profe.js`) y panel admin (`admin.html`, `admin.js`).
