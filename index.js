// index.js (refactorizado)
require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
// const { getWorkoutDate } = require('./helpers'); // si lo necesitas, importalo desde helpers

const app = express();
const PORT = process.env.PORT || 4000;
const SECRET_KEY = process.env.SECRET_KEY || 'clave_secreta_super_segura';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-3.5-turbo';

// Middlewares
app.use(cors());
app.use(express.json());

// Rate limiter para rutas /api
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 20, // ajustar según necesidad
});
app.use('/api/', apiLimiter);

// Inicializar SQLite
const db = new sqlite3.Database('./db.sqlite', (err) => {
  if (err) console.error('Error abriendo BD:', err);
  else console.log('Base de datos SQLite lista.');
});

// Crear tablas y usuario por defecto (serializado)
db.serialize(() => {
  // users
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

  // training_plans
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

  // plan_workouts
  db.run(`
    CREATE TABLE IF NOT EXISTS plan_workouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL,
      week INTEGER NOT NULL,
      day_name TEXT NOT NULL,
      date TEXT NOT NULL,
      sort_index INTEGER DEFAULT 0,
      type TEXT NOT NULL,
      distance_km REAL,
      pace_text TEXT,
      description TEXT,
      advice TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      FOREIGN KEY(plan_id) REFERENCES training_plans(id)
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_pw_planid_date ON plan_workouts(plan_id, date, sort_index)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_pw_date ON plan_workouts(date)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_pw_completed ON plan_workouts(completed_at)`);

  // crear usuario por defecto si no hay ninguno
  db.get(`SELECT COUNT(*) AS count FROM users`, (err, row) => {
    if (err) {
      console.error('Error comprobando usuarios:', err);
      return;
    }
    if (!row || row.count === 0) {
      const createdAt = new Date().toISOString();
      const hashedPassword = bcrypt.hashSync('admin123', 10); // contraseña por defecto (cifrada)
      db.run(
        `INSERT INTO users (username, email, password, created_at, last_login) VALUES (?, ?, ?, ?, ?)`,
        ['admin', 'admin@example.com', hashedPassword, createdAt, createdAt],
        (err) => {
          if (err) console.error('Error insertando usuario por defecto:', err);
          else console.log('Usuario por defecto creado: admin / admin@example.com (password: admin123)');
        }
      );
    }
  });
});

