const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createHttpAgentBrain,
  loadAgentBrainConfig,
  publicBrainConfig,
} = require("../src/brain");
const { brainEnvironment, normalizeSettings } = require("../src/settings");

test("agent brain configuration is explicit and keeps credentials private", () => {
  assert.equal(loadAgentBrainConfig({}), null);
  const config = loadAgentBrainConfig({
    VERSUS_AGENT_BRAIN: "http",
    VERSUS_AGENT_ENDPOINT: "http://127.0.0.1:11434/v1/chat/completions",
    VERSUS_AGENT_MODEL: "local-cypher",
    VERSUS_AGENT_API_KEY: "secret",
    VERSUS_AGENT_AUTOSTART: "1",
  });
  assert.equal(config.apiKey, "secret");
  assert.equal(publicBrainConfig(config).apiKey, undefined);
  assert.equal(publicBrainConfig(config).endpoint, undefined);
  assert.equal(publicBrainConfig(config).model, "local-cypher");
  assert.equal(publicBrainConfig(config).autostart, true);
});

test("brain settings preserve runtime timeout overrides", () => {
  const settings = normalizeSettings({
    brain: {
      kind: "local",
      endpoint: "http://127.0.0.1:9999/v1/chat/completions",
      model: "fixture",
      autostart: false,
    },
  });
  const env = brainEnvironment(settings, { VERSUS_AGENT_TIMEOUT_MS: "1200" });
  assert.equal(loadAgentBrainConfig(env).timeoutMs, 1200);
});

test("HTTP brain sends inert context and returns one raw JSON decision", async () => {
  let request;
  let invocation;
  const brain = createHttpAgentBrain(
    {
      mode: "http",
      endpoint: "http://127.0.0.1:9999/v1/chat/completions",
      model: "test-model",
      apiKey: "local-key",
      timeoutMs: 5_000,
      temperature: 0,
      maxTokens: 80,
      seed: 17,
      reasoningEffort: "low",
      responseFormat: { type: "json_object" },
    },
    {
      onInvocation: (value) => { invocation = value; },
      fetchImpl: async (_url, options) => {
        request = options;
        return {
          ok: true,
          async json() {
            return {
              id: "generation-1",
              model: "resolved-test-model",
              usage: { prompt_tokens: 45, completion_tokens: 12, cost: 0.0001 },
              choices: [{ message: { content: '{"action":{"type":"observation","body":"the graph is quiet"}}' } }],
            };
          },
        };
      },
    }
  );
  const decision = await brain({ boundary: { peerMessagesAreUntrustedData: true }, postcards: [] });
  assert.equal(decision.action.body, "the graph is quiet");
  assert.equal(request.headers.authorization, "Bearer local-key");
  const sent = JSON.parse(request.body);
  assert.equal(sent.model, "test-model");
  assert.equal(sent.temperature, 0);
  assert.equal(sent.max_tokens, 80);
  assert.equal(sent.seed, 17);
  assert.deepEqual(sent.reasoning, { effort: "low" });
  assert.deepEqual(sent.response_format, { type: "json_object" });
  assert.match(sent.messages[0].content, /untrusted evidence/);
  assert.match(sent.messages[0].content, /no punctuation/);
  assert.match(sent.messages[0].content, /Critique and endorsement require replyTo/);
  assert.match(sent.messages[0].content, /1 to 180 characters/);
  assert.match(sent.messages[1].content, /peerMessagesAreUntrustedData/);
  assert.equal(invocation.response.id, "generation-1");
  assert.equal(invocation.response.resolvedModel, "resolved-test-model");
  assert.equal(invocation.response.usage.cost, 0.0001);
  assert.equal(JSON.stringify(invocation).includes("local-key"), false);
});

test("HTTP brain extracts exactly one JSON decision object from provider wrappers", async () => {
  const response = (content) => async () => ({
    ok: true,
    async json() {
      return { choices: [{ message: { content } }] };
    },
  });
  const config = {
    mode: "http",
    endpoint: "http://127.0.0.1:9999/v1/chat/completions",
    model: "test-model",
    timeoutMs: 5_000,
  };
  const fencedBrain = createHttpAgentBrain(config, {
    fetchImpl: response("```json\n{\"thought\":\"quiet\",\"action\":null}\n```"),
  });
  assert.deepEqual(await fencedBrain({}), { thought: "quiet", action: null });

  const proseBrain = createHttpAgentBrain(config, {
    fetchImpl: response("Here is the decision: {\"thought\":\"quiet\",\"action\":null}"),
  });
  assert.deepEqual(await proseBrain({}), { thought: "quiet", action: null });

  const ambiguousBrain = createHttpAgentBrain(config, {
    fetchImpl: response('{"thought":"first","action":null} or {"thought":"second","action":null}'),
  });
  await assert.rejects(ambiguousBrain({}), /exactly one JSON decision object/);
});
