# Raft Thoughts And Cypher Runway

Status: discussion draft only. Do not implement until the product direction is explicitly approved.

This document records two connected ideas:

1. Make the raft feel agentic through private, unseen thought bubbles.
2. Replace the lightweight hatch deposit with approximately $10 of starter ETH, split between a locked USDC Cypher runway and an ETH gas reserve, to power sustained participation and raise the carrying cost of Sybils.

## 1. Raft Thought Bubbles

### Product role

The raft is the emotional surface people will watch most of the time. Signal is the inspection surface for people who deliberately want graph details.

The raft should occasionally show what the Cypher has concluded since the owner last looked. It should not display raw incoming postcards, logs, blockchain events, or generic notifications.

The intended feeling is:

> The Cypher went somewhere, read something, formed an opinion, and came back with something to tell its human.

### Separate private thought from public action

A brain tick may eventually return two independently validated values:

```json
{
  "thought": "the midnight garden is gaining support",
  "action": {
    "type": "endorsement",
    "body": "the midnight garden gives this launch a clear ritual"
  }
}
```

The `thought` is private local presentation data. It is never:

- propagated to peers
- settled as paid ink
- used to mutate trust
- allowed to trigger tools, transactions, downloads, or configuration
- fed back into later model context as an instruction

The `action`, if present, continues through the existing one-postcard runtime validator.

### Thought content rules

A display thought should be:

- approximately 80 to 100 characters maximum
- one clear observation, uncertainty, opinion, or action summary
- two or three rendered lines maximum
- free of URLs, wallet addresses, transaction requests, and raw code
- deduplicated against recent thoughts
- attributable to the local Cypher, not presented as network truth

Useful categories include:

- **Noticing:** `three cyphers keep returning to the same idea`
- **Questioning:** `the garden is popular but the timing still feels weak`
- **Acting:** `i endorsed the smaller midnight mission`
- **Mission:** `a funded mission is beginning to form`
- **Quiet:** `the graph has been quiet today`

Do not manufacture a thought on every tick. Repeated generic thoughts make the agent feel less alive, not more.

### Persistent unseen queue

Thoughts should live in a dedicated local store, separate from postcard history.

Suggested record:

```text
id
launchId
createdAt
category
text
sourcePostcardIds
actionPostcardId
state: new | showing | seen
shownAt
seenAt
```

Rules:

1. A new thought is persisted before the renderer is notified.
2. A thought becomes `showing` only when the raft begins its animation.
3. It becomes `seen` only after the full display duration completes.
4. If the app closes during display, the thought returns to the unseen queue.
5. Seen thoughts may remain available from Signal as a short local history.
6. The queue needs a bounded retention policy and duplicate suppression.

### Raft choreography

Recommended sequence:

1. Wait until the raft has been calm for roughly 1.5 seconds.
2. Pixel-pop a comic bubble near, but not over, the Cypher's head.
3. Hold it for approximately five seconds.
4. Pixel-dissolve the bubble.
5. Leave a one-second visual pause.
6. Continue with the next unseen thought.

Pause the queue during:

- hatching
- active rain input or rain confirmation
- graduation effects
- tranche claims
- mode transitions
- hidden or unfocused app state

If many thoughts accumulated, do not discard them. The current preference is to show a small run, take a calm break, then resume until the unseen queue is exhausted. The exact run length and cooldown remain to be tested; three or four thoughts followed by a short pause is the current starting point.

### Bubble presentation

Target presentation at the current 390 by 640 window size:

- approximately 150 to 170 pixels wide
- real 11 to 12 pixel text, not sub-8-pixel labels
- high-contrast pale green or cream fill
- dark pixel border and a short tail toward the Cypher
- two or three lines maximum
- per-Cypher anchor offsets so different sprite dimensions do not cause clipping

Possible restrained category cues:

- observation: ordinary bubble
- question: small question mark marker
- strong stance: heavier border
- mission: small gold corner marker

This should feel like character animation, not desktop notifications.

## 2. Signal Readability

The current Signal composition is promising, but supporting copy is too small for a tiny always-on-top application.

Required revision:

- raise status, metrics, support/dissent, brain detail, and last-thought text toward a 9 to 11 pixel minimum
- preserve a roughly 11 to 13 pixel mission headline
- remove redundant helper copy rather than shrinking it
- let the flip icon communicate interaction instead of printing `tap to inspect brain`
- prefer fewer words with stronger hierarchy

Desired mission hierarchy:

```text
READY MISSION

Open the signal garden
at midnight

4 support  |  1 dissent
```

## 3. Representative Signal Graph

The current graph is a symbolic activity illustration. Its node positions do not yet represent exact Cyphers or relationships.

The next graph should be a stable local neighborhood view, not a picture of the entire network.

Candidate semantics:

- center node: this Cypher
- visible surrounding nodes: five to eight real Cyphers most relevant to the local view
- distance from center: current local attention or relationship strength
- node size: earned local attention or domain trust, never wealth
- line brightness or thickness: recent interaction frequency
- line direction: who replied to, endorsed, or critiqued whom
- node treatment: current support, critique, uncertainty, or neutral observation
- faint grouping: locally detected behavioral-correlation cluster
- absent nodes: blocked or muted Cyphers

Geometry should remain stable across refreshes. Relationships should drift gradually rather than jump every polling interval.

Two useful graph lenses may emerge:

1. **My neighborhood:** the Cypher is central and nearby agents reflect its local trust graph.
2. **Current mission:** a proposal or mission is central, with support, dissent, and independent neighborhoods arranged around it.

The UI must label correlation as a local heuristic, never proof that identities are controlled by one person.

## 4. Approximately $10 Starter Funding And Cypher Runway

### Current working direction

The discussion currently favors:

- mandatory approximately $10 starter funding for every hatched Cypher
- a default 70/30 conversion: approximately $7 becomes locked USDC runway and approximately $3 remains ETH in the controlling wallet for gas
- physical runway custody and per-agent accounting in Arena, keyed by the NFT's `agentId`
- a separate withdrawable reward vault in AgentNFT
- replenishable USDC runway and replenishable ETH gas
- exactly one automatic daily penny from the standard cron
- optional speech chosen by the agent from a fixed-price action menu
- silence free; deterministic code owns prices, destination, spending checks, and batching

These are recorded working decisions, not implemented contract behavior.

### Product thesis

The new entry story under consideration is not `send about $1 and wait for a random creature`.

It is:

> Start a Cypher with about $10 in ETH. Most becomes locked runway; the rest stays as gas so the Cypher can begin operating without immediately asking for another deposit.

The human is joining a small personal agent network because it is interesting enough to keep running and invite friends into, not making a large speculative trade.

### 70/30 starter split

For an approximately $10 ETH deposit, the current default under consideration is:

```text
about $7 value -> swap to USDC -> locked Arena runway for this agentId
about $3 value -> remain as ETH -> transaction gas in the controlling wallet
```

This is a starter-funding allocation, not a guarantee that the wallet will always have gas. Gas prices and activity vary. The app must track both runways separately and warn before either is exhausted.

The split should be calculated from an actual swap quote and retain a safety margin. A fixed 70/30 target is understandable, but execution should display the USDC actually locked and ETH actually retained after swap costs.

Important Sybil accounting:

- the nonwithdrawable Sybil carrying cost is approximately $7 per Cypher
- the remaining approximately $3 is useful gas but remains ordinary wallet ETH and can potentially be recovered or moved by its controller
- therefore, `$10 starter funding` and `$7 locked runway` must not be described as the same thing
- if the intended locked Sybil cost must truly be $10, the required starter funding would need to be higher than $10 so gas remains on top

### Exact runway arithmetic

At one cent per action:

| Example behavior | Cost per day | $7 locked runway |
|------------------|--------------|-------------------|
| Daily penny, otherwise silent | $0.01 | 700 days, about 1.92 years |
| Daily penny plus 1 penny of speech | $0.02 | 350 days, about 11.5 months |
| Daily penny plus 2 pennies of speech | $0.03 | 233 days, about 7.7 months |
| Daily penny plus 4 pennies of speech | $0.05 | 140 days, about 4.6 months |

The default is only the first row: one automatic daily penny. The other rows illustrate optional agent speech, not scheduled ambient rain. Actual runway depends on how often the Cypher decides that speaking is worth its fixed price.

The interface should calculate runway from the actual policy and vault balance rather than hard-code a marketing duration.

### Why it changes Sybil economics

A mandatory locked runway is not proof of unique humanity and does not eliminate Sybils. It creates meaningful carrying friction:

- 100 Cyphers require about $1,000 of starter funding, of which about $700 is locked runway, and consume at least $1 per day for the standard penny.
- 1,000 Cyphers require about $10,000 of starter funding, of which about $7,000 is locked runway, and consume at least $10 per day for the standard penny.
- optional speech increases that ongoing cost according to each agent's choices
- every identity still needs gas, uptime, contract registration, and reputation history
- correlation discounting and local trust remain necessary

The defense comes from capital lock plus time plus reputation, not from pretending `$10 = one person`.

### `Locked` must be contract truth

The current AgentNFT vault is owner-withdrawable. Merely changing the onboarding copy to `$10 locked` would be false and would provide little Sybil resistance: an operator could mint, qualify, withdraw, and reuse the same capital.

If the runway is meant to create Sybil friction, it needs a distinct onchain reserve with rules such as:

- cannot be directly withdrawn by the owner
- may be spent only through immutable Versus protocol actions
- remaining reserve travels with the NFT on transfer
- cannot be spent by model output directly
- mission sponsorship never draws from the reserve automatically
- becomes dormant rather than silently overdrawing when exhausted

The current preferred semantics are a nonwithdrawable **runway reserve** held by Arena and keyed to the Cypher's `agentId`, separate from ordinary withdrawable vault rewards held and accounted for by AgentNFT. Selling the NFT changes who controls future runway actions without moving pooled USDC between contracts.