// ----------------------
// Helpers (fechas / parseo / extracción JSON)
// ----------------------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseTimeToMinutes(input) {
  if (!input) return null;
  const s = input.trim();
  if (!s) return null;
  const parts = s.split(':').map((p) => p.trim()).filter(Boolean);
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
    const weekIdx = weekObj.week;
    const base = addDays(week1Start, (weekIdx - 1) * 7);
    const baseWeekMonday = addDays(base, (1 - base.getUTCDay() + 7) % 7);
    (weekObj.workouts || []).forEach(w => {
      const dayName = w.day;
      const targetIndex = DAY_INDEX[dayName];
      if (typeof targetIndex === 'number') {
        const daysOffset = (targetIndex - 1 + 7) % 7;
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
// callOpenAI (wrapper con reintentos exponenciales y uso de headers Retry-After)
// ----------------------
async function callOpenAI(payload = {}, opts = {}) {
  const {
    maxRetries = 5,
    initialBackoffSec = 1,
    maxBackoffSec = 60,
    model = OPENAI_MODEL
  } = opts;

  if (!OPENAI_API_KEY) {
    const e = new Error('OPENAI_API_KEY no definida en .env — usando plan de ejemplo (mock).');
    e.meta = { code: 'NO_API_KEY' };
    throw e;
  }

  const instance = axios.create({
    baseURL: 'https://api.openai.com/v1',
    timeout: 120000,
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
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

      // errores no reintentables -> relanzar
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

// ----------------------
// insertDB: inserta plan y workouts en transacción y devuelve planId (Promise)
// ----------------------
function insertDB(userId, payload, planWithDates) {
  return new Promise((resolve, reject) => {
    const planJsonStr = JSON.stringify(planWithDates);

    db.run('BEGIN TRANSACTION', (beginErr) => {
      if (beginErr) return reject(beginErr);

      const insertPlanSql = `INSERT INTO training_plans (user_id, race_date, weeks, plan_data, created_at)
                             VALUES (?, ?, ?, ?, ?)`;
      const createdAt = new Date().toISOString();

      db.run(insertPlanSql, [userId, payload.race_date, payload.weeks_until_race, planJsonStr, createdAt], function (planErr) {
        if (planErr) {
          db.run('ROLLBACK', () => reject(planErr));
          return;
        }

        const planId = this.lastID;
        const insertWorkoutSql = `INSERT INTO plan_workouts
          (plan_id, week, day_name, date, sort_index, type, distance_km, pace_text, description, advice, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        const stmt = db.prepare(insertWorkoutSql, (prepErr) => {
          if (prepErr) {
            db.run('ROLLBACK', () => reject(prepErr));
            return;
          }

          const weeksArr = planWithDates.plan || [];
          let total = 0, done = 0, errored = false;

          weeksArr.forEach((weekObj) => {
            const weekNum = Number(weekObj.week) || 0;
            (weekObj.workouts || []).forEach((w, idx) => {
              total++;
              const workoutDate = w.date || null;
              const dayName = w.day || null;
              const type = w.type || null;
              const distance = (typeof w.distance_km !== 'undefined' && w.distance_km !== null) ? Number(w.distance_km) : null;
              const paceText = w.pace_min_km || w.pace_text || null;
              const description = w.description || w.notes || null;
              const advice = w.advice || null;
              const createdAtWorkout = new Date().toISOString();

              stmt.run([planId, weekNum, dayName, workoutDate, idx, type, distance, paceText, description, advice, createdAtWorkout], (runErr) => {
                if (runErr && !errored) {
                  errored = true;
                  stmt.finalize(() => {
                    db.run('ROLLBACK', () => reject(runErr));
                  });
                  return;
                }
                done++;
                if (done === total && !errored) {
                  stmt.finalize((finalizeErr) => {
                    if (finalizeErr) {
                      db.run('ROLLBACK', () => reject(finalizeErr));
                      return;
                    }
                    db.run('COMMIT', (commitErr) => {
                      if (commitErr) {
                        db.run('ROLLBACK', () => reject(commitErr));
                        return;
                      }
                      resolve(planId);
                    });
                  });
                }
              });
            });
          });

          // caso sin workouts -> commit vacío
          if (total === 0) {
            stmt.finalize(() => {
              db.run('COMMIT', (commitErr) => {
                if (commitErr) { db.run('ROLLBACK', () => reject(commitErr)); return; }
                resolve(planId);
              });
            });
          }
        }); // prepare
      }); // run insert plan
    }); // begin
  }); // promise
}

// ----------------------
// Prompt builder (ajusta según necesites)
// ----------------------
function buildPrompt(payload) {
  const {
    race_type, level, days_per_week, race_date, weeks_until_race,
    preferred_longrun_day, target_time_minutes, recent_5k_minutes
  } = payload;

  return `
Eres un entrenador experto en running. Devuelve SOLO JSON válido y parseable, sin texto adicional.
Genera un plan para ${weeks_until_race} semanas para ${race_type}, nivel ${level}, con exactamente ${days_per_week} entrenos/semana.
Salida JSON: { "plan":[{ "week":1, "workouts":[ ... ] }], "summary":"", "descripcion":"", "consejos_generales":"" }
Reglas importantes:
1) Genera exactamente ${weeks_until_race} semanas.
2) Cada semana debe contener exactamente ${days_per_week} objetos "workouts".
3) Usa días en español (Lunes...Domingo).
4) Cada workout debe incluir: day, type, distance_km (número), pace_min_km (string), description, advice.
5) Tienes que ser especifico en las descripciones de los entrenamientos, diciendo cuanto debe correr, un ritmo aproximado, si son series o similar decir a que ritmo. 
Empieza la respuesta únicamente con el objeto JSON.
Datos del corredor:
- Tipo carrera: ${race_type}
- Nivel: ${level}
- Días por semana: ${days_per_week}
- Fecha de la carrera: ${race_date}
- Día preferido long run: ${preferred_longrun_day || 'no especificado'}
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
    return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres, una mayúscula, una minúscula y un número.' });
  }

  const hashedPassword = bcrypt.hashSync(password, 10);
  const stmt = db.prepare('INSERT INTO users (username, email, password, created_at) VALUES (?, ?, ?, ?)');
  stmt.run([username, email, hashedPassword, date], function (err) {
    if (err) {
      if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Usuario o email ya existe' });
      return res.status(500).json({ error: 'Error registrando usuario' });
    }
    res.json({ message: 'Registro exitoso', userId: this.lastID });
  });
  stmt.finalize();
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Usuario y contraseña requeridos' });

  db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
    if (err) return res.status(500).json({ error: 'Error en la base de datos' });
    if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });

    const validPass = bcrypt.compareSync(password, user.password);
    if (!validPass) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });

    const token = jwt.sign({ id: user.id, username: user.username }, SECRET_KEY, { expiresIn: '1h' });
    const lastLogin = new Date().toISOString();
    db.run('UPDATE users SET last_login = ? WHERE id = ?', [lastLogin, user.id], (uErr) => {
      if (uErr) console.warn('Error actualizando last_login', uErr);
    });

    res.json({ message: 'Login correcto', token, username: user.username, userId: user.id });
  });
});


// ----------------------
// Endpoint para obtener plan del usuario
// ----------------------

