# Dashboard security boundary and dependency notes

## Authentication and onboarding

First boot seeds `admin` with 32 cryptographically random bytes encoded as a setup password. The password is printed once to the local process log, never returned by an API, and stored only as a salted scrypt hash in SQLite. For Docker, inspect `docker compose logs bot`. Treat startup logs as credentials: restrict access, do not publish them, and rotate immediately. The password remains usable for setup until rotated; it is not consumed by a login attempt. Restarting does not generate or reveal another credential.

Only login, logout, current-session information, and the account's own password change are available while `must_change_password` is set. User listing, creation, deletion, promotion/demotion and password resets are gated too. Rotation revokes every prior session and issues a new cookie. An upgrade also replaces a still-flagged legacy `admin` / `admin` credential and invalidates its sessions; chosen passwords are preserved. This cannot undo a compromise that happened before upgrading: operators of previously exposed default-password instances must review existing accounts, sessions, settings, and provider credentials.

Retain the local setup log until onboarding is complete. If it is lost, an existing instance admin can reset the password. If none is available, recovery requires trusted local database access; do not delete the meeting database or expose an unauthenticated reset endpoint.

## Authorization

The dashboard is an **instance administration interface**, not a Discord-member portal. There is no mapping between website accounts and Discord identities and no per-guild grants in this model.

- Instance admins may access **all guilds** and their meetings, transcripts, exports, todos, search, statistics and live attendance, and control recordings, retries, configuration, bot/sidecar lifecycle and credentials.
- Non-admin accounts may log in/out, inspect their own session, and change their own password. Every dashboard data/control endpoint denies them. The UI retains the existing Account/password form outside system, guild and live-data providers, alongside the admin-access notice and sign-out control.
- New data/control routes inherit the admin gate at the API router boundary. Missing authentication middleware never implies admin permission. Role changes take effect on the next request, including existing sessions.
- A guild-qualified meeting request must name the meeting's actual guild, even for admins. Merge sources must share the target's guild.
- Meeting Ask requests use the fetched meeting's guild, not the independently selected guild. Saved meeting links, refreshes and selector changes therefore preserve valid admin Ask requests without relaxing server-side mismatch rejection.

Grant admin only to trusted instance operators: it is not a read-only role. Non-admin data access from older versions is intentionally removed. Cookie HttpOnly/SameSite/Secure behavior, same-origin CSRF checks, rate limiting, scrypt, loopback default binding, localhost-only Compose publication, private sidecar networking and the non-root bot runtime remain in place. Use TLS behind a correctly configured trusted reverse proxy for remote access.

Frontend interaction regressions run with `npm --prefix web test` after installing the frontend dependencies. They mount the actual React components and exercise password changes, session rotation, saved-link Ask/refresh/selector transitions, and negative authorization controls against an ephemeral loopback server with in-memory SQLite and the fake summarizer. React test renderer is development-only and matches React 18.3.1; no graphical browser or external service is required. The backend suite remains `npm test`.

## Dependency hardening

