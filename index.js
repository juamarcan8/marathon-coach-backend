require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 4000;
const SECRET_KEY = process.env.SECRET_KEY || 'clave_secreta_super_segura';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

app.use(cors());
app.use(express.json({ limit: '30mb' }));

const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 20 });
app.use('/api/', apiLimiter);

const db = new sqlite3.Database('./db.sqlite', (err) => {
  if (err) console.error('Error abriendo BD:', err);
  else console.log('Base de datos SQLite lista.');
});

// DB init (minimal comments)
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, email TEXT UNIQUE, password TEXT, created_at TEXT, last_login TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS training_plans (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER UNIQUE, plan_data TEXT, race_date TEXT, weeks TEXT, created_at TEXT DEFAULT (datetime('now')), FOREIGN KEY (user_id) REFERENCES users(id))`);
  db.run(`CREATE TABLE IF NOT EXISTS plan_workouts (id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id INTEGER NOT NULL, week INTEGER NOT NULL, day_name TEXT NOT NULL, date TEXT NOT NULL, sort_index INTEGER DEFAULT 0, type TEXT NOT NULL, distance_km REAL, pace_text TEXT, description TEXT, advice TEXT, created_at TEXT DEFAULT (datetime('now')), completed_at TEXT, FOREIGN KEY(plan_id) REFERENCES training_plans(id))`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_pw_planid_date ON plan_workouts(plan_id, date, sort_index)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_pw_date ON plan_workouts(date)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_pw_completed ON plan_workouts(completed_at)`);

  db.get(`SELECT COUNT(*) AS count FROM users`, (err, row) => {
    if (err) return console.error('Error comprobando usuarios:', err);
    if (!row || row.count === 0) {
      const createdAt = new Date().toISOString();
      const hashedPassword = bcrypt.hashSync('admin123', 10);
      db.run(`INSERT INTO users (username, email, password, created_at, last_login) VALUES (?, ?, ?, ?, ?)`, ['admin', 'admin@example.com', hashedPassword, createdAt, createdAt], (err) => {
        if (err) console.error('Error insertando usuario por defecto:', err); else console.log('Usuario por defecto creado');
      });
    }
  });
});

// helpers
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function safeStringify(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}

function parseTimeToMinutes(input) {
  if (!input) return null;
  const s = input.trim(); if (!s) return null;
  const parts = s.split(':').map(p => p.trim()).filter(Boolean);
  if (parts.length === 3) {
    const h = Number(parts[0]), m = Number(parts[1]), sec = Number(parts[2]);
    if ([h,m,sec].some(v => !Number.isFinite(v) || v < 0)) return null;
    return h * 60 + m + sec / 60;
  }
  if (parts.length === 2) {
    const a = Number(parts[0]), b = Number(parts[1]);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < 0) return null;
    if (a >= 3) return a + b / 60;
    return a * 60 + b;
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
  if (!text || typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch (e) {}
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    const cand = text.slice(first, last + 1);
    try { return JSON.parse(cand); } catch (e) {
      try { fs.appendFileSync('./openai_errors.log', `\n\n==== ${new Date().toISOString()} RAW START ====\n${text.slice(0,5000)}\n==== RAW END ====\n`); } catch (ex) {}
      return null;
    }
  }
  return null;
}

const DAY_INDEX = { 'Lunes':1,'Martes':2,'Miércoles':3,'Jueves':4,'Viernes':5,'Sábado':6,'Domingo':7 };
function addDays(date, days) { const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())); d.setUTCDate(d.getUTCDate() + days); return d; }
function parseDateUTC(s){ const [y,m,d] = (s||'').split('-').map(Number); return new Date(Date.UTC(y,m-1,d)); }
function formatDateUTC(d){ return d.toISOString().slice(0,10); }
function daysBetweenUTC(a,b){ const ms=24*60*60*1000; const ad=Date.UTC(a.getUTCFullYear(),a.getUTCMonth(),a.getUTCDate()); const bd=Date.UTC(b.getUTCFullYear(),b.getUTCMonth(),b.getUTCDate()); return Math.round((ad-bd)/ms); }

