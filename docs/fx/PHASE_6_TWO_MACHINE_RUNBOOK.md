# Phase 6 independent Windows and macOS run

This laboratory uses the public Versus Waku fleet and public testnet addresses.
It does not use production Cypher keys, production funds, or a desktop FX UI.

## Safety boundary

- Run only `agentic-fx/phase-6`.
- Use a new empty data directory on each machine.
- Let the runner create an encrypted short-lived coordination identity.
- Never export a Cypher owner key to a terminal.
- The settlement addresses below are the existing dedicated Phase 5 testnet
  identities. The macOS dealer does not need their private keys for this
  coordination-only proof.
- Do not set `FX_PHASE6_SETTLE`; the public settlement proof is a separate,
  controlled harness.

## 1. Start the Windows requester first

From the repository root in PowerShell:

```powershell
$env:FX_PHASE6_ROLE = "requester"
$env:FX_PHASE6_DEPLOYMENT_ID = "0xd0935aa32dc4d37e33180ac9409c993b7bf39749ff375df4da033bd106c0983e"
$env:FX_PHASE6_DATA_DIR = "$env:LOCALAPPDATA\Versus Cypher\fx-phase6-requester"
$env:FX_PHASE6_COORDINATION_PASSWORD = "<new local lab password>"
$env:FX_PHASE6_OUTPUT_CHAIN_ID = "421614"
$env:FX_PHASE6_OUTPUT_TOKEN = "0xcba3d9354dd4c30bb6961abb4473a6340486e01b"
$env:FX_PHASE6_OUTPUT_AMOUNT_ATOMIC = "10000"
$env:FX_PHASE6_INPUT_CHAIN_ID = "84532"
$env:FX_PHASE6_INPUT_TOKEN = "0xcba3d9354dd4c30bb6961abb4473a6340486e01b"
$env:FX_PHASE6_MAX_INPUT_ATOMIC = "11000"
$env:FX_PHASE6_SOURCE_REFUND_ADDRESS = "0xa4ac9532bf09d1992663b031e2ee15847f4f0a50"
$env:FX_PHASE6_DESTINATION_CLAIM_ADDRESS = "0xa4ac9532bf09d1992663b031e2ee15847f4f0a50"
$bytes = New-Object byte[] 32
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$rng.Dispose()
$env:FX_PHASE6_SECRET_HASH = "0x" + (($bytes | ForEach-Object { $_.ToString("x2") }) -join "")
npm run fx:phase6:headless --prefix packages/network
```

Leave the requester running for at least 20 seconds before starting the
dealer. This intentionally proves late-join Store recovery.

## 2. Start the macOS dealer

Pull the same branch, install dependencies, and run from the repository root:

```bash
FX_PHASE6_ARM_DELAY_MS=0 npm run fx:phase6:mac-dealer-lab --prefix packages/network
```

The lab launcher prints `mac-dealer:armed`, then starts the dealer with a fresh
encrypted identity and the frozen testnet-only settings below. It removes
settlement and operator-key variables from the child environment.

When coordinating through a slow human channel, arm macOS five minutes ahead:

```bash
FX_PHASE6_ARM_DELAY_MS=300000 npm run fx:phase6:mac-dealer-lab --prefix packages/network
```

Use the printed `startsAt` timestamp to schedule the requester 25 seconds
earlier. This preserves the protocol's intentional 60-second RFQ lifetime while
making Store recovery deterministic. The expanded settings are retained here
for auditability and manual runs:

```bash
export FX_PHASE6_ROLE="dealer"
export FX_PHASE6_DEPLOYMENT_ID="0xd0935aa32dc4d37e33180ac9409c993b7bf39749ff375df4da033bd106c0983e"
export FX_PHASE6_DATA_DIR="$HOME/Library/Application Support/Versus Cypher/fx-phase6-dealer"
export FX_PHASE6_COORDINATION_PASSWORD="<new local lab password>"
export FX_PHASE6_INPUT_CHAIN_ID="84532"
export FX_PHASE6_INPUT_TOKEN="0xcba3d9354dd4c30bb6961abb4473a6340486e01b"
export FX_PHASE6_INPUT_AMOUNT_ATOMIC="10000"
export FX_PHASE6_SOURCE_CLAIM_ADDRESS="0x3550648bd09c4f6acd3782433fcbdb85abcc8bf7"
export FX_PHASE6_DESTINATION_REFUND_ADDRESS="0x3550648bd09c4f6acd3782433fcbdb85abcc8bf7"
export FX_PHASE6_REFERENCE_SOURCE="phase6:public-testnet-manifest"
export FX_PHASE6_REFERENCE_PRICE_MICROS="1000000"
export FX_PHASE6_SPREAD_BPS="0"
npm run fx:phase6:headless --prefix packages/network
```

## 3. Required evidence

The run passes only when:

1. macOS logs `dealer:listening`;
2. macOS logs a Store-recovered `fx_rfq` with `"history":true`;
3. macOS logs `dealer:quoted` and `dealer:reserved`;
4. Windows logs `requester:reserved`;
5. both machines retain encrypted coordination identities and SQLite journals;
6. `requester:reserved` and `dealer:reserved` report the same journal state
   hash;
7. neither metrics file contains a raw secret, private key, mnemonic, keystore,
   balance, or inventory field.

Preserve both `phase6-events.ndjson` files and the two journal state hashes as
the independent-machine evidence bundle.
