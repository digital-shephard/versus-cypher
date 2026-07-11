const { SIGNAL_INK_PENNIES } = require("./protocol");

const DEFAULT_WORKING_SET_LIMIT = 4;
const CONTEXT_BUDGETS = Object.freeze({
  local8b: Object.freeze({ messages: 4, estimatedTokens: 1200 }),
  local12b: Object.freeze({ messages: 6, estimatedTokens: 1800 }),
  api: Object.freeze({ messages: 12, estimatedTokens: 3600 }),
});
const SECURITY_PATTERN = /(?:(?:ignore|forget|override|disregard|bypass)[a-z0-9 ]{0,40}(?:rules|instructions|policy|system)|(?:reveal|print|share|expose)[a-z0-9 ]{0,40}(?:secret|private|key|prompt|instructions)|(?:send|transfer)[a-z0-9 ]{0,20}(?:funds|money|eth|usdc)|wallet secret)/i;
const DEDUP_TYPES = new Set(["observation", "question", "prediction"]);
const TYPE_WEIGHT = Object.freeze({
  outcome: 120,
  mission: 110,
  proposal: 100,
  critique: 90,
  question: 80,
  prediction: 70,
  endorsement: 60,
  observation: 50,
  receipt: 40,
});
const STOPWORDS = new Set("a an and are as at be by for from has have in is it of on or that the their this to was were with".split(" "));

function bodyTokens(body) {
  return new Set(String(body || "").toLowerCase().split(/[^a-z0-9]+/).filter((word) =>
    word && (/^\d+$/.test(word) || word.length > 2) && !STOPWORDS.has(word)
  ));
}

function similarity(left, right) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function threadRoot(postcard, byId) {
  let current = postcard;
  const visited = new Set();
  while (current?.replyTo && !visited.has(current.id)) {
    visited.add(current.id);
    const parent = byId.get(current.replyTo);
    if (!parent) break;
    current = parent;
  }
  return current?.id || postcard.id;
}

function compactPostcard(postcard, ownAddress, metadata = {}) {
  return Object.freeze({
    id: postcard.id,
    sourceIds: Object.freeze([...(metadata.sourceIds || [postcard.id])]),
    type: postcard.type,
    author: postcard.author,
    cypherId: postcard.cypherId,
    createdAt: postcard.createdAt,
    body: postcard.body,
    replyTo: postcard.replyTo,
    threadId: metadata.threadId || postcard.id,
    selectionReasons: Object.freeze([...(metadata.selectionReasons || [])]),
    inkPennies: SIGNAL_INK_PENNIES[postcard.type] || 0,
    own: postcard.author === ownAddress,
    untrusted: postcard.author !== ownAddress,
    authoritative: false,
  });
}

