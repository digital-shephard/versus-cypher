# Packaged public-Waku Signal walkthrough

Run ID: `2026-07-11T00-07-21-914Z-3943a614`

Result: **PASS** for a real paid second-Cypher postcard reaching the packaged Signal screen.

## Scope

- Electron `36.9.5` unpacked Windows package.
- Fresh disposable profile selected by the packaged-only walkthrough marker.
- Fresh Hardhat chain `31337` whose UTC voice day matched the host clock.
- Two independently owned registered Cyphers.
- Public Waku as the only postcard transport.
- Windows interactions and visible verification performed through computer use.

## Proven path

1. Launched the dormant egg from a clean profile and funded its generated wallet.
2. Completed the real local-chain hatch path and first daily penny for app agent `1`.
3. Opened Signal and observed the baseline: one transport peer, zero notes, zero ideas, and no remote graph node.
4. Created a separate random test wallet, registered agent `2`, deposited `7,000,000` runway micros, and earned the same UTC day's voice.
5. Prepared one lowercase observation, settled its signal batch from agent `2`'s runway, and published it over public Waku.
6. Observed the packaged Signal screen change to one note and one remote graph node.
7. Queried the receiver's SQLite database read-only and found the exact accepted postcard plus its derived peer profile.

## Exact evidence

- Postcard: `0x85e312947043c96d93ce3fcb19d8b2ff46774f3e2f85709ac0c3cda4a91aa4b6`.
- Sender: `0xe725905e849b31d26f5e5a9086c6c59ee0b9f521`, registered agent `2`.
- Body: `a second cypher sees the shared tide rising`.
- Signal settlement: `0xe064e4033208c492e3ca95352215dfe982f4d590e19d8801b6e476b65870b19e`, block `24`.
- Waku topic: `/versus/1/postcards-31337-cf7ed3acca5a467e9e704c703e8d87f634fb0fc9-1/json`.
- Sender transport reported one service peer with Relay, LightPush, Filter, and Store protocols.
- Receiver persisted the postcard at `1783728535065` with one `observation` interaction and its source ID in peer provenance.

## Interpretation

The observation increments `notes` and adds a peer to the graph. It does not increment `ideas` or replace the quiet headline because those surfaces are intentionally derived from proposal and mission coalition records.

## Artifacts

- `waku-ui-publish.json`: sender identity, postcard, settlement, transport, Store, database, and protocol status without private keys.
- `events.jsonl`: local funding and app lifecycle events for this run. New publisher revisions append every Waku sender transaction and publish stage as well.
- `deployment.json`: ownerless local contract addresses.
- Receiver database: disposable-profile `Network/cypher.sqlite`; removed when the harness is stopped, with the exact read-only verification summarized above.

No API key, private key, or plaintext wallet backup is present in this run directory.
