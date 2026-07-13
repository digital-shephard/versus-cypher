/**
 * Full Gnosis Safe / Safe{Wallet} configuration inspection for the immutable protocol recipient.
 */
const { Contract, getAddress } = require("ethers");
const CONSTANTS = require("./constants");

const SAFE_ABI = [
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)",
];

const SENTINEL_MODULES = "0x0000000000000000000000000000000000000001";
const GUARD_STORAGE_SLOT = "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8";
const FALLBACK_HANDLER_STORAGE_SLOT =
  "0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5";

function addressFromStorageWord(word) {
  if (!word || word === "0x" || /^0x0+$/.test(word)) return null;
  return getAddress(`0x${word.slice(-40)}`);
}

async function readSafeSingleton(provider, safeAddress) {
  const word = await provider.getStorage(safeAddress, 0);
  const singleton = addressFromStorageWord(word);
  if (!singleton) throw new Error("Safe proxy singleton slot is empty");
  return singleton;
}

async function readSafeAddressSlot(provider, safeAddress, slot) {
  const word = await provider.getStorage(safeAddress, slot);
  return addressFromStorageWord(word);
}

async function inspectSafeConfiguration(
  provider,
  safeAddress,
  { expectedSingleton, expectedFallbackHandler } = {}
) {
  const recipient = getAddress(safeAddress);
  const expected = getAddress(expectedSingleton || CONSTANTS.base.safeSingleton);
  const expectedHandler = getAddress(expectedFallbackHandler || CONSTANTS.base.safeFallbackHandler);
  const safe = new Contract(recipient, SAFE_ABI, provider);

  const [owners, threshold, modulesPage, singleton, guard, fallbackHandler] = await Promise.all([
    safe.getOwners(),
    safe.getThreshold(),
    safe.getModulesPaginated(SENTINEL_MODULES, 10),
    readSafeSingleton(provider, recipient),
    readSafeAddressSlot(provider, recipient, GUARD_STORAGE_SLOT),
    readSafeAddressSlot(provider, recipient, FALLBACK_HANDLER_STORAGE_SLOT),
  ]);

  const modules = (modulesPage?.array || []).map(getAddress);
  const errors = [];
  if (singleton !== expected) {
    errors.push(`Safe singleton mismatch: expected ${expected}, received ${singleton}`);
  }
  if (modules.length !== 0) {
    errors.push(`Safe must have zero enabled modules; found ${modules.join(",")}`);
  }
  if (guard) errors.push(`Safe guard must be zero; found ${guard}`);
  if (fallbackHandler !== expectedHandler) {
    errors.push(`Safe fallback handler mismatch: expected ${expectedHandler}, received ${fallbackHandler || "zero"}`);
  }

  if (errors.length) {
    throw new Error(errors.join("; "));
  }

  return {
    address: recipient,
    singleton,
    owners: owners.map(getAddress),
    threshold: Number(threshold),
    modules,
    guard: guard || null,
    fallbackHandler: fallbackHandler || null,
  };
}

module.exports = {
  SENTINEL_MODULES,
  GUARD_STORAGE_SLOT,
  FALLBACK_HANDLER_STORAGE_SLOT,
  inspectSafeConfiguration,
  readSafeSingleton,
};
