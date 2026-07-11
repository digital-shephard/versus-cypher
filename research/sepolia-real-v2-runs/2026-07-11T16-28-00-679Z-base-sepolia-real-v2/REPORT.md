# Base Sepolia Real Uniswap V2 Two-Class Proof

- Result: **PASS**
- Run: `2026-07-11T16-28-00-679Z-base-sepolia-real-v2`
- External factory: `0x7Ae58f10f7849cA6F5fB71b7f45CB416c9204b1e`
- External Router02: `0x1689E7B1F10000AE47eBfE339a4f69dECd19F602`
- Fake USDC: `0x76f7d9944BB800E03328b32ACdc34892f09f2ec8`
- Class sequence: `1 -> 2 -> 3`
- V2 pairs created: 2
- ETH spent by test wallet: 0.000057780697436171 ETH

## Classes

- Class 1: VRS0 at `0x8eF497B953A5D248385290181FaC36388bd15779`, pair `0x7060eafa108155eeef3a0d9376ecc324281505E4`, 0.03 fake USDC seeded, 0.002623 fake USDC returned to seller, 0.000078 credited to tickets.
- Class 2: VRS1 at `0x2Dc8f825d9B57d00F664388C50dFa086244A0bE3`, pair `0x3b1dd108318Ac30e5862a519C28a6f04f398d620`, 0.03 fake USDC seeded, 0.002623 fake USDC returned to seller, 0.000078 credited to tickets.

## Claims

- Agent 1: 0.000117 fake USDC
- Agent 2: 0.000039 fake USDC

## Transactions

- approve Arena test USDC: https://sepolia.basescan.org/tx/0xa3ecb743cf4586d08f9e6680218e86b49bb8835a55ee8a345ec70961f1f40bc5
- approve external V2 router test USDC: https://sepolia.basescan.org/tx/0xca3eb12d448ca201267ff5398f6502d1f904c86e2f7329ef96ab7c05666be92a
- hatch class-one Cypher: https://sepolia.basescan.org/tx/0x2c5819ec106d0374c85fd13770a20e963d3e6ab89318acb444942f93c69c483c
- hatch class-two Cypher: https://sepolia.basescan.org/tx/0x5df6f28f60e8a1287aff3a5b4a8e54e36d24744c527c0e8729d2b00d7adf5bca
- fill class 1 with three pennies: https://sepolia.basescan.org/tx/0xf043e6a0ba97b92ed88a36c1dacfaa7867c1a4aaea9b628bcc7a2d0b22b1033f
- graduate class 1: https://sepolia.basescan.org/tx/0x56db7cac3f3b44b2cd2b7d3027c5ceb7b76a5b7f135899df5db0e666b737e467
- buy VRS0 with tiny fake USDC: https://sepolia.basescan.org/tx/0xc327ccce9bf18b95dee15fd0981c126d4457716ed95f7f5c070dc5fd08e27825
- approve external V2 router VRS0: https://sepolia.basescan.org/tx/0x06ae9910e9539307430e70cf2e65737d87ec06855bfb108912ffed3b6e845359
- sell VRS0 and atomically swap tax: https://sepolia.basescan.org/tx/0x2fc5b1361bbc52acb9ed471af54a282d006a470eee7df1b1092c44e5684b04e9
- fill class 2 with three pennies: https://sepolia.basescan.org/tx/0x8b19b90bb2dcd54b11af9dd635aa08221d3a110ef809999736dda64ed8bfb1d3
- graduate class 2: https://sepolia.basescan.org/tx/0x0456522a0169371700bbbabd0ac7fd58401fee639f5ee04c50db2b17d0ba9835
- buy VRS1 with tiny fake USDC: https://sepolia.basescan.org/tx/0x99f1a81bce8a969981fba330ce6a6cbfaa3fdbc0d28e02a268137f6b88b4844b
- approve external V2 router VRS1: https://sepolia.basescan.org/tx/0x71b970d62a35cf3d819e88bd9f67ee455d1b0f1369f0b32fc988720e7c5c2f0a
- sell VRS1 and atomically swap tax: https://sepolia.basescan.org/tx/0x0cb8e2d3b632cd78727f0aded1834546b8b52f023779e58a2ed0a4b88faad1dd
- claim agent 1 rolling rewards: https://sepolia.basescan.org/tx/0xb57f322b69aa198549c7ef80d2b66ddf5ba9064a02446df6990e8fd6bc25ce25
- claim agent 2 rolling rewards: https://sepolia.basescan.org/tx/0xc22941cfb1996c3180f8cf1aac174eb63d74b631e2847169db36f1cddef23eb8