Root dependencies were updated within their existing compatible ranges, with the manifest floors for Express and discord.js raised to the tested releases. The lockfile resolves Express 5.3.0, proxy-addr 2.0.8, qs 6.16.1, discord.js 14.27.0 and undici 6.29.1. This addresses the remotely relevant proxy trust/IP-spoofing advisory ([GHSA-jqcg-44mw-7w3h](https://github.com/advisories/GHSA-jqcg-44mw-7w3h)) and the reported HTTP/Discord client advisories.

`@discordjs/opus@0.10.0` depends on `@discordjs/node-pre-gyp@0.4.5`, whose declared tar range is 6.x. A **narrow exact override** pins only that installer's `tar` to 7.5.22. Tar 6 has extraction/path traversal, parser crash, resource-exhaustion and archive-update advisories; see [GHSA-23hp-3jrh-7fpw](https://github.com/advisories/GHSA-23hp-3jrh-7fpw) and [GHSA-r292-9mhp-454m](https://github.com/advisories/GHSA-r292-9mhp-454m). The install path uses the CommonJS `tar.extract({ cwd, strip: 1, onentry })` streaming API; this was exercised through the actual node-pre-gyp local-archive installer with a fake archive. Packaging uses `tar.create`. Node >=22.5 satisfies tar 7's Node >=18 requirement. No native install lifecycle scripts, native compilation, remote binary downloads, or Docker builds were run during this check. The override needs re-evaluation when the Opus installer changes.

The Node dashboard and voice runtime do not expose an archive extraction API; this chain is build/install-time, not a transcript/audio-input archive parser. In Docker, native install runs in the build stage; the final bot remains non-root. Retain trusted dependency sources even after patching.

The final root `npm audit --omit=dev` reports **0 flagged packages at the time of this check**, not a guarantee of zero vulnerabilities. The frontend is separately audited and still has findings.

## Residual frontend advisories

Compatible frontend updates were applied and the production bundle builds. No force upgrades or cross-major framework migrations were made. Final frontend audit: **11 flagged packages (6 high, 5 moderate)** including build/dev dependencies; `--omit=dev`: **2 moderate packages**, `react-router` and its dependent `react-router-dom`, both 6.30.6.

| Dependency chain | Advisory / exposure | Current reachability and decision |
| --- | --- | --- |
| React Router 6.30.6 / react-router-dom | [GHSA-wrjc-x8rr-h8h6](https://github.com/advisories/GHSA-wrjc-x8rr-h8h6): backslash open redirect in Link/useNavigate; [GHSA-337j-9hxr-rhxg](https://github.com/advisories/GHSA-337j-9hxr-rhxg): SSR error hydration constructor injection | Ships in browser JS. App uses BrowserRouter, not SSR hydration. Navigation destinations are fixed local paths, numeric SQLite meeting IDs, or `/search?q=` with encodeURIComponent, not raw external destinations. No current untrusted destination or SSR hydration callsite was found; this is a reachability assessment, not a patched library. Audit recommends a 7.18.x major migration. |
| Tailwind 3.4.19 → chokidar / fast-glob / micromatch → braces 3.0.3 | [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm): stack exhaustion on deeply nested patterns | Build/watch-time parsing of repository-controlled patterns. Not a dashboard API parser and not shipped as executable browser code. No patched braces 3.x is offered by this audit; suggested remediation is Tailwind 4, a CSS/build migration outside this bounded pass. Do not build/watch untrusted repositories or patterns. |
| Tailwind / postcss-nested → postcss-selector-parser 6.1.5 | [GHSA-rj75-hqrm-r3gf](https://github.com/advisories/GHSA-rj75-hqrm-r3gf): quadratic selector parsing | Build-time repository CSS, not meeting/user content. Suggested fix crosses the Tailwind/parser major boundary; no unreviewed parser-major override. |
| Vite 5.4.21 → esbuild | [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99): esbuild dev-server cross-origin reads; Vite dev-server path traversal/deny bypass and launch-editor advisories | Dev tooling only. Production serves static `web/dist` from Express; it does not run Vite/esbuild servers or launch-editor. Never expose development/preview servers or use them as production hosting. Major Vite/plugin migration deferred, not claimed remediated. |

Vite advisory IDs retained in the audit receipt: GHSA-4w7w-66w2-5vf9, GHSA-v6wh-96g9-6wx3, GHSA-fx2h-pf6j-xcff, GHSA-698v-4r3x-3vcv, GHSA-r825-w8mm-5pxw, GHSA-587h-7wmj-h5pm, GHSA-9jrq-w75r-8gcw, GHSA-rq7h-c2jc-7f22. These include Windows-specific editor/path issues as well as cross-platform development-server exposure. Complete advisory URLs, affected ranges, versions and command exits are preserved in the private task evidence. Re-run both root and web audits as advisories evolve.
