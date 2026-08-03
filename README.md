# HOOX · Web3 Wallet Worker

**On-chain identity resolution — derives wallet addresses from cold-stored keys at the edge. The bridge between CeFi execution and DeFi settlement.**

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![Runtime](https://img.shields.io/badge/Runtime-Bun-black?logo=bun)](https://bun.sh) [![Platform](https://img.shields.io/badge/Platform-Cloudflare%C2%AE%20Workers-orange?logo=cloudflare)](https://workers.cloudflare.com/) [![License](https://img.shields.io/badge/License-CC%20BY%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by/4.0/)

**Part of the [HOOX](https://github.com/hoox-sh/hoox) edge-trading mesh — a production-grade algorithmic trading framework on Cloudflare Workers.**  
**Site:** [hoox.sh](https://hoox.sh) · **Docs:** [docs.hoox.sh](https://docs.hoox.sh) · **Paper:** [`hoox-arxiv-paper-core.pdf`](https://github.com/hoox-sh/hoox/blob/main/papers/hoox-arxiv-paper-core.pdf)

---

The web3-wallet-worker provides on-chain identity resolution within the HOOX mesh. At initialization, it reads an ECDSA private key (`WALLET_PK_SECRET`) or a BIP-39 mnemonic phrase (`WALLET_MNEMONIC_SECRET`) from Cloudflare Secrets Store bindings — never from environment variables — and derives the corresponding Ethereum address via `ethers.js` v6 (`HDNodeWallet` / `Wallet`). The resolved address is logged to the [`analytics-worker`](../analytics-worker) and broadcast through the [`telegram-worker`](../telegram-worker) as a wallet-ready notification.

Secret format validation is enforced at the parser level: private keys must match `/^0x?[0-9a-fA-F]{64}$/`; mnemonics must contain 12 or more BIP-39 words. No swap, DeFi transaction signing, or arbitrary on-chain execution is implemented at this layer — this isolate is deliberately scoped to identity derivation and future on-chain primitive dispatch.

### Role in the Mesh

```
Cloudflare Secrets Store
    WALLET_PK_SECRET / WALLET_MNEMONIC_SECRET
              │
              ▼
┌──────────────────────┐
│ web3-wallet-worker   │  ← private (Smart Placement)
│ (ethers.js v6)       │
└──┬───────────────────┘
   │
   ├──► telegram-worker (wallet init notification)
   └──► analytics-worker (event telemetry)
```

### Entry Points

| Method | Path      | Auth         | Description                             |
| ------ | --------- | ------------ | --------------------------------------- |
| `GET`  | `/`       | Internal key | Wallet init: derive address from secret |
| `GET`  | `/health` | None         | Liveness probe                          |

### Security Model

- **Secrets never in environment**: fetched at runtime from Cloudflare Secrets Store binding
- **Strict validation**: private key regex-enforced; mnemonic word-count enforced
- **Fire-and-forget notifications**: telegram alerts via `ctx.waitUntil` (non-blocking)
- **Internal auth**: all endpoints except `/health` require `X-Internal-Auth-Key`

### Development

```bash
bun test workers/web3-wallet-worker
```

### License

[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) — part of the HOOX open-core mesh.
