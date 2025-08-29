// index.js
require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const { getWorkoutDate } = require('./helpers');

const app = express();
const PORT = process.env.PORT || 4000;
const SECRET_KEY = process.env.SECRET_KEY || 'clave_secreta_super_segura';



// Middlewares básicos
app.use(cors());
app.use(express.json());

// Rate limiter para rutas /api
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  max: 20, // ajustar según necesidad
});
app.use('/api/', limiter);

// Inicializar SQLite
const db = new sqlite3.Database('./db.sqlite', (err) => {
  if (err) console.error('Error abriendo BD:', err);
  else console.log('Base de datos SQLite lista.');
});
db.serialize(() => {
  // Crear tabla users
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      email TEXT UNIQUE,
      password TEXT,
      created_at TEXT,
      last_login TEXT
    )
  `);

  // Comprobar si existe un usuario, si no, crearlo
  db.get(`SELECT COUNT(*) AS count FROM users`, (err, row) => {
    if (err) {
      console.error('Error comprobando usuarios:', err);
      return;
    }

    if (row.count === 0) {
      const createdAt = new Date().toISOString();
      const hashedPassword = bcrypt.hashSync('admin123', 10);
      db.run(
        `INSERT INTO users (username, email, password, created_at, last_login) VALUES (?, ?, ?, ?, ?)`,
        ['admin', 'admin@example.com', hashedPassword, createdAt, createdAt],
        (err) => {
          if (err) {
            console.error('Error insertando usuario por defecto:', err);
          } else {
            console.log('Usuario por defecto creado: admin / admin@example.com');
          }
        }
      );
    }
  });

  // Crear tabla training_plans
  db.run(`
    CREATE TABLE IF NOT EXISTS training_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER UNIQUE,
      plan_data TEXT,
      race_date TEXT,
      weeks TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // Crear tabla plan_workouts
  db.run(`
    CREATE TABLE IF NOT EXISTS plan_workouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL,
      week INTEGER NOT NULL,
      day_name TEXT NOT NULL,
      date TEXT NOT NULL,            -- YYYY-MM-DD
      sort_index INTEGER DEFAULT 0,  -- para ordenar si hay varios entrenos por día
      type TEXT NOT NULL,            -- tipo de entreno (Easy run, Long run, etc.)
      distance_km REAL,              -- distancia en km
      pace_text TEXT,                 -- ritmo (ej. "7:00")
      description TEXT,               -- descripción detallada del entreno
      advice TEXT,                    -- consejos adicionales
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(plan_id) REFERENCES training_plans(id)
    )
  `);
});

// ----------------------
// Helpers: tiempo / fechas / parseo JSON
// ----------------------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseTimeToMinutes(input) {
  if (!input) return null;
  const s = input.trim();
  if (!s) return null;
  const parts = s.split(':').map(p => p.trim()).filter(Boolean);
  if (parts.length === 3) {
    const h = Number(parts[0]), m = Number(parts[1]), sec = Number(parts[2]);
    if ([h,m,sec].some(v => !Number.isFinite(v) || v < 0)) return null;
    return h * 60 + m + sec / 60;
  }
  if (parts.length === 2) {
    const a = Number(parts[0]), b = Number(parts[1]);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < 0) return null;
    if (a >= 3) return a + b / 60; // MM:SS
    return a * 60 + b; // H:MM
  }
  const n = Number(parts[0]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function computeDaysAndWeeksFromDate(dateString) {
  if (!dateString) return null;
  const [y, m, d] = dateString.split('-').map(Number);
  if (!y || !m || !d) return null;
  const race = new Date(Date.UTC(y, m - 1, d));
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const msPerDay = 24 * 60 * 60 * 1000;
  const diffMs = race.getTime() - today.getTime();
  const days = Math.ceil(diffMs / msPerDay);
  const weeks = Math.max(0, Math.ceil(days / 7));
  return { days, weeks };
}

function extractJsonFromText(text) {
  try { return JSON.parse(text); } catch (e) {}
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch (e) {}
  }
  return null;
}