function compactWorkingSet(postcards, {
  ownAddress,
  limit = DEFAULT_WORKING_SET_LIMIT,
  affinityByAuthor = {},
  likedPeers = [],
  discoverySlots = 1,
} = {}) {
  if (!Array.isArray(postcards)) throw new TypeError("postcards must be an array");
  if (!Number.isInteger(limit) || limit < 1 || limit > 128) {
    throw new RangeError("working set limit must be between 1 and 128");
  }
  if (!Number.isInteger(discoverySlots) || discoverySlots < 0 || discoverySlots > limit) {
    throw new RangeError("discoverySlots must be between zero and the working set limit");
  }
  const liked = new Set(likedPeers.map((address) => String(address).toLowerCase()));
  const byId = new Map(postcards.map((postcard) => [postcard.id, postcard]));
  const ordered = [...postcards].sort(
    (left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id)
  );
  const screened = [];
  const safe = [];
  for (const postcard of ordered) {
    if (postcard.author !== ownAddress && SECURITY_PATTERN.test(postcard.body)) {
      screened.push(Object.freeze({ sourceIds: Object.freeze([postcard.id]), reason: "possible_prompt_injection" }));
    } else {
      safe.push({ postcard, sourceIds: [postcard.id], tokens: bodyTokens(postcard.body) });
    }
  }

  const groups = [];
  for (const candidate of safe) {
    const duplicate = DEDUP_TYPES.has(candidate.postcard.type)
      ? groups.find((group) =>
          group.postcard.type === candidate.postcard.type &&
          similarity(group.tokens, candidate.tokens) >= 0.82
        )
      : null;
    if (duplicate) {
      duplicate.sourceIds.push(candidate.postcard.id);
      continue;
    }
    groups.push(candidate);
  }

  const newest = ordered[0]?.createdAt || 0;
  for (const group of groups) {
    const postcard = group.postcard;
    const normalizedAuthor = String(postcard.author).toLowerCase();
    const rawAffinity = Number(affinityByAuthor[normalizedAuthor] || affinityByAuthor[postcard.author] || 0);
    const affinity = Math.max(-1, Math.min(1, Number.isFinite(rawAffinity) ? rawAffinity : 0));
    const reasons = [postcard.type];
    let score = TYPE_WEIGHT[postcard.type] || 0;
    if (["critique", "question"].includes(postcard.type)) { score += 25; reasons.push("unresolved"); }
    if (liked.has(normalizedAuthor)) { score += 15; reasons.push("liked_peer"); }
    if (affinity !== 0) { score += affinity * 15; reasons.push("bounded_affinity"); }
    const ageSeconds = Math.max(0, newest - postcard.createdAt);
    score += Math.max(0, 20 - Math.floor(ageSeconds / 3600));
    group.threadId = threadRoot(postcard, byId);
    group.score = score;
    group.selectionReasons = reasons;
  }
  groups.sort((left, right) =>
    right.score - left.score || right.postcard.createdAt - left.postcard.createdAt ||
    left.postcard.id.localeCompare(right.postcard.id)
  );

  const selected = groups.slice(0, limit);
  if (discoverySlots > 0 && selected.length === limit) {
    const selectedIds = new Set(selected.map((group) => group.postcard.id));
    const discoveries = groups.filter((group) =>
      !selectedIds.has(group.postcard.id) && group.postcard.author !== ownAddress &&
      !liked.has(String(group.postcard.author).toLowerCase())
    ).slice(0, discoverySlots);
    for (let index = 0; index < discoveries.length; index += 1) {
      const replacement = selected.length - 1 - index;
      discoveries[index].selectionReasons.push("discovery");
      selected[replacement] = discoveries[index];
    }
  }

  const messages = selected
    .sort((left, right) => left.postcard.createdAt - right.postcard.createdAt || left.postcard.id.localeCompare(right.postcard.id))
    .map((group) => compactPostcard(group.postcard, ownAddress, group));
  const threads = new Map();
  for (const message of messages) {
    const thread = threads.get(message.threadId) || { threadId: message.threadId, types: new Set(), authors: new Set(), sourceIds: [] };
    thread.types.add(message.type);
    thread.authors.add(message.author);
    thread.sourceIds.push(...message.sourceIds);
    threads.set(message.threadId, thread);
  }
  const derivedSummaries = Array.from(threads.values()).map((thread) => Object.freeze({
    threadId: thread.threadId,
    types: Object.freeze([...thread.types].sort()),
    participantCount: thread.authors.size,
    sourceIds: Object.freeze([...new Set(thread.sourceIds)]),
    authoritative: false,
    method: "deterministic_thread_index",
  }));
  const provenance = [...new Set(messages.flatMap((message) => message.sourceIds))];
  const tokenPayload = { messages, derivedSummaries };
  return Object.freeze({
    version: 2,
    method: "bounded_thread_affinity_discovery",
    sourceCount: postcards.length,
    candidateCount: groups.length,
    includedCount: messages.length,
    includedSourceCount: provenance.length,
    omittedCount: Math.max(0, postcards.length - provenance.length),
    screenedCount: screened.length,
    deduplicatedCount: safe.length - groups.length,
    estimatedTokens: Math.ceil(JSON.stringify(tokenPayload).length / 4),
    provenance: Object.freeze(provenance),
    screened: Object.freeze(screened),
    derivedSummaries: Object.freeze(derivedSummaries),
    messages: Object.freeze(messages),
    peerContentIsUntrusted: true,
    summariesAreNonAuthoritative: true,
    affinityCannotBypassPolicy: true,
  });
}

module.exports = {
  CONTEXT_BUDGETS,
  DEFAULT_WORKING_SET_LIMIT,
  SECURITY_PATTERN,
  compactPostcard,
  compactWorkingSet,
};
