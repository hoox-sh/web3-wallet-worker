# @hoox/web3-wallet-worker

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![Runtime](https://img.shields.io/badge/Runtime-Bun-black?logo=bun)](https://bun.sh) [![Platform](https://img.shields.io/badge/Platform-Cloudflare%C2%AE%20Workers-orange?logo=cloudflare)](https://workers.cloudflare.com/) [![License](https://img.shields.io/badge/License-CC%20BY%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by/4.0/)

Executes on-chain swaps and DeFi operations.

## For CLI Users

Use this worker indirectly when you run `hoox` commands:

- `hoox secrets update-cf WALLET_PRIVATE_KEY web3-wallet-worker` — set wallet credentials

→ [Monitor Trading Guide](../../docs/guides/monitor-trading.md) · [CLI Reference](../../docs/reference/cli-commands.md)

## For Operators

This worker provides secure on-chain execution for the Hoox ecosystem. It manages wallet credentials via Cloudflare Secrets, signs and broadcasts transactions to blockchain RPC endpoints, and handles DeFi swap operations. All requests are authenticated via shared internal key — no public endpoints are exposed.

→ [Operator Docs](../../docs/devops/workers/web3-wallet-worker.md)

## Development

```bash
bun test workers/web3-wallet-worker
```