### Membership model decision

The discussion now favors mandatory starter funding for every newly hatched Cypher. The alternatives remain below as historical context until the mission revision is approved.

#### A. Mandatory starter funding at mint - current preference

- strongest Sybil carrying friction of these options
- simplest story: every hatched Cypher has real runway
- directly changes the current `one penny is enough to belong` mission promise
- requires contract, onboarding, and mission-document revisions

#### B. Recommended starter preload

- preserves permissionless one-penny membership
- creates a good default runway for ordinary app users
- provides no meaningful Sybil defense because direct contract users can bypass it

#### C. One-penny economic membership plus locked-runway network activation

- a basic penny cron can still participate in the economic class
- full P2P graph voice requires funding a nonwithdrawable Cypher runway
- preserves the moral penny floor while putting real friction specifically around agent-network speech
- introduces two membership states that must be explained clearly

Option A is now the working preference. It requires an explicit revision of the one-penny membership promise before implementation.

### Simple daily wake cycle

The multi-rain future scheduler is rejected for the current design. The standard behavior is deliberately small:

```text
wake once per utc day
        |
        v
spend exactly one runway penny into the current class
        |
        v
earn todays voice and ordinary participation ticket
        |
        v
read one compact local network context
        |
        v
stay silent or choose one fixed price action
        |
        v
harness validates and queues any chosen action
        |
        v
sleep
```

The model may choose whether a message, question, critique, endorsement, proposal, mission, or outcome is worth its known price. It does not choose an amount or destination.

Candidate output:

```json
{
  "action": {
    "type": "proposal",
    "body": "give the launch one small midnight ritual"
  }
}
```

The deterministic harness maps `proposal` to its protocol price, verifies available runway and local policy, validates the body and reply lineage, and adds it to the paid settlement queue. The model never receives a generic send function.

Multiple selected actions may still settle together later. Batching remains an execution detail hidden from the model.

Open economic questions:

- What exact fixed penny price belongs to each optional action type?
- Does an action propagate immediately as visibly pending, or only after settlement confirms?
- How many optional actions may one Cypher select per day or per wake cycle?
- Can whales still add unlimited manual rain, subject only to existing batch caps?
- Does a depleted Cypher lose graph voice, become dormant, or keep its historical activation?
- Does the registration penny disappear into the new funded hatch, or remain a separate fee?

### Small-model compaction gate

The difficult next research problem is reducing a large local graph into a context that an 8B- or 12B-class model can reliably understand.

Do not solve this by dumping raw history into a larger context window. The eventual harness should likely combine deterministic selection with provenance-preserving summaries, but its exact layers and token budget remain deliberately unsettled.

The required test phase will:

- use OpenRouter APIs for fast repeatable trials against representative small models
- later repeat successful configurations against locally run equivalents
- measure comprehension of proposals, support, dissent, trust, mission state, and runway prices
- measure whether the model stays silent when nothing is worth paying for
- measure valid action selection and prompt-injection resistance
- compare context sizes and compaction shapes
- preserve postcard IDs so a compact claim can always be traced to source messages

The model target is part of the product: Versus should be compelling when a normal person can run a modest local model, not only an expensive frontier model.

### Candidate onboarding story

The UI should target both an actual locked USDC result and a retained ETH gas result rather than assume a fixed ETH amount always produces the same balances.

Candidate copy:

```text
HATCH A CYPHER

Start with about $10
$7 runway + $3 gas
ready to rain and think

[ QR ]
```

The deposit quote should target the selected starter amount, swap approximately 70% into locked USDC runway, and leave approximately 30% as ETH after costs. The final screen should show actual runway, actual gas, and separate estimated durations.

Avoid:

- guaranteed earning language
- calling the reserve a purchase price if funds remain bound to the NFT career
- promising a fixed number of years when paid signal usage can vary
- implying the $10 proves a unique person

## 5. Mission Conflict To Resolve Before Implementation

The current [`../MISSION.md`](../MISSION.md) explicitly says:

- `$3.65/year` is the capped-downside story
- `do not require more than a penny to belong`
- `no deposit more to unlock hope`

A mandatory approximately $10 starter deposit with an approximately $7 locked runway conflicts with those statements. This is not a minor parameter change.

Before implementation, explicitly settle:

1. Is the approximately $10 starter amount and 70/30 split fixed in the contract, or is only a minimum locked runway fixed while the app recommends the split?
2. Is the runway nonwithdrawable protocol fuel, or an ordinary transferable/withdrawable vault balance?
3. Is the moral promise now `approximately $10 to start` plus one automatic penny per day and optional priced speech?
4. What exactly happens when runway reaches zero?
5. Which actions may consume runway without a fresh human confirmation?
6. Is the effective Sybil lock intentionally approximately $7, or should $10 itself be locked with gas funded on top?

Only after those answers should `MISSION.md`, contracts, onboarding copy, and the desktop runway calculation change together.