app.get('/api/workouts',authenticateToken, (req,res) => {
  const userId = req.user.id;
  db.get('SELECT id from training_plans where id = ?', [userId],
  (err,row) => {
    if(err){
      console.error('DB error fetching plan id:' ,err);
      return res.status(500).json({error: 'Error en la base de datos'})
    }
    if(!row){
      return res.status(404).json({error: 'No se encontró plan para el usuario'})
    }
    const planId = row.id;
    db.all(
      'SELECT * from plan_workouts where plan_id = ?',
      [planId],
      (err,workouts) => {
        if(err){
          console.error('DB error fetching plan id:' ,err);
          return res.status(500).json({error: 'Error en la base de datos'})
        }
        if(!workouts){
          return res.status(404).json({error: 'No se encontró entrenamientos para el usuario'})
        }
        console.log(workouts)
      }
    )
  } 

  );
  return res; 
});
// ----------------------
// Endpoint para obtener el proximo entrenamiento del usuario
// ----------------------

app.get('/api/next-workout',authenticateToken,(req,res) =>{
  const today = new Date().toISOString().split('T')[0];
  const userId = req.user.id;
  db.get('SELECT id from training_plans where id = ?', [userId],
  (err,row) => {
    if(err){
      console.error('DB error fetching plan id:' ,err);
      return res.status(500).json({error: 'Error en la base de datos'})
    }
    if(!row){
      return res.status(404).json({error: 'No se encontró plan para el usuario'})
    }
    const planId = row.id;

    db.get(
      'SELECT * from plan_workouts where plan_id = ? and date >= ? order by date asc limit 1 ',
      [planId,today],
      (err,next_workout) => {
        if(err){
          console.error('DB error fetching plan id:' ,err);
          return res.status(500).json({error: 'Error en la base de datos'})
        }
        if(!next_workout){
          return res.status(404).json({error: 'No se encontró entrenamientos para el usuario'})
        }
        console.log(next_workout)
        return res.json(next_workout);
      }
    );
  })
 
});


// ----------------------
// Endpoint para generar plan con OpenAI (o usar mock si no hay clave)
// ----------------------
app.post('/api/generate-plan', async (req, res) => {
  const payload = req.body;

  // Validaciones mínimas
  if (!payload.level || !payload.race_type || !payload.days_per_week || !payload.race_date) {
    return res.status(400).json({ error: 'level, race_type, days_per_week y race_date son obligatorios' });
  }

  const info_days = computeDaysAndWeeksFromDate(payload.race_date);
  if (!info_days || info_days.days <= 0) return res.status(400).json({ error: 'race_date es inválida o está en el pasado' });
  if (info_days.weeks > 26) return res.status(400).json({ error: 'No se puede hacer un plan de más de 26 semanas' });

  payload.weeks_until_race = info_days.weeks;

  // Normalizar tiempos si vienen como strings (opcional)
  if (payload.target_time) payload.target_time_minutes = parseTimeToMinutes(payload.target_time);
  if (payload.recent_5k) payload.recent_5k_minutes = parseTimeToMinutes(payload.recent_5k);

  const prompt = buildPrompt(payload);

  try {
    let planWithDates;

    // Llamada real a OpenAI
    const openaiRes = await callOpenAI({
      messages: [
        { role: 'system', content: 'Eres un entrenador experto en running.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 4000, // ajustar si necesitas más; cuidado con límites
      temperature: 0.15
    }, { maxRetries: 5, model: OPENAI_MODEL });

    const text = openaiRes.choices?.[0]?.message?.content || openaiRes.choices?.[0]?.text || '';
    const json = extractJsonFromText(text);
    if (!json) {
      console.error('OpenAI returned non-JSON:', text);
      return res.status(500).json({ error: 'OpenAI no devolvió JSON parseable', raw: text });
    }
    planWithDates = assignDatesToPlan(json, payload.race_date, payload.weeks_until_race);
  

    // Si viene userId, guardamos en BD (await insertDB)
    let savedPlanId = null;
    if (payload.userId) {
      try {
        savedPlanId = await insertDB(payload.userId, payload, planWithDates);
      } catch (dbErr) {
        console.warn('Error guardando plan en BD (no abortamos la respuesta al cliente):', dbErr);
        // continue, devolvemos plan aunque no se guardó
      }
    }

    return res.json({ success: true, data: planWithDates, planId: savedPlanId });
  } catch (err) {
    console.error('Error in /api/generate-plan:', err);
    const status = err.response?.status || 500;
    if (status === 429) {
      const retryAfter = err.response?.headers?.['retry-after'] || 60;
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'Rate limit de OpenAI. Intenta más tarde.', retryAfter });
    }
    return res.status(500).json({ error: 'Error al generar plan', details: err.message || String(err) });
  }
});

// ----------------------
// Middleware auth y demo endpoint protegido
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
  res.json({ message: `Datos protegidos para ${req.user.username}`, user: req.user });
});



// ----------------------
// Iniciar servidor
// ----------------------
app.listen(PORT, () => {
  console.log(`Servidor backend en http://localhost:${PORT}`);
});
