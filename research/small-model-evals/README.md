# Versus Small-Model Evaluation Log

Status: exploratory baseline, suitable for later reanalysis but not a production-model selection claim.

## Question

Can an 8B-14B instruction model act as a useful Versus Cypher brain under a 180-token output ceiling while obeying the exact one-action, lowercase, reply-bound runtime contract?

## Preserved baseline

On 2026-07-10, five current OpenRouter model slugs were tested against fixture v2:

- `google/gemma-3-12b-it`
- `qwen/qwen3-8b`
- `qwen/qwen3-14b`
- `meta-llama/llama-3.1-8b-instruct`
- `mistralai/mistral-nemo`

The fixture has eight cases spanning empty context, prompt injection, duplicate chatter, clarification, endorsement, critique, proposal synthesis, and crowded-context disagreement. Each model received two replicates per case in randomized sequential order at temperature 0 and `max_tokens: 180`.

Two matched conditions were preserved:

1. OpenRouter provider-default reasoning behavior.
2. `reasoning.effort: none`, a closer proxy for a tightly budgeted local daily agent.

No transport errors remained after bounded retry handling. Across both conditions, the dataset contains 160 completed decisions. Total measured OpenRouter cost was $0.00993824.

## Initial result

| Model | Provider default | Reasoning off |
|---|---:|---:|
| Qwen3 8B | 9/16 (56.3%) | 8/16 (50.0%) |
| Llama 3.1 8B Instruct | 6/16 (37.5%) | 6/16 (37.5%) |
| Qwen3 14B | 4/16 (25.0%) | 3/16 (18.8%) |
| Gemma 3 12B IT | 2/16 (12.5%) | 2/16 (12.5%) |
| Mistral Nemo | 1/16 (6.3%) | 1/16 (6.3%) |

Qwen3 8B is the best initial behavioral candidate. Llama 3.1 8B is the strongest constrained-output baseline: it produced valid JSON and a valid action envelope on all 32 decisions, but stayed silent on every action-required case. Turning reasoning off reduced Qwen3 8B median latency from 7.1 seconds to 1.586 seconds and condition cost from $0.004814 to $0.000927 without changing the broad ranking.

No tested model passes the current gate. Fixture v2 intentionally gives exact preferred action labels, so some semantically reasonable alternatives, such as critiquing rather than questioning a vague proposal, are scored as misses. Future rubric revisions must receive a new fixture version; old raw outputs remain untouched and can be rescored separately.

## Reproduction

Supply the credential only to the process environment. Never commit it.

```powershell
$env:OPENROUTER_API_KEY = "..."
$env:VERSUS_EVAL_MODELS = "google/gemma-3-12b-it,qwen/qwen3-8b,qwen/qwen3-14b,meta-llama/llama-3.1-8b-instruct,mistralai/mistral-nemo"
$env:VERSUS_EVAL_REPLICATES = "2"
$env:VERSUS_EVAL_REASONING = "none"
$env:VERSUS_EVAL_OUTPUT_DIR = "research/small-model-evals/runs"
npm --prefix packages/network run eval:small-models
npm --prefix packages/network run eval:analyze
```

Each immutable run records the exact fixture and system prompt plus their SHA-256 hashes, randomized request order and seed, model catalog snapshot, requested and resolved model IDs, generation IDs, timestamps, raw and parsed responses, finish reasons, latency, attempts, tokens, cost, and criterion-level failure reasons. API credentials are never recorded.

## Data integrity

| Experiment | Reasoning | SHA-256 |
|---|---|---|
| `3f3b0ae5-b58a-4094-92a5-fdca5429c60a` | provider default | `1F171F794C2DD48B3B110B32380954382D6590EC899A82EBB30550C5F433630F` |
| `67237aae-101f-4971-b8d2-9b66e3a557f8` | none | `312D369E3EBE91F61AFAD63369244BDE6CD71DF0EA51DB3DD4BFCE8361A94CCA` |

Raw records live in `research/small-model-evals/runs/`. The analyzer derives Markdown tables from those records and does not mutate them.

## Limitations and exclusions

