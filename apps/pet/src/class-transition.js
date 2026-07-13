const { id } = require("ethers");

const WRONG_CLASS_SELECTOR = id("WrongClass()").slice(0, 10).toLowerCase();

function isWrongClassError(error) {
  const seen = new Set();
  const pending = [error];
  while (pending.length) {
    const value = pending.pop();
    if (!value || (typeof value !== "object" && typeof value !== "string")) continue;
    if (typeof value === "string") {
      if (value.toLowerCase().startsWith(WRONG_CLASS_SELECTOR)) return true;
      continue;
    }
    if (seen.has(value)) continue;
    seen.add(value);
    if (value.errorName === "WrongClass" || value.revert?.name === "WrongClass") return true;
    for (const key of ["data", "error", "info", "revert", "cause"]) {
      if (value[key] != null) pending.push(value[key]);
    }
  }
  return false;
}

function classOverError(staleClassId, currentClassId, cause = null) {
  const stale = BigInt(staleClassId).toString();
  const current = BigInt(currentClassId).toString();
  const error = new Error(`class ${stale} is over; class ${current} is now open`, cause ? { cause } : undefined);
  error.name = "ClassOverError";
  error.code = "CLASS_OVER";
  error.classId = stale;
  error.currentClassId = current;
  return error;
}

module.exports = { WRONG_CLASS_SELECTOR, classOverError, isWrongClassError };
