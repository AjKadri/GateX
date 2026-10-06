# Gate G1 release review closure

This document records the coordinator review input for the release candidate. It is not a claim that a separate reviewer performed a second audit.

| Finding | Resolution |
| --- | --- |
| README described only the early compiler checkpoint | Rewritten for the verified release, with the real deployment, circuits, proof counts, commands, evidence, and claim boundary. |
| Page title was `GateX compiler checkpoint` | Replaced with a product title, description, and basic Open Graph metadata. |
| Internal build-gate wording appeared in the shipped UI | Replaced judge-facing labels such as `WORKSPACE`, `VERIFIED RELEASE`, and `Manufacture unavailable in this release`. Historical internal documents remain explicit about their evidence stage. |
| Deployment manifest lacked final release state | Added both manufactured circuits, final spend, remaining budget, artifact facts, and verification counts while preserving historical spend and the accidental-deployment quarantine. |
| Public language and verification documentation was missing | Added `docs/language.md`, `docs/verification.md`, and the short demo script. |
| No direct-static deployment package existed | Added `deploy/Caddyfile.gatex` and the read-only deployment/rollback sequence in `deploy/README.md`. |
| No public machine-readable evidence manifest existed | Added `public/evidence/release.json` with release facts, hashes, transactions, provider scope, and disclosures. |
| Internal builder files were tracked | Added ignore rules and removed the local-only instruction, handoff, and progress files from the Git index without deleting the local copies. |

Known release boundary: the repository now declares MIT licensing. DNS, VPS, Caddy activation, and production release switching remain outside this checkpoint.

## Release revision interpretation

`public/evidence/release.json` intentionally keeps `releaseRevision` at `6fb16e3`. That commit identifies the frozen application and release-content revision. Later metadata-only commits, including the G2A license and submission package, do not change the application artifact identity or its accepted hashes.
