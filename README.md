# OpenCode (Llama) for GeckIt

Independent GeckIt assistant library for configured Llama models through OpenCode. Owns an authenticated loopback `opencode serve` process. Native OpenCode history remains available in the terminal and survives GeckIt restarts.

## Setup

Install [OpenCode](https://opencode.ai/docs/) and put `opencode` on the PATH visible to GeckIt. `GECKIT_OPENCODE_BIN` can select an absolute executable path. The library detects OpenCode 1 or 2 and uses the matching HTTP protocol. Native verification covers **1.18.35 and 2.0.25**. Older releases may lack the required permission/question events.

For local Llama, install [Ollama](https://docs.ollama.com/), start its server, then pull a model:

```sh
ollama pull llama3.1:8b
```

Merge the provider configuration below into your existing `opencode.json` or `opencode.jsonc`. Do not overwrite an existing configuration. Set the default `model` if you want this Llama model to be OpenCode's default too.

```json
{
  "model": "ollama/llama3.1:8b",
  "providers": {
    "ollama": {
      "package": "@opencode/ai/providers/openai-compatible",
      "name": "Ollama (local)",
      "settings": { "baseURL": "http://127.0.0.1:11434/v1" },
      "models": {
        "llama3.1:8b": { "name": "Llama 3.1 8B" }
      }
    }
  }
}
```

This is OpenCode 2 configuration. For OpenCode 1, use `provider` instead of `providers`, `npm: "@ai-sdk/openai-compatible"` instead of `package`, and `options` instead of `settings`.

Only connected models whose ID or name contains `llama` appear in GeckIt. Choose a model that supports tool calls for coding tasks. Configure a context size supported by your runtime and hardware in both Ollama and OpenCode; capacity is displayed only when OpenCode reports it. See [OpenCode's local-provider setup](https://opencode.ai/docs/providers/#ollama).

For llama.cpp, use your `llama-server` OpenAI-compatible URL, usually `http://127.0.0.1:8080/v1`, and the model ID that server exposes. For hosted Llama, configure and authenticate the provider in OpenCode, then choose its Llama model explicitly. Credentials stay in OpenCode; this library stores no keys and never downloads models or changes global configuration.

## Install in GeckIt

Open **Settings > Libraries > Add library** and paste:

```text
https://github.com/anetrebskii/geckit-opencode-llama
```

Enable **OpenCode (Llama)** in **Settings > Assistants**, choose **Llama** in the composer, then select a configured model. OpenCode and the model server must be installed separately.

The repository includes `geckit-plugin.json` and a prebuilt `index.mjs` at its root. GeckIt installs the library without running npm or build scripts. For an existing installation, update the library in **Settings > Libraries**.

## Behavior

- Streams text, reasoning and tool activity, including incremental text updates.
- Supports approval replies and questions with several question cards, including OpenCode 2 question forms. Each card submits one selected label or a custom answer; multi-select questions currently accept one selection per card. Other form types report an explicit unsupported-form error.
- **Manual** asks before tools run. Allow for session remembers matching permission patterns only for that conversation until the library unloads; native replies remain once so other conversations cannot inherit the grant. **Plan** uses OpenCode's plan agent and denies editing tools and shell execution. **Auto** runs as Manual; the library does not offer an automatic safety reviewer.
- Native listing includes OpenCode sessions in each exact project folder, including terminal sessions and sessions originally using another model. Follow-up messages use the Llama model selected in GeckIt. Search, read, rename, fork, links and deletion use native OpenCode history. Deleting a conversation removes it from OpenCode too.
- Stop cancels the current generation; another message can follow. Unloading stops owned drivers and server. No other OpenCode server is reused or stopped.
- Reports context and costs from OpenCode. Costs are API-equivalent estimates, not a verified bill; unknown quotas remain omitted. Metadata reflects OpenCode's configured model catalog.
- GeckIt instruction switch adds an owned system prompt on subsequent messages; disabling it removes that prompt. OpenCode 2 stores it as a session-owned instruction entry. Project instruction files are untouched.
- Text correction uses a temporary native session with all tools denied, then removes it.
- Image input, native goals, remote control, SSH execution and browser selection are unavailable. Existing MCP status and connect/disconnect controls use OpenCode.

## Development and checks

Node 22+:

```sh
npm ci
npm run build
npm test
# Optional: real OpenCode server with an isolated local mock model, no paid calls
npm run test:native
```

No runtime dependencies; esbuild bundles local sources into the committed `index.mjs`. Importing the entry and calling `create(host)` do not launch processes or make requests, so GeckIt can validate an update alongside the loaded library.

Deterministic tests use fake process and HTTP/SSE transports. They cover the provider contract, namespace round trips, models/prices, unknown quotas, streaming, approvals/questions, cancellation, startup/model/stream failures, native history, folder isolation, fork cutoff, correction and instruction cleanup. The native smoke test passed with OpenCode 1.18.35, including streamed replies, a read-tool approval and read/list/search/rename/fork/delete. Native Llama inference and installed-library desktop/phone visual review require the setup above; mock-model verification does not establish model quality or hardware performance.

Protocol references: [server API](https://opencode.ai/docs/server/), [current generated schemas](https://github.com/anomalyco/opencode/tree/dev/packages/sdk/js/src/v2). This adapter was independently written for GeckIt; no OpenCode runtime source was copied. License: [MIT](LICENSE).