const DAY_INDEX = { 'Lunes':1,'Martes':2,'Miércoles':3,'Jueves':4,'Viernes':5,'Sábado':6,'Domingo':0 };

function addDays(date, days) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function assignDatesToPlan(plan, race_date_str, weeks) {
  if (!plan || !plan.plan || !race_date_str) return plan;
  const [y,m,d] = race_date_str.split('-').map(Number);
  const race = new Date(Date.UTC(y, m - 1, d));
  const week1Start = addDays(race, -((weeks - 1) * 7));

  plan.plan.forEach(weekObj => {
    const weekIdx = weekObj.week; // 1-based
    const base = addDays(week1Start, (weekIdx - 1) * 7);
    // Calculamos lunes de la semana base
    const baseWeekMonday = addDays(base, (1 - base.getUTCDay() + 7) % 7);
    weekObj.workouts.forEach(w => {
      const dayName = w.day;
      const targetIndex = DAY_INDEX[dayName];
      if (typeof targetIndex === 'number') {
        const daysOffset = (targetIndex - 1 + 7) % 7; // offset desde lunes
        const workoutDate = addDays(baseWeekMonday, daysOffset);
        w.date = workoutDate.toISOString().slice(0,10);
      } else {
        w.date = null;
      }
    });
  });

  return plan;
}

// ----------------------
// callOpenAI: wrapper con reintentos
// ----------------------
async function callOpenAI(payload = {}, opts = {}) {
  const {
    maxRetries = 5,
    initialBackoffSec = 1,
    maxBackoffSec = 60,
    model = 'gpt-3.5-turbo'
  } = opts;

  if (!process.env.OPENAI_API_KEY) {
    const e = new Error('OPENAI_API_KEY no definida en process.env');
    e.meta = { code: 'NO_API_KEY' };
    throw e;
  }

  const instance = axios.create({
    baseURL: 'https://api.openai.com/v1',
    timeout: 120000,
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    }
  });

  const body = { model, ...payload };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await instance.post('/chat/completions', body);
      console.log('OpenAI OK', { status: res.status, requestId: res.headers['x-request-id'] || null });
      return res.data;
    } catch (err) {
      const status = err.response?.status;
      const headers = err.response?.headers || {};
      const requestId = headers['x-request-id'] || 'no-request-id';
      console.warn(`OpenAI ERROR status=${status} attempt=${attempt} requestId=${requestId}`);

      if (![429, 502, 503, 504].includes(status)) {
        err.meta = { requestId, headers };
        throw err;
      }

      if (attempt === maxRetries) {
        err.meta = { requestId, headers };
        throw err;
      }

      let delaySec = headers['retry-after'] ? Number(headers['retry-after']) : null;
      if (!delaySec || Number.isNaN(delaySec)) {
        const expo = Math.min(maxBackoffSec, initialBackoffSec * 2 ** attempt);
        const jitter = Math.random() * expo * 0.3;
        delaySec = expo + jitter;
      }

      console.log(`Retry in ${Math.round(delaySec)}s (requestId=${requestId})`);
      await sleep(Math.round(delaySec * 1000));
    }
  }
}
  // helpers para hacer rollback y responder
function rollbackAndRespond(errMsg, errObj) {
  db.run('ROLLBACK', (rbErr) => {
    if (rbErr) console.error('ROLLBACK error:', rbErr);
    console.warn(errMsg, errObj || '');
    // no interrumpir la respuesta principal al cliente que generó el plan, solo logueamos
  });
}