function getPlanIdForUser(userId){
  return new Promise((resolve,reject)=>{ db.get('SELECT id FROM training_plans WHERE user_id = ?', [userId], (err,row)=>{ if (err) return reject(err); if (!row) return resolve(null); resolve(row.id); }); });
}

function assignDatesToPlan(plan, race_date_str, weeks, opts={ prunePast:true, shiftIfPast:false }){
  if(!plan || !plan.plan || !race_date_str) return plan;
  const race = parseDateUTC(race_date_str);
  const wks = Number(weeks) || 0;
  const week1Start = addDays(race, -((wks - 1) * 7));
  (plan.plan || []).forEach(weekObj=>{
    const weekIdx = Number(weekObj.week) || 0;
    const base = addDays(week1Start, (weekIdx - 1) * 7);
    const baseDay = base.getUTCDay();
    const daysSinceMonday = (baseDay + 6) % 7;
    const baseWeekMonday = addDays(base, -daysSinceMonday);
    (weekObj.workouts || []).forEach(w=>{
      const targetIndex = DAY_INDEX[w.day];
      if (typeof targetIndex === 'number') {
        const daysOffset = (targetIndex - 1 + 7) % 7;
        const wd = addDays(baseWeekMonday, daysOffset);
        w.date = formatDateUTC(wd);
      } else {
        w.date = null;
      }
    });
  });

  const today = (()=>{ const n=new Date(); return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())); })();
  let earliest = null;
  (plan.plan || []).forEach(weekObj=>{ (weekObj.workouts || []).forEach(w=>{ if(!w.date) return; const d = parseDateUTC(w.date); if(!earliest || d < earliest) earliest = d; }); });

  if(earliest && earliest < today){
    if(opts.shiftIfPast){
      const delta = daysBetweenUTC(today, earliest);
      (plan.plan || []).forEach(weekObj=>{ (weekObj.workouts || []).forEach(w=>{ if(!w.date) return; w.date = formatDateUTC(addDays(parseDateUTC(w.date), delta)); }); });
      return plan;
    } else {
      const keptWeeks = [];
      (plan.plan || []).forEach(weekObj=>{
        const kept = (weekObj.workouts||[]).filter(w=>{ if(!w.date) return false; return parseDateUTC(w.date) >= today; }).map(w => ({ ...w }));
        if(kept.length) keptWeeks.push({ week: 0, workouts: kept });
      });
      for(let i=0;i<keptWeeks.length;i++) keptWeeks[i].week = i+1;
      plan.plan = keptWeeks;
      return plan;
    }
  }
  return plan;
}

async function callOpenAI(payload = {}, opts = {}) {
  const { maxRetries = 4, initialBackoffSec = 1, maxBackoffSec = 30, model = OPENAI_MODEL } = opts;
  if (!OPENAI_API_KEY) { const e = new Error('OPENAI_API_KEY no definida en .env.'); e.meta = { code: 'NO_API_KEY' }; throw e; }
  const instance = axios.create({ baseURL: 'https://api.openai.com/v1', timeout: 180000, headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' } });
  const body = { model, ...payload };
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await instance.post('/chat/completions', body);
      return res.data;
    } catch (err) {
      const status = err.response?.status;
      const headers = err.response?.headers || {};
      const isRetriable = [429, 502, 503, 504].includes(status);
      console.warn(`[callOpenAI] attempt ${attempt} failed status=${status} retriable=${isRetriable}`);
      if (!isRetriable || attempt === maxRetries) { err.meta = { headers }; throw err; }
      let delaySec = headers['retry-after'] ? Number(headers['retry-after']) : null;
      if (!delaySec || Number.isNaN(delaySec)) {
        const expo = Math.min(maxBackoffSec, initialBackoffSec * 2 ** attempt);
        const jitter = Math.random() * expo * 0.3;
        delaySec = expo + jitter;
      }
      await sleep(Math.round(delaySec * 1000));
    }
  }
}

