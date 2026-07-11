const { randomInt } = require("crypto");

function chooseRandomCypher(count, pick = randomInt) {
  if (!Number.isInteger(count) || count < 1 || count > 256) {
    throw new RangeError("cypher count must be an integer between 1 and 256");
  }
  return pick(count);
}

module.exports = { chooseRandomCypher };
