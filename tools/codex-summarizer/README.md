# Optional tool-free Codex subscription bridge

This bridge adapts OMP's `openai-codex` subscription provider to Parley's single-message OpenAI summary API. It is not the official Codex SDK. It pins `gpt-6.1-sol`; no paid API/model fallback is attempted. Transcript text is sent to the provider; do not expose the bridge publicly.

## Build and runtime contract

Supply the OMP18.12.6 Linux x64 standalone binary as `omp` in this build directory. Dockerfile verifies SHA256 `85d9daf3a05fc76e8cd425ae1904eb576af8d21cc85fcf4690742626e07ccfa4`. Build with `docker build -t parley-codex-summarizer:18.12.6-auth .`. The binary, credentials, deployment configuration and meeting data must not be committed.

Run as UID/GID1000 with read-only root, dropped capabilities, no-new-privileges, private network and no published port. Mount a dedicated writable auth directory at `/auth` and a random private bridge bearer file at `/run/secrets/bridge-key` read-only. Give `/tmp` a writable noexec tmpfs and `/runtime` a writable **executable** tmpfs (native-addon cache), owned by1000. Do not mount application data, audio, agent profiles or the Docker socket. Example limits: CPU1, memory1536MiB, PIDs128, `/tmp`64MiB and `/runtime`512MiB. Mounts/directories must be0700 and credential files0600. Server umask0077 protects refresh writes.

Configure Parley's OpenAI base URL to the bridge's private `/v1`, model `gpt-6.1-sol`, API key to the bridge bearer, fallback disabled. Preserve existing guild settings. A fresh empty workspace, minimal child environment and stdin input are enforced by the runner. All tool/extension/skill/rule/LSP/PTY/session discovery flags remain disabled. Responses must identify the intended subscription provider/model, unchanged input, terminal response, zero tool activity and exact StructuredNotes.

## OAuth lifecycle: authorize this store directly

**Do not bootstrap a production service by exporting/importing another agent's OAuth credential.** Separate SQLite files still share the same rotating refresh-token lineage. A refresh elsewhere can invalidate the copy (`refresh_token_reused`). Never periodically recopy tokens or reset a disabled flag in SQLite.

Authorize the dedicated store with OMP's supported interactive login, using the same runtime environment and writable mount as inference:

```sh
docker exec -it -e HOME=/runtime -e PI_CODING_AGENT_DIR=/auth \
  parley-codex-summarizer /bridge/omp login openai-codex
```

A human must complete the provider's authorization flow. Keep authorization URLs/codes and tokens out of logs, issues and chat. If the account/provider does not allow independently refreshable authorizations, use a supported provider credential lifecycle rather than copying tokens. This bridge does not implement its own refresh protocol. Verify a real tool-free provider summary after login; `/health` proves HTTP liveness only, not subscription readiness.

## Failures and recovery

HTTP424/category `auth_required` requires dedicated login, not retries or paid credits. OMP may report only `No API key found` after disabling an invalid refresh token. Inspect credential metadata privately to distinguish missing authorization from invalidated refresh. Do not dump auth exports or stderr.

HTTP408 is the unchanged child deadline/cancellation; HTTP422 identifies invalid notes, isolation traces or output-size failure. Unknown child failures remain502 and can be transient. Logs contain only fixed category/status plus exit/signal/duration/byte counts. Bounded stderr is classified in memory and never logged. HTTP limits remain1MiB input,4MiB stdout, one concurrent request, OMP150s and process160s. There is no new retry layer, timeout inflation, truncation or model switch.

After fixing authentication, re-summarize **saved utterances**, not audio; reconcile existing Discord history before posting to the existing configured destination. Do not mark delivery successful merely because notes were saved. Preserve original audio outside any boot-retention sweep before restarting an application. Verify actual bot/channel/message IDs and exact notes readback once posted.

Run `node --test tools/codex-summarizer/bridge.test.mjs` from the repository root. Fixture tests prove boundary handling, not provider availability or meeting fidelity. A native provider canary and saved-transcript recovery remain required deployment checks.
