# Contributing

Thanks for improving `pi-cursor`.

## Before opening an issue

- Search existing issues first.
- Do not report security vulnerabilities in public issues; follow [SECURITY.md](SECURITY.md).
- Include the Pi version, package version, operating system, selected model, and sanitized `/cursor.doctor` output when reporting a bug.

## Development setup

Requires [Bun](https://bun.com) >= 1.4.0 (package manager, script runner, test runner, bundler).
No Node.js binary is needed — all HTTP/2 transport runs in-process via `node:http2`, which Bun
implements natively.

```bash
bun install
bun run check
```

`bun run check` runs TypeScript, oxlint, the repository security checks, the
protobuf staleness check, and the unit tests. Run it before opening a pull request.

## Smoke testing

```bash
bun run smoke:auth         # Interactive browser sign-in
bun run smoke:models       # Model discovery RPC
bun run smoke:stream       # HTTP/2 streaming
bun run smoke:wire         # Low-level wire protocol frames
bun run smoke:pi-grok      # End-to-end Pi streaming with Grok
bun run smoke:pi-opus      # End-to-end Pi streaming with Opus 5.5
bun run smoke:pi-firstmate # Pi streaming with a Firstmate watcher extension
bun run smoke:gate         # Unattended smokes with individual verdicts
```

The Pi smokes resolve credentials through the [authentication cascade](README.md#authentication) and log the credential source without printing the token. Their Pi subprocesses inherit the environment and remain subject to the model-selection requirements documented there. The standalone models, stream, and wire smokes require `CURSOR_ACCESS_TOKEN` in their environment; `smoke:gate` supplies its resolved token to each leg through that variable.

`smoke:pi-grok` prefers a live Grok 4.7 id from the provider catalog and falls back to Grok 4.6. `smoke:pi-opus` selects Opus 5.5 from the live catalog and fails if it is unavailable or the requested thinking level is unsupported. Both build `dist/`, run `pi --print --mode json` with only this extension loaded, and assert a non-empty streamed reply on `provider=cursor` / `api=cursor-native` plus a `bridge_close` for every `stream_start` in the lifecycle log.

Both support `CURSOR_SMOKE_THINKING` (default `low`), `CURSOR_SMOKE_PROMPT`, `CURSOR_SMOKE_TIMEOUT_MS`, and `PI_BIN`. `CURSOR_SMOKE_MODEL` overrides Grok selection only; it cannot redirect the Opus smoke.

`smoke:pi-firstmate` loads `.pi/extensions/fm-primary-pi-watch.ts` from `CURSOR_SMOKE_FIRSTMATE` and checks the lifecycle log's `toolNames` for `bash` and `fm_watch_arm_pi`. `FM_HOME` is a temp dir, so the smoke does not write Firstmate state into that checkout.

`smoke:gate` runs the legs defined in [`scripts/smoke-gate.ts`](scripts/smoke-gate.ts) sequentially and SIGKILLs each at its deadline. It exits 0 if all passed, 1 if a leg failed, or 3 if nothing failed but a leg could not run. A quota-exhausted plan or a `resource_exhausted` refusal reports the affected Pi legs as NOT-RUN, never PASS; `smoke:auth` is excluded because it needs an interactive sign-in. `.no-mistakes.yaml` runs the smoke gate as a custom gate after lint (no-mistakes ≥ v1.74.0; gates are read from the default branch only).

## Generated code

`src/proto/agent_pb.ts` is generated from `proto/agent.proto` — never edit it by hand.
Change the `.proto` and run `bun run proto:gen`; `bun run proto:check` fails the build if
the two drift apart. See [`proto/README.md`](proto/README.md), which also covers how to
recover the `.proto` when you only have an updated generated file from upstream.

## Pull requests

1. Fork the repository and create a focused branch.
2. Keep changes small and explain their user impact.
3. Add or update tests when behavior changes.
4. Update documentation when commands, authentication, configuration, or models change.
5. Ensure `bun run check` passes.

Do not include credentials, access tokens, refresh tokens, OAuth client secrets, or private account data in commits, issues, pull requests, or logs.

## Versioning

[Changesets](https://changesets.dev/). Behavior PRs: `bun run changeset` and commit `.changeset/<id>.md`. Infra-only: skip. Do not bump `package.json` by hand.

## Releases

Pending changesets on `main` open a `chore: version packages` PR. Merging that PR tags `vX.Y.Z` and dispatches `publish.yml`, which publishes to npm with OIDC (trusted publisher workflow filename must stay `publish.yml`). Other changeset-free pushes to `main` do not publish. Contributors must not publish the package or modify release credentials.
