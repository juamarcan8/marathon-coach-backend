CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  last_login TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS training_plans (
  id SERIAL PRIMARY KEY,
  user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  plan_data JSONB,
  race_date DATE,
  weeks INTEGER,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS plan_workouts (
  id SERIAL PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES training_plans(id) ON DELETE CASCADE,
  week INTEGER NOT NULL,
  day_name TEXT NOT NULL,
  date DATE NOT NULL,
  sort_index INTEGER DEFAULT 0,
  type TEXT NOT NULL,
  distance_km DOUBLE PRECISION,
  pace_text TEXT,
  description JSONB,     -- si guardas objetos/strings complejos, JSONB es ideal
  advice JSONB,
  segments JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_pw_planid_date ON plan_workouts(plan_id, date, sort_index);
CREATE INDEX IF NOT EXISTS idx_pw_date ON plan_workouts(date);
CREATE INDEX IF NOT EXISTS idx_pw_completed ON plan_workouts(completed_at);