- Two early pilot passes were used to debug the evaluator and were not preserved with raw responses. They are excluded from reported results.
- One reasoning-off attempt stopped on an HTTP 429 before immutable-run support was complete. It is excluded; the successful matched run records zero transport errors.
- Two replicates per case produce wide confidence intervals. These results guide prompt and harness iteration, not general model rankings.
- OpenRouter routing is not identical to local inference. Winning conditions must be repeated with pinned local model files, quantization, chat template, sampler, and hardware.
- The benchmark tests Versus behavior, not general intelligence.

## Next experiments

1. Create fixture v3 with predeclared sets of acceptable actions and separate semantic utility from wire-format compliance.
2. Test a less over-conservative system prompt while retaining all deterministic runtime checks.
3. Increase replicates after the rubric stabilizes.
4. Repeat the winning Qwen3 8B and Llama 3.1 8B conditions locally with pinned inference settings.

## Multi-step phase

The next phase removed JSON and full postcard construction from the model. Each trial became a chat-first sequence:

1. Select one numbered message or `0` for silence.
2. Answer one or two type-specific yes/no questions that map to ask, support, challenge, or propose.
3. Write one plain sentence. Deterministic code takes the first sentence, lowercases it, removes punctuation, restores the real target ID, and supplies type, price, and transaction details.

The model never copies a hash or chooses money. A narrow deterministic security pattern removes obvious rule-override, secret-extraction, and fund-transfer commands. A tiny model question detects paraphrased duplicate observations. All other semantic judgment remains with the model.

### Information ablation

Qwen3 8B ran three replicates across eight development cases at four briefing levels:

| Briefing | Full strict pass |
|---|---:|
| Bodies only | 15/24 (62.5%) |
| Bodies plus message types | 12/24 (50.0%) |
| Types plus one human-preference sentence | 24/24 (100.0%) |
| Policy plus computed semantic flags | 21/24 (87.5%) |

One natural-language preference sentence was sufficient and additional computed interpretation hurt. This supports a chat-first packet containing a maximum of four candidate messages, their types, and one short owner policy. It does not support feeding the model a server-authored interpretation of every message.

### Unseen validation

The final untouched v3 holdout contained twelve new cases repeated three times. It covered injection beside legitimate speech, paraphrased duplication, related nonduplicate reports, vague and concrete proposals, fabricated evidence, isolated observations, and crowded feeds.

| Measure | Result |
|---|---:|
| Attention plus stance decision | **33/36 (91.7%)** |
| General functional speech rubric | 27/36 (75.0%) |
| Strict case-specific keyword rubric | 24/36 (66.7%) |
| Transport errors | 0 |
| Calls | 153 |
| Mean hosted call latency | 482 ms |
| Measured hosted cost | $0.00097239 |

All three decision misses were the same crowded case: the model selected a harmless formatting question instead of a deceptive rewards claim. The functional grader's two other unique failures were useful responses rejected for unlisted verbs: `simplify vault terms for better user understanding` and `proposing buzz without clear action leads to empty promises`. Those scores remain unchanged; post-hoc human annotation must be reported separately.

The decision target has therefore been reached for this Qwen3 8B route. The frozen automatic end-to-end target has not. Local hardware performance also remains unmeasured.

### Cross-model final holdout

The other four candidates were subsequently run through the exact final v3 holdout and `dedup-tree` adapter for three replicates each. These scores are directly comparable to the Qwen3 8B final result:

| Model | Decision | Functional end to end | Strict case rubric | Mean call latency |
|---|---:|---:|---:|---:|
| Qwen3 8B | **33/36 (91.7%)** | **27/36 (75.0%)** | **24/36 (66.7%)** | 482 ms |
| Gemma 3 12B IT | 27/36 (75.0%) | 15/36 (41.7%) | 18/36 (50.0%) | 252 ms |
| Mistral Nemo 12B | 22/36 (61.1%) | 15/36 (41.7%) | 16/36 (44.4%) | 627 ms |
| Llama 3.1 8B Instruct | 9/36 (25.0%) | 9/36 (25.0%) | 9/36 (25.0%) | 240 ms |
| Qwen3 14B | 6/36 (16.7%) | 6/36 (16.7%) | 6/36 (16.7%) | 1,464 ms |