//FUNCION PARA INSERTAR EN BD
function insertDB(userId,payload,createdAt,planJson, planWithDates) {
 db.serialize(() => {
    // 1) comenzar transacción
    db.run('BEGIN TRANSACTION', (beginErr) => {
      if (beginErr) {
        console.error('BEGIN TRANSACTION failed', beginErr);
        // no devolvemos aquí porque el plan ya se devuelve más abajo; solo log
        return;
      }

        // 3) insertar nuevo plan
        const insertPlanSql = `INSERT INTO training_plans (user_id, race_date, weeks, plan_data, created_at)
                               VALUES (?, ?, ?, ?, ?)`;
        db.run(insertPlanSql, [userId, payload.race_date, payload.weeks_until_race, planJson, createdAt], function (planErr) {
          if (planErr) {
            rollbackAndRespond('Error insertando training_plans', planErr);
            return;
          }

          const planId = this.lastID;
          // 4) preparar statement para insertar workouts
          const insertWorkoutSql = `INSERT INTO plan_workouts
            (plan_id, week, day_name, date, sort_index, type, distance_km, pace_text, description, advice, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

          const stmt = db.prepare(insertWorkoutSql, (prepErr) => {
            if (prepErr) {
              rollbackAndRespond('Error preparando statement workouts', prepErr);
              return;
            }

            try {
              // recorremos planWithDates.plan (semanas)
              const weeksArr = planWithDates.plan || [];
              weeksArr.forEach((weekObj) => {
                const weekNum = Number(weekObj.week) || 0;
                (weekObj.workouts || []).forEach((w, idx) => {
                  // preferimos la fecha ya calculada en planWithDates; si no existe, usar null
                  const workoutDate = w.date || null;
                  const dayName = w.day || null;
                  const type = w.type || null;
                  const distance = (typeof w.distance_km !== 'undefined' && w.distance_km !== null) ? Number(w.distance_km) : null;
                  const paceText = w.pace_min_km || w.pace_text || null;
                  const description = w.description || w.notes || null;
                  const advice = w.advice || null;
                  const createdAtWorkout = new Date().toISOString();

                  // ejecutar insert
                  stmt.run([planId, weekNum, dayName, workoutDate, idx, type, distance, paceText, description, advice, createdAtWorkout], (runErr) => {
                    if (runErr) {
                      // si falla cualquier insert -> rollback
                      console.error('Error insert workout', runErr);
                      // finalize stmt then rollback
                      try { stmt.finalize(); } catch (e) { /* ignore */ }
                      rollbackAndRespond('Error insertando workout', runErr);
                      return;
                    }
                    // cada insert ok; seguimos
                  });
                });
              });
            } catch (iterErr) {
              // error iterando
              try { stmt.finalize(); } catch (e) { /* ignore */ }
              rollbackAndRespond('Error iterando workouts', iterErr);
              return;
            }

            // finalizamos statement y commit
            stmt.finalize((finalizeErr) => {
              if (finalizeErr) {
                rollbackAndRespond('Error finalizando statement', finalizeErr);
                return;
              }
              // commit de la transacción
              db.run('COMMIT', (commitErr) => {
                if (commitErr) {
                  console.error('COMMIT failed', commitErr);
                  db.run('ROLLBACK', () => { /* nada */ });
                  return;
                }
                console.log('Plan guardado OK, planId=', planId);
                // No interrumpimos la respuesta ya enviada al cliente; si quieres devolver planId, reemplaza la respuesta anterior
              });
           // stmt.finalize
          }); // prepare
        }); // run insertPlan
      }); // run update archive
    }); // BEGIN
  }); // serialize
};

// ----------------------
// Prompt builder (puedes ajustar texto)
// ----------------------
function buildPrompt(payload) {
  const {
    race_type, level, days_per_week, race_date, weeks_until_race,
    preferred_longrun_day, target_time_minutes, recent_5k_minutes
  } = payload;

  return `
Eres un entrenador experto en running. Devuelve SOLO JSON válido, sin texto fuera del objeto JSON.
Genera un plan para una preparación de ${weeks_until_race} semanas para ${race_type}, adaptado al nivel "${level}" y con exactamente ${days_per_week} entrenamientos por semana.

**Formato estricto (ejemplo, responde exactamente con este esquema JSON):**
{
  "plan": [
    {
      "week": 1,
      "workouts": [
        {
          "day": "Lunes",
          "type": "Easy run",
          "distance_km": 6,
          "pace_min_km": "6:00",
          "description": "Qué hacer exactamente antes/durante/después",
          "advice": "Consejos prácticos para este entrenamiento"
        },
        { "...": "repetir hasta tener ${days_per_week} objetos" }
      ]
    },
    { "week": 2, "workouts": [ ... ] },
    ...
  ],
  "summary": "...",
  "descripcion": "...",
  "consejos_generales": "..."
}

Reglas importantes:
1. **Genera EXACTAMENTE ${weeks_until_race} objetos en "plan"** (uno por semana).
2. **Cada semana debe contener exactamente ${days_per_week} objetos en "workouts"** (no menos ni más).
3. Los días (campo "day") deben usar nombres en español: Lunes, Martes, Miércoles, Jueves, Viernes, Sábado, Domingo.
4. Coloca el "Long run" preferentemente en "${preferred_longrun_day || 'el día más largo disponible'}" si se especificó; si no, colócalo el fin de semana.
5. Cada workout **debe** incluir campos: day, type, distance_km (número), pace_min_km (string), description (string), advice (string).
6. No añadas texto fuera del objeto JSON. Empieza la respuesta **solo** con el JSON.

Datos del corredor:
- Tipo carrera: ${race_type}
- Nivel: ${level}
- Días por semana: ${days_per_week}
- Fecha de la carrera: ${race_date}
- Semanas hasta la carrera: ${weeks_until_race}
- Día preferido para long run: ${preferred_longrun_day || 'no especificado'}
- Tiempo objetivo (minutos): ${target_time_minutes ?? 'no especificado'}
- Mejor 5k (minutos): ${recent_5k_minutes ?? 'no especificado'}
`;
}


// ----------------------
// Endpoints: registro/login
// ----------------------
app.post('/register', (req, res) => {
  const { username, password, confirmPassword, email } = req.body;
  const date = new Date().toISOString();

  if (!username || !password || !email || !confirmPassword)
    return res.status(400).json({ error: 'Todos los campos son requeridos' });

  if (password !== confirmPassword)
    return res.status(400).json({ error: 'Las contraseñas no coinciden' });

  if (!/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/.test(password)) {
    return res.status(400).json({
      error: 'La contraseña debe tener al menos 8 caracteres, una mayúscula, una minúscula y un número.'
    });
  }

  const hashedPassword = bcrypt.hashSync(password, 10);

  const stmt = db.prepare('INSERT INTO users (username, email, password, created_at) VALUES (?, ?, ?, ?)');
  stmt.run([username, email, hashedPassword, date], function (err) {
    if (err) {
      if (err.message.includes('UNIQUE')) {
        return res.status(400).json({ error: 'Usuario o email ya existe' });
      }
      return res.status(500).json({ error: 'Error registrando usuario' });
    }
    res.json({ message: 'Registro exitoso', userId: this.lastID });
  });
  stmt.finalize();
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password)
    return res.status(400).json({ error: 'Usuario y contraseña requeridos' });

  db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
    if (err) return res.status(500).json({ error: 'Error en la base de datos' });
    if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });

    const validPass = bcrypt.compareSync(password, user.password);
    if (!validPass) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }

    const token = jwt.sign({ id: user.id, username: user.username }, SECRET_KEY, { expiresIn: '1h' });
    const lastLogin = new Date().toISOString();
    db.run('UPDATE users SET last_login = ? WHERE id = ?', [lastLogin, user.id], (uErr) => {
      if (uErr) console.warn('Error actualizando last_login', uErr);
    });

    res.json({ message: 'Login correcto', token, username: user.username, userId: user.id });
  });
});

// ----------------------
// Endpoint para generar plan con OpenAI
// ----------------------
app.post('/api/generate-plan', async (req, res) => {
  const payload = req.body;

  // validaciones mínimas en servidor (no confiar en cliente)
  if (!payload.level || !payload.race_type || !payload.days_per_week || !payload.race_date) {
    return res.status(400).json({ error: 'level, race_type, days_per_week y race_date son obligatorios' });
  }

  const info_days = computeDaysAndWeeksFromDate(payload.race_date);
  if (!info_days || info_days.days <= 0) return res.status(400).json({ error: 'race_date es inválida o está en el pasado' });
  if(info_days.weeks >26) return res.status(400).json({error: 'No de puede hacer un plan de más de 26 semanas'});
  payload.weeks_until_race = info_days.weeks;

  // Normalizar tiempos si vienen como strings (opcional)
  if (payload.target_time) payload.target_time_minutes = parseTimeToMinutes(payload.target_time);
  if (payload.recent_5k) payload.recent_5k_minutes = parseTimeToMinutes(payload.recent_5k);

  const prompt = buildPrompt(payload);

  try {
    // const openaiRaw = await callOpenAI({
    //   messages: [
    //     { role: 'system', content: 'Eres un entrenador experto en running.' },
    //     { role: 'user', content: prompt }
    //   ],
    //   max_tokens: 6000,
    //   temperature: 0.15
    // }, { maxRetries: 5, model: 'gpt-4o-mini' });

    // const text = openaiRaw.choices?.[0]?.message?.content || openaiRaw.choices?.[0]?.text || '';
    // const json = extractJsonFromText(text);
   
    // if (!json) {
    //   console.error('OpenAI returned non-JSON:', text);
    //   return res.status(500).json({ error: 'OpenAI no devolvió JSON parseable', raw: text });
    // }

    // const planWithDates = assignDatesToPlan(json, payload.race_date, payload.weeks_until_race);
    
    if (payload.userId) {
        const userId = payload.userId;
        const createdAt = new Date().toISOString();
       //const planJson = JSON.stringify(planWithDates);
        const planJson = {  plan: [
    {
      week: 1,
      workouts: [
        {
          day: 'Lunes',
          type: 'Easy run',
          distance_km: 3,
          pace_min_km: '7:00',
          description: 'Comienza con un calentamiento de 5-10 minutos caminando. Corre a un ritmo cómodo durante 20-30 minutos, luego enfría caminando durante 5-10 minutos.',
          advice: 'Escucha a tu cuerpo y no te exijas demasiado. Mantén una buena hidratación antes y después del entrenamiento.',
          date: '2025-09-01'
        }
      ]
    },
    {
      week: 2,
      workouts: [
        {
          day: 'Lunes',
          type: 'Easy run',
          distance_km: 4,
          pace_min_km: '7:00',
          description: 'Calienta caminando durante 5-10 minutos. Corre a un ritmo cómodo durante 25-35 minutos, luego enfría caminando durante 5-10 minutos.',
          advice: 'Intenta mantener una buena postura al correr y respira profundamente para mantener la energía.',
          date: '2025-09-08'
        }
      ]
    },
  ],
  summary: 'Este plan de entrenamiento de 5 semanas está diseñado para preparar a un corredor principiante para una carrera de 5k, con un enfoque en la progresión gradual y la adaptación al esfuerzo.',
  descripcion: 'El plan incluye una mezcla de carreras fáciles y una simulación de carrera para ayudar a construir resistencia y confianza.',
  consejos_generales: 'Recuerda descansar adecuadamente entre entrenamientos, mantener una buena alimentación y escuchar a tu cuerpo para evitar lesiones.'
};
    const  planWithDates = planJson;
        insertDB(userId,payload,createdAt,planJson,planWithDates);
    }
    return planWithDates;
  } catch (err) {
    console.error('Error in /api/generate-plan:', err);
    // Si OpenAI devolvió info útil
    const requestId = err.meta?.requestId || err.response?.headers?.['x-request-id'] || null;
    const status = err.response?.status || 500;
    // Si es rate limit, devolvemos 429 y opcional Retry-After
    if (status === 429) {
      const retryAfter = err.response?.headers?.['retry-after'] || 60;
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'Rate limit de OpenAI. Intenta más tarde.', retryAfter, requestId });
    }
    return res.status(500).json({ error: 'Error al generar plan', details: err.message, requestId });
  }
});



// ----------------------
// Auth middleware y endpoint protegido de ejemplo
// ----------------------
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.sendStatus(401);

  jwt.verify(token, SECRET_KEY, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

app.get('/home-data', authenticateToken, (req, res) => {
  res.json({ message: `Datos protegidos para ${req.user.username}` });
});

// ----------------------
// Iniciar servidor
// ----------------------
app.listen(PORT, () => {
  console.log(`Servidor backend en http://localhost:${PORT}`);
});
