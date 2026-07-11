const PENNY_MICROS = 10_000;
const MAX_RAIN_PENNIES = 100;

function normalizeRainPennies(value) {
  const pennies = Number(value);
  if (!Number.isSafeInteger(pennies) || pennies < 1 || pennies > MAX_RAIN_PENNIES) {
    throw new RangeError(`rain batch must contain 1-${MAX_RAIN_PENNIES} pennies`);
  }
  return pennies;
}

function applyConfirmedRain(state, value, now = Date.now()) {
  const pennies = normalizeRainPennies(value);
  const amount = pennies * PENNY_MICROS;
  const runway = Number(state.runway || 0);
  if (runway < amount) throw new RangeError("insufficient Cypher runway");

  const day = Math.floor(now / 86_400_000);
  if (Number(state.todayRainDay) !== day) state.rainPenniesToday = 0;

  state.runway = runway - amount;
  state.tickets = Number(state.tickets || 0) + pennies;
  state.totalTickets = Number(state.totalTickets || 0) + pennies;
  state.rainPenniesToday = Number(state.rainPenniesToday || 0) + pennies;
  state.todayRainDay = day;
  state.lifetimeRainPennies = Number(state.lifetimeRainPennies || 0) + pennies;
  state.classPotMicros = Number(state.classPotMicros || 0) + amount;
  state.inCurrentClass = true;
  state.lastRainAt = now;
  state.lastRainPennies = pennies;
  return { state, pennies, amount };
}

module.exports = { PENNY_MICROS, MAX_RAIN_PENNIES, normalizeRainPennies, applyConfirmedRain };