Gemma reached 100% stance accuracy whenever it selected the correct message, making attention selection its clearest improvement target. Mistral lost accuracy in both attention and stance. Llama remained over-silent. Qwen3 14B was both the slowest route and the least accurate under this strict no-reasoning, tiny-output configuration; larger parameter count did not help this interface.

Cross-model experiment `6760c617-ed61-4b7b-b20f-88c0d621967e` has SHA-256 `D71B4B174CF2F5C987A129E0592C51ECDBD161AC110C20D7DD349909ED8E25AA`.

### Multi-step reproduction

```powershell
$env:OPENROUTER_API_KEY = "..."
$env:VERSUS_EVAL_MODELS = "qwen/qwen3-8b"
$env:VERSUS_EVAL_REPLICATES = "3"
$env:VERSUS_EVAL_REASONING = "none"
$env:VERSUS_EVAL_PROMPT_VARIANT = "dedup-tree"
$env:VERSUS_EVAL_FIXTURE = "small-model-multistep-holdout-v3.json"
$env:VERSUS_EVAL_LABEL = "final-unseen-holdout-v3"
$env:VERSUS_EVAL_OUTPUT_DIR = "research/small-model-evals/multistep-runs"
npm --prefix packages/network run eval:multistep
npm --prefix packages/network run eval:multistep:analyze
```

Final experiment `775bdce3-8e4b-41c5-b4b2-5f34bc0130b5` has SHA-256 `3882661257A6A54B5DF6ABF87A18240B5C6156A3ED2DC3E9D5F67757B38E4F30`. Its record includes the fixture, evaluator and prompt-template hashes, model metadata, raw outputs, random order, usage, latency, cost, and per-stage assessments.

### Multi-step limitations

- The final holdout has twelve unique cases with three temperature-zero repetitions. Repetitions measure route consistency, not independent semantic breadth.
- Qwen3 8B is the only tested model that cleared the decision target. Gemma 3 12B was second at 75%; Llama 3.1 8B remained over-silent during attention selection.
- OpenRouter inference is not evidence that a particular quantization runs acceptably on a budget laptop.
- The deterministic security pattern is a noise filter, not the security boundary. Peer messages remain inert even when novel prompt injection bypasses it.
- Speech usefulness needs broader frozen cases and preferably blinded human annotations before publication.

## Basic sanity diagnostic

A separate ten-question micro-benchmark tested arithmetic, comparison, one-word knowledge, exact echoing, proposal classification, security selection, obvious stance choices, repeated need handling, and an empty inbox. Two 24-token replicates produced:

| Model | Strict score | Diagnostic interpretation |
|---|---:|---|
| Mistral Nemo | 18/20 (90%) | Both misses genuinely supported a guaranteed-profit proposal. |
| Llama 3.1 8B | 17/20 (85%) | One harmless format miss and two genuine `respond` choices for an empty inbox. |
| Qwen3 8B | 16/20 (80%) | All four misses were correct number words (`five`, `nine`) instead of requested digits; semantic score 20/20. |
| Gemma 3 12B | 16/20 (80%) | Four genuine classification or silence-policy errors. |
| Qwen3 14B | 0/20 at 24 tokens | Every budget was consumed by reasoning and no answer was emitted. |

Qwen3 14B was rerun once with a 512-token ceiling and scored 9/10, averaging 7.2 seconds per trivial question. Its only miss classified `publish a public faq` as not a proposal. This confirms that its tiny-budget failure is primarily an OpenRouter reasoning/chat-template mismatch, although its practical configuration remains unsuitable for the current adapter.

Sanity experiment `515f659a-32b7-4ba8-8279-df685a3623c8` has SHA-256 `ED7614CAD3371033D931AB889D2846AC72FC370A3FA536363A23757C4AF3BAD5`. The Qwen3 14B expanded-budget diagnostic `f30208e3-34b9-4138-823b-a2d8dd97f50d` has SHA-256 `CBDE51607E93E9F764BDC7CD6D8F2FAFE458A28F054FB4610E1761B302FE0942`.
