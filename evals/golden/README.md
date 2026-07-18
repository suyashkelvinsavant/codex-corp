# Golden evaluation fixtures

Host-owned verification fixtures for Codex Corp layer A.

| Fixture | Asserts |
|---|---|
| `self-attestation-blocked` | Required claim cannot pass on producer `passed:true` |
| `missing-artifact` | `artifact_exists` fails when name absent |
| `command-fail` | Allowlisted command non-zero exit fails |
| `architecture-wrong-layer` | Suspect TS runtime paths fail architecture policy |
| `delivery-stale-hash` | Pair-compare fails on hash mismatch |

These are **documentation + JSON shapes** for eval harnesses. Runtime unit tests under `src-tauri/src/verifier/**` cover the same cases executable-in-CI.
