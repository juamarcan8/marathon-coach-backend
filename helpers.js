

 function parseIsoDateToUTC(iso) {
  const [y,m,d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m-1, d));
}

// dayMap: usamos lunes=0 .. domingo=6 para facilitar offset
 const DAY_INDEX = { 'Lunes': 0, 'Martes': 1, 'Miércoles': 2, 'Jueves': 3, 'Viernes': 4, 'Sábado': 5, 'Domingo': 6 };


 function getWorkoutDate(startRaceIso, weeksTotal, week, dayName) {
  // parse race
  const race = parseIsoDateToUTC(startRaceIso); // UTC midnight de la carrera
  // calcula comienzo de semana1 (sin alinear a lunes específicamente)
  const week1Start = new Date(race);
  week1Start.setUTCDate(week1Start.getUTCDate() - ((weeksTotal - 1) * 7));
  // offset en días desde week1Start:
  const dayOffset = (week - 1) * 7 + (DAY_INDEX[dayName] ?? 0);
  const dt = new Date(week1Start);
  dt.setUTCDate(dt.getUTCDate() + dayOffset);
  // devolver ISO YYYY-MM-DD
  return dt.toISOString().slice(0,10);
}

module.exports = { parseIsoDateToUTC, DAY_INDEX, getWorkoutDate };
