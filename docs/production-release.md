# GateX production release

## Release

- Production URL: https://gatex.ajkadri.dev
- Application SHA: `30d8fe5b79555f270456f10d6e4ee4be9952f9af`
- Deployment time: `2026-10-06T22:51:14+01:00`
- Release directory: `/var/www/gatex/releases/30d8fe5b79555f270456f10d6e4ee4be9952f9af/`
- Previous release: none. GateX was not previously active on this VPS.
- Active serving: `/var/www/gatex/current` points to the release directory above.

## Production verification

- HTTPS: PASS. The production origin returned 200 for `/` and the required asset and evidence endpoints.
- TLS: PASS. HTTPS certificate verification succeeded through the normal production browser and curl path.
- Static assets: PASS. Local and remote SHA-256 manifests matched for all four deployed files.
- Evidence JSON: PASS. `/evidence/release.json` is reachable and exposes the accepted processor, token, artifact hashes, dimensions, and limitations.
- Caddy: PASS. The existing six site blocks were preserved. GateX was added as a separate direct-static site block using `/var/www/gatex/current`. Caddy validation passed and the service was reloaded once.
- Caddy backup: `/etc/caddy/Caddyfile.pre-gatex-20261006-214749`

## GateX live checks

- Circuit 1 fresh production readback: PASS. Both locked providers matched circuit 1, payload 631 bytes, dimensions `(3,1,2,91)`, and the accepted payload hash.
- Circuit 2 fresh production readback: PASS. Both locked providers matched circuit 2, payload 694 bytes, dimensions `(6,1,2,100)`, the accepted payload hash, owner, and canonical processor binding.
- AgentApproval live transition: PASS. A read-only `IDLE` plus `request` transition matched `LOCAL SIMULATION` and `LIVE X LAYER` as `REQUESTED`, output `0x00`, at common block `72554320`.
- RPC/CORS: PASS. The real production browser completed readback and live `step()` calls against both locked providers without test-only CORS relaxation.
- Wallet: not available in the production browser. No wallet connection, signature, or transaction request was made.

## Existing sites and limitations

- Existing VPS-hosted routes remained reachable after activation. `campaignwatcher.ajkadri.dev` returned its expected authentication response and `nimproof.ajkadri.dev` returned its existing root response.
- `fresh.nimproof.ajkadri.dev` resolves to external addresses rather than this VPS and was not changed by the GateX Caddy addition. Its HTTPS handshake remained unavailable independently of GateX.
- No blockchain state-changing action occurred during deployment.
- The public evidence JSON intentionally retains the frozen evidence revision `6fb16e3`; the deployed application revision is `30d8fe5b79555f270456f10d6e4ee4be9952f9af`.
- Protocol source/build provenance remains unresolved. Workflow state remains caller-owned by the browser.

## Demo readiness

The production site is ready for the 90–150 second read-only demo. Recommended flow: Overview, AgentApproval Workspace, counts and hashes, fresh circuit 2 readback, one matching local/live transition, caller-owned-state disclosure, then Evidence.
