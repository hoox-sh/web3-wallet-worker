# HOOX · Web3 Wallet Worker

**On-chain signing at the edge — Uniswap V3 and Jupiter Swap V2. The bridge between CeFi execution and DeFi settlement.**

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![Runtime](https://img.shields.io/badge/Runtime-Bun-black?logo=bun)](https://bun.sh) [![Platform](https://img.shields.io/badge/Platform-Cloudflare%C2%AE%20Workers-orange?logo=cloudflare)](https://workers.cloudflare.com/) [![License](https://img.shields.io/badge/License-CC%20BY%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by/4.0/)

**Part of the [HOOX](https://github.com/hoox-sh/hoox) edge-trading mesh — a production-grade algorithmic trading framework on Cloudflare Workers.**  
**Site:** [hoox.sh](https://hoox.sh) · **Docs:** [docs.hoox.sh](https://docs.hoox.sh) · **Paper:** [`hoox-arxiv-paper-core.pdf`](https://github.com/hoox-sh/hoox/blob/main/papers/hoox-arxiv-paper-core.pdf)

---

The web3-wallet-worker holds EVM (`WALLET_PK_SECRET` / `WALLET_MNEMONIC_SECRET`) and Solana (`SOLANA_PRIVATE_KEY`) signing material as Cloudflare Secrets. `POST /swap` executes Uniswap V3 on Ethereum/Arbitrum (`dexVersion: "v3"`) and Jupiter Swap V2 on Solana. `trade-worker` calls this isolate over `WEB3_WALLET_SERVICE`. `hoox setup` writes `WALLET_EXECUTE_KEY_BINDING` and a Solana seed if missing.

### Role in the Mesh

```
Cloudflare Secrets Store
    WALLET_PK_SECRET / WALLET_MNEMONIC_SECRET / SOLANA_PRIVATE_KEY
              │
              ▼
┌──────────────────────┐
│ web3-wallet-worker   │  ← private (Smart Placement)
│ Uniswap V3 / Jupiter │
└──┬───────────────────┘
   │
   ├──► called by trade-worker (WEB3_WALLET_SERVICE POST /swap)
   ├──► telegram-worker (notifications)
   └──► analytics-worker (event telemetry)
```

### Entry Points

| Method | Path              | Auth         | Description                                      |
| ------ | ----------------- | ------------ | ------------------------------------------------ |
| `GET`  | `/`               | Internal key | Wallet init: derive address from secret          |
| `GET`  | `/health`         | None         | Liveness probe                                   |
| `GET`  | `/status`         | Internal key | Address + security summary                       |
| `GET`  | `/config`         | Internal key | Read wallet / DEX / security config              |
| `PUT`  | `/config`         | Internal key | Deep-merge config (strict Zod schema)            |
| `GET`  | `/balance`        | Internal key | Native or ERC-20 balance                         |
| `POST` | `/transfer`       | Internal key | ERC-20 transfer (gas trap + USD policy)          |
| `POST` | `/approve`        | Internal key | ERC-20 approve (whitelist + maxApprovalAmount)   |
| `GET`  | `/quote`          | Internal key | DEX quote                                        |
| `POST` | `/swap`           | Internal key | Uniswap V2/V3 or Jupiter Swap V2                 |
| `GET`  | `/transactions`   | Internal key | List D1 transaction records                      |

### Security Model

- **Secrets never logged**: opaque wallet cache keys; error logs never include key material
- **Strict validation**: private key `/^0x?[0-9a-fA-F]{64}$/`; mnemonic 12–24 BIP-39 words
- **Gas price trap**: `CONFIG_KV` key `web3:max_gas_price_gwei` — block signing when network fee exceeds limit
- **Server-side USD pricing**: client `valueUsd` ignored; fail-closed if asset cannot be priced
- **RPC URL safety**: HTTPS (or localhost HTTP for Anvil); block metadata / non-local HTTP
- **Fire-and-forget notifications**: telegram alerts via `ctx.waitUntil` (non-blocking)
- **Internal auth**: all endpoints except `/health` require `X-Internal-Auth-Key` (fail-closed)

### Development

```bash
bun test workers/web3-wallet-worker
```

### Mesh interconnect

| Direction | Peers |
| --------- | ----- |
| **Called by** | [trade-worker](https://github.com/hoox-sh/trade-worker) (`WEB3_WALLET_SERVICE`), [hoox-worker](https://github.com/hoox-sh/hoox-worker) (`/wallet` proxy), dashboard. |
| **This worker calls** | See list below |

- **[telegram-worker](https://github.com/hoox-sh/telegram-worker)** — TELEGRAM_SERVICE — wallet-ready notifications
- **[analytics-worker](https://github.com/hoox-sh/analytics-worker)** — ANALYTICS_SERVICE — identity / event telemetry

Full mesh (all isolates live as git submodules under [`hoox-sh/hoox`](https://github.com/hoox-sh/hoox) `workers/`):

| Isolate | Role | Repository |
| ------- | ---- | ---------- |
| [hoox-worker](https://github.com/hoox-sh/hoox-worker) | Public webhook gateway (WAF, idempotency, dispatch) | monorepo `workers/hoox-worker` |
| [trade-worker](https://github.com/hoox-sh/trade-worker) | CEX + DEX spots (Uniswap V3 / Jupiter) | monorepo `workers/trade-worker` |
| [agent-worker](https://github.com/hoox-sh/agent-worker) | AI risk manager (configurable cron 1–1440 min, kill switch) | monorepo `workers/agent-worker` |
| [d1-worker](https://github.com/hoox-sh/d1-worker) | D1 SQL proxy + settings / balances / positions | monorepo `workers/d1-worker` |
| [telegram-worker](https://github.com/hoox-sh/telegram-worker) | Alerts, bot commands, RAG copilot | monorepo `workers/telegram-worker` |
| [email-worker](https://github.com/hoox-sh/email-worker) | Mailgun / email signal parsing → trade | monorepo `workers/email-worker` |
| [analytics-worker](https://github.com/hoox-sh/analytics-worker) | Analytics Engine write + query path | monorepo `workers/analytics-worker` |
| [report-worker](https://github.com/hoox-sh/report-worker) | PDF reports via Browser Rendering → R2 | monorepo `workers/report-worker` |
| [web3-wallet-worker](https://github.com/hoox-sh/web3-wallet-worker) | On-chain wallet identity (ethers.js) | monorepo `workers/web3-wallet-worker` |
| [dashboard](https://github.com/hoox-sh/hoox/tree/main/workers/dashboard) | Next.js ops console (OpenNext, public) | monorepo `workers/dashboard` |

### Docs & monorepo

| Resource | Link |
| -------- | ---- |
| Isolate profile (operators) | [https://docs.hoox.sh/docs/devops/workers/web3-wallet-worker](https://docs.hoox.sh/docs/devops/workers/web3-wallet-worker) |
| Parent monorepo | [github.com/hoox-sh/hoox](https://github.com/hoox-sh/hoox) |
| This repository | [github.com/hoox-sh/web3-wallet-worker](https://github.com/hoox-sh/web3-wallet-worker) |
| Workers index | [docs.hoox.sh → Workers](https://docs.hoox.sh/docs/devops/workers) |
| CLI | `@hoox-sh/hoox-cli` · `hoox deploy worker web3-wallet-worker` |

### License

[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) — part of the HOOX open-core mesh.