function insertDB(userId, payload, planWithDates) {
  return new Promise((resolve, reject) => {
    const planJsonStr = JSON.stringify(planWithDates);
    db.run('BEGIN TRANSACTION', (beginErr) => {
      if (beginErr) return reject(beginErr);
      const insertPlanSql = `INSERT INTO training_plans (user_id, race_date, weeks, plan_data, created_at) VALUES (?, ?, ?, ?, ?)`;
      const createdAt = new Date().toISOString();
      db.run(insertPlanSql, [userId, payload.race_date, payload.weeks_until_race, planJsonStr, createdAt], function (planErr) {
        if (planErr) { db.run('ROLLBACK', () => reject(planErr)); return; }
        const planId = this.lastID;
        const insertWorkoutSql = `INSERT INTO plan_workouts (plan_id, week, day_name, date, sort_index, type, distance_km, pace_text, description, advice, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        const stmt = db.prepare(insertWorkoutSql, (prepErr) => {
          if (prepErr) { db.run('ROLLBACK', () => reject(prepErr)); return; }
          const weeksArr = planWithDates.plan || [];
          let total = 0, done = 0, errored = false;
          weeksArr.forEach((weekObj) => { const weekNum = Number(weekObj.week) || 0; (weekObj.workouts || []).forEach((w, idx) => {
            total++;
            const workoutDate = w.date || null;
            const dayName = w.day || null;
            const type = w.type || null;
            const distance = (typeof w.distance_km !== 'undefined' && w.distance_km !== null) ? Number(w.distance_km) : null;
            const paceText = w.pace_min_km || w.pace_text || null;
            const description = safeStringify(w.description);
            const advice = safeStringify(w.advice);
            const createdAtWorkout = new Date().toISOString();
            stmt.run([planId, weekNum, dayName, workoutDate, idx, type, distance, paceText, description, advice, createdAtWorkout], (runErr) => {
              if (runErr && !errored) { errored = true; stmt.finalize(() => { db.run('ROLLBACK', () => reject(runErr)); }); return; }
              done++;
              if (done === total && !errored) {
                stmt.finalize((finalizeErr) => {
                  if (finalizeErr) { db.run('ROLLBACK', () => reject(finalizeErr)); return; }
                  db.run('COMMIT', (commitErr) => { if (commitErr) { db.run('ROLLBACK', () => reject(commitErr)); return; } resolve(planId); });
                });
              }
            });
          }); });
          if (total === 0) { stmt.finalize(() => { db.run('COMMIT', (commitErr) => { if (commitErr) { db.run('ROLLBACK', () => reject(commitErr)); return; } resolve(planId); }); }); }
        });
      });
    });
  });
}

// summarize block for progression
function summarizeBlock(blockJson) {
  const weeks = (blockJson && Array.isArray(blockJson.plan)) ? blockJson.plan : [];
  if (!weeks.length) return null;
  const lastWeek = weeks[weeks.length - 1];
  const weekIndex = Number(lastWeek.week) || null;
  let totalKm = 0;
  let longrunKm = 0;
  let hardestType = null;
  let maxIntensityScore = -Infinity;
  const intensityScore = (s) => ({ easy:0, recovery:0, long:0.5, tempo:1, interval:2 }[s] ?? 0);
  weeks.forEach(wk => { (wk.workouts || []).forEach(w => { if (typeof w.distance_km === 'number') totalKm += Number(w.distance_km); const intScore = intensityScore(w.intensity); if (intScore > maxIntensityScore) { maxIntensityScore = intScore; hardestType = w.type || w.intensity; } if ((w.type || '').toLowerCase().includes('long')) { longrunKm = Math.max(longrunKm, Number(w.distance_km) || 0); } }); });
  const avgWeeklyKm = Math.round((totalKm / weeks.length) * 10) / 10;
  return {
    lastWeekIndex: weekIndex,
    lastWeek_total_km: Math.round(totalKm * 10) / 10,
    lastWeek_longrun_km: Math.round(longrunKm * 10) / 10,
    lastWeek_hardest_type: hardestType,
    avg_weekly_km_last_block: avgWeeklyKm
  };
}

function buildBlockPrompt(payload, blockStart, blockLength, blockEnd, fixedDaysArray = null, includeRace = false, previousSummary = null) {
  const { race_type, level, days_per_week, race_date, weeks_until_race, preferred_longrun_day, target_time_minutes, recent_5k_minutes } = payload;
  const fixedDaysMsg = fixedDaysArray && fixedDaysArray.length
    ? `Mantén los mismos días de entrenamiento: ${fixedDaysArray.join(', ')}.`
    : `Elige ${days_per_week} días fijos de la semana y mantenlos idénticos en TODAS las semanas del bloque.`;
  const raceMsg = includeRace
    ? `ATENCIÓN: Este bloque INCLUYE la semana final de la preparación. Incluye la CARRERA en la semana final como el ÚLTIMO entrenamiento de esa semana con la fecha ${race_date}.`
    : `IMPORTANTE: Este bloque NO debe incluir la carrera ni mencionar la fecha de la carrera. No pongas la carrera en este bloque.`;
  const progressionRules = [
    'Reglas de progresión (OBLIGATORIAS):',
    '- No aumentar el km total semanal más de 10% respecto a la última semana conocida.',
    '- No aumentar el Long Run más de 3 km semana a semana (preferible 1-2 km).',
    '- Cada 3ª o 4ª semana debe ser una semana de recuperación (reducción de volumen 15-25%).',
    '- Las últimas 2–3 semanas deben reducir progresivamente el volumen (taper).',
    '- Ajusta ritmos según 5k/objetivo.',
    '- Restricciones Long Run: nunca mayor al 120% de la distancia de carrera objetivo. Para media maratón (21k) y maratón (42k), nunca mayor que la distancia de la carrera.',
    'Variedad de entrenamientos: alterna rodajes suaves, CA-CO (si corresponde al nivel), long runs, intervalos, tempo runs, fartlek y semanas de recuperación activa. Selecciona con criterio seguro y progresivo según nivel y objetivo.',
    'El DÍA DE LA CARRERA: en la descripción del workout incluye una estrategia de carrera basada en el ritmo objetivo: empieza ligeramente más lento, mantén ritmo objetivo en la parte central, y da tu máximo en los últimos km. Añade consejos de hidratación y mentalidad.'
  ].join('\n');
  const prevMsg = previousSummary ? `Contexto previo: última semana index ${previousSummary.lastWeekIndex}, km totales última semana ${previousSummary.lastWeek_total_km} km, long run ${previousSummary.lastWeek_longrun_km} km, tipo más duro: ${previousSummary.lastWeek_hardest_type}. Usa esto para que la progresión sea coherente.` : '';
  return [
    `Eres un entrenador experto en running. Responde SOLO con JSON válido y NADA más.`,
    `Genera un bloque de ${blockLength} semanas: semanas ${blockStart}-${blockEnd} (de ${weeks_until_race} semanas totales).`,
    `Tipo: ${race_type} | Nivel: ${level} | Días/sem: ${days_per_week} | Día long run: ${preferred_longrun_day || 'no especificado'}`,
    `Mejor 5k: ${recent_5k_minutes ?? 'no especificado'} | Tiempo objetivo (min): ${target_time_minutes ?? 'no especificado'}`,
    fixedDaysMsg,
    raceMsg,
    prevMsg,
    progressionRules,
    `Salida: JSON: { "plan":[{ "week":n,"workouts":[...] }, ...], "summary":"", "descripcion":"", "consejos_generales":"" }`,
    `Cada workout: day (es), weekday_index (1=Lunes..7=Domingo), type, distance_km (n), pace_min_km (mm:ss), intensity, description (3-6 frases numeradas), advice. Si hay series incluye segments.`,
    `NO añadas texto fuera del JSON.`
  ].filter(Boolean).join('\n');
}

function validateBlock(blockJson, payload, previousSummary) {
  const errors = [];
  if (!blockJson || !Array.isArray(blockJson.plan)) { errors.push('Block missing plan array'); return errors; }
  const daysPerWeek = Number(payload.days_per_week);
  blockJson.plan.forEach(wk => { if (!wk.workouts || wk.workouts.length !== daysPerWeek) { errors.push(`week ${wk.week} has ${ (wk.workouts||[]).length } workouts but expected ${daysPerWeek}`); } });
  if (previousSummary) {
    const lastTotal = previousSummary.lastWeek_total_km || 0;
    const thisLastWeek = blockJson.plan[blockJson.plan.length-1];
    let thisTotal = 0; (thisLastWeek.workouts || []).forEach(w => { if (typeof w.distance_km === 'number') thisTotal += Number(w.distance_km); });
    if (lastTotal > 0) {
      const pct = ((thisTotal - lastTotal) / lastTotal) * 100;
      if (pct > 12) errors.push(`Increase >12% vs previous (${pct.toFixed(1)}%)`);
    }
  }
  return errors;
}
// main endpoint (blocks + progression)
app.post('/api/generate-plan', async (req, res) => {
  const payload = req.body;
  if (!payload.level || !payload.race_type || !payload.days_per_week || !payload.race_date) {
    return res.status(400).json({ error: 'level, race_type, days_per_week y race_date son obligatorios' });
  }

  const info = computeDaysAndWeeksFromDate(payload.race_date);
  if (!info || info.days <= 0) {
    return res.status(400).json({ error: 'race_date inválida o en el pasado' });
  }
  if (info.weeks > 26) {
    return res.status(400).json({ error: 'No se puede hacer un plan de más de 26 semanas' });
  }

  payload.weeks_until_race = info.weeks;
  if (payload.target_time) payload.target_time_minutes = parseTimeToMinutes(payload.target_time);
  if (payload.recent_5k) payload.recent_5k_minutes = parseTimeToMinutes(payload.recent_5k);

  const BLOCK_SIZE = payload.block_size ? Math.max(1, Number(payload.block_size)) : 4;
  const totalWeeks = payload.weeks_until_race;
  const blocks = [];
  for (let s = 1; s <= totalWeeks; s += BLOCK_SIZE) {
    const length = Math.min(BLOCK_SIZE, totalWeeks - s + 1);
    blocks.push({ start: s, length, end: s + length - 1 });
  }
  console.log('[generate-plan] totalWeeks=', totalWeeks, 'blocks=', blocks);

  const blockResults = [];
  let fixedDaysFromFirstBlock = payload.fixed_days || null;
  let previousSummary = payload.previous_summary || null;

  try {
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const includeRace = (b.end === totalWeeks);
      const prompt = buildBlockPrompt(payload, b.start, b.length, b.end, fixedDaysFromFirstBlock, includeRace, previousSummary);
      console.log(`[generate-plan] Generando bloque ${b.start}-${b.end} includeRace=${includeRace} (prompt chars ${prompt.length})`);

      const openaiRes = await callOpenAI({
        messages: [
          { role: 'system', content: 'Eres un entrenador experto en running.' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 4000,
        temperature: 0.12
      }, { maxRetries: 4, model: OPENAI_MODEL });

      const text = openaiRes.choices?.[0]?.message?.content || openaiRes.choices?.[0]?.text || '';
      if (!text) {
        try { fs.appendFileSync('./openai_errors.log', `\n\n${new Date().toISOString()} EMPTY_RESPONSE BLOCK ${b.start}-${b.end}\n`); } catch (e) {}
        return res.status(500).json({ error: `OpenAI no devolvió texto en bloque ${b.start}-${b.end}` });
      }
      console.log(`[generate-plan] OpenAI block ${b.start}-${b.end} snippet:`, text.slice(0,600));

      const json = extractJsonFromText(text);
      if (!json) {
        try { fs.appendFileSync('./openai_errors.log', `\n\n${new Date().toISOString()} BLOCK ${b.start}-${b.end} RAW:\n${text.slice(0,8000)}\n`); } catch (e) {}
        return res.status(500).json({ error: `OpenAI no devolvió JSON parseable en bloque ${b.start}-${b.end}`, raw: text.slice(0,2000) });
      }

      // validate block
      const vErrors = validateBlock(json, payload, previousSummary);
      if (vErrors.length) {
        console.warn('[generate-plan] validation errors block', b.start, vErrors);
        const correctionPrompt = `Corrige únicamente el JSON anterior (no añadas texto extra) para que cumpla las reglas: ${vErrors.join('; ')} y conserva la estructura original.`;
        try {
          const tryRes = await callOpenAI({
            messages: [
              { role: 'system', content: 'Eres un asistente que corrige JSON sin texto extra.' },
              { role: 'user', content: `${correctionPrompt}\n\nJSON_INICIAL:\n${JSON.stringify(json)}` }
            ],
            max_tokens: 2000,
            temperature: 0.0
          }, { maxRetries: 2, model: OPENAI_MODEL });

          const tryText = tryRes.choices?.[0]?.message?.content || tryRes.choices?.[0]?.text || '';
          const tryJson = extractJsonFromText(tryText);
          if (tryJson) {
            console.log('[generate-plan] correction accepted for block', b.start);
            blockResults.push(tryJson);
            const sum = summarizeBlock(tryJson);
            previousSummary = sum;

            if (!fixedDaysFromFirstBlock) {
              try {
                const daysSet = new Set();
                (tryJson.plan || []).forEach(wk => { (wk.workouts || []).forEach(w => { if (w.day) daysSet.add(w.day); }); });
                const daysArr = Array.from(daysSet);
                if (daysArr.length === Number(payload.days_per_week)) fixedDaysFromFirstBlock = daysArr;
              } catch (e) {}
            }

            await sleep(250);
            continue;
          }
        } catch (e) {
          console.warn('[generate-plan] correction attempt failed', e && e.message ? e.message : e);
        }
        // si la corrección falla: seguimos con el json original (se añadirá más abajo)
      }

      blockResults.push(json);

      if (!fixedDaysFromFirstBlock) {
        try {
          const daysSet = new Set();
          (json.plan || []).forEach(wk => { (wk.workouts || []).forEach(w => { if (w.day) daysSet.add(w.day); }); });
          const daysArr = Array.from(daysSet);
          if (daysArr.length === Number(payload.days_per_week)) {
            fixedDaysFromFirstBlock = daysArr;
            console.log('[generate-plan] Detectados días fijos:', fixedDaysFromFirstBlock);
          }
        } catch (e) {}
      }

      const summary = summarizeBlock(json);
      previousSummary = summary;
      console.log(`[generate-plan] resumen bloque ${b.start}-${b.end}:`, summary);

      await sleep(250);
    }

    // combine blocks
    const finalPlan = { plan: [], summary: '', descripcion: '', consejos_generales: '' };
    blockResults.forEach((blk, idx) => {
      if (Array.isArray(blk.plan)) finalPlan.plan.push(...blk.plan);
      if (idx === 0) {
        finalPlan.summary = blk.summary || '';
        finalPlan.descripcion = blk.descripcion || '';
        finalPlan.consejos_generales = blk.consejos_generales || '';
      }
    });

    const planWithDates = assignDatesToPlan(finalPlan, payload.race_date, payload.weeks_until_race);

    let savedPlanId = null;
    if (payload.userId) {
      try {
        savedPlanId = await insertDB(payload.userId, payload, planWithDates);
        console.log('[generate-plan] plan guardado id=', savedPlanId);
      } catch (dbErr) {
        console.warn('Error guardando plan en BD:', dbErr);
      }
    }

    console.log('[generate-plan] Finalizado, devolviendo plan');
    return res.json({ success: true, data: planWithDates, planId: savedPlanId });

  } catch (err) {
    console.error('[generate-plan] ERROR:', err && err.stack ? err.stack : err);
    const status = err.response?.status || 500;
    if (status === 429) {
      const retryAfter = err.response?.headers?.['retry-after'] || 60;
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'Rate limit de OpenAI. Intenta más tarde.', retryAfter });
    }
    return res.status(500).json({ error: 'Error al generar plan', details: err.message || String(err) });
  }
});

// auth + other endpoints (kept concise)
app.post('/register', (req, res) => {
  const { username, password, confirmPassword, email } = req.body;
  const date = new Date().toISOString();

  if (!username || !password || !email || !confirmPassword) {
    return res.status(400).json({ error: 'Todos los campos son requeridos' });
  }
  if (password !== confirmPassword) {
    return res.status(400).json({ error: 'Las contraseñas no coinciden' });
  }
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
  if (!username || !password) {
    return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
  }

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
app.get('/api/workouts', async (req, res) => {
  try {
    if (!req.headers['authorization']) return res.status(401).json({ error: 'No autorizado' });
    const authHeader = req.headers['authorization'];
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, SECRET_KEY);
    const uid = decoded.id;
    const planId = await getPlanIdForUser(uid);
    if (!planId) return res.status(404).json({ error: 'No se encontró plan para el usuario' });

    console.log('[api/workouts] fetching workouts for planId=', planId);

    db.all('SELECT * FROM plan_workouts WHERE plan_id = ? ORDER BY date ASC', [planId], (err, rows) => {
      if (err) {
        console.error('[api/workouts] db.all ERROR:', err);
        return res.status(500).json({ error: 'Error en la base de datos', details: err.message });
      }

      console.log('[api/workouts] rows returned:', (rows || []).length);

      const tryParse = (s) => {
        if (s == null) return s;
        if (typeof s !== 'string') return s;
        try { return JSON.parse(s); } catch (e) { return s; }
      };

      const parsed = (rows || []).map(r => {
        return {
          ...r,
          description: tryParse(r.description),
          advice: tryParse(r.advice),
          segments: tryParse(r.segments)
        };
      });

      return res.json({ workouts: parsed });
    });
  } catch (err) {
    console.error('[api/workouts] auth/error:', err && err.stack ? err.stack : err);
    return res.status(401).json({ error: 'No autorizado' });
  }
});

app.get('/api/next-workout', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    if (!req.headers['authorization']) return res.status(401).json({ error: 'No autorizado' });
    const authHeader = req.headers['authorization'];
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, SECRET_KEY);
    const userId = decoded.id;
    const planId = await getPlanIdForUser(userId);
    if (!planId) return res.status(404).json({ error: 'No se encontró plan para el usuario' });

    db.get(
      'SELECT * FROM plan_workouts WHERE plan_id = ? AND date >= ? ORDER BY date ASC LIMIT 1',
      [planId, today],
      (err, next_workout) => {
        if (err) return res.status(500).json({ error: 'Error en la base de datos' });
        if (!next_workout) return res.status(404).json({ error: 'No se encontró próximo entrenamiento' });
        return res.json(next_workout);
      }
    );
  } catch (err) {
    return res.status(401).json({ error: 'No autorizado' });
  }
});

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

process.on('unhandledRejection', (reason, p) => {
  console.error('Unhandled Rejection at:', p, 'reason:', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err && err.stack ? err.stack : err);
});

app.listen(PORT, () => {
  console.log(`Servidor backend en http://localhost:${PORT}`);
});
