# OpenCode + Ollama for GeckIt

Independent GeckIt assistant library for Ollama models through OpenCode. Owns an authenticated loopback `opencode serve` process. Native OpenCode history remains available in the terminal and survives GeckIt restarts.

## Setup

Install [OpenCode](https://opencode.ai/docs/) and [Ollama](https://docs.ollama.com/), then start Ollama with a text model available. Put `opencode` on the PATH visible to GeckIt. `GECKIT_OPENCODE_BIN` can select an absolute executable path. The library detects OpenCode 1 or 2 and uses the matching HTTP protocol; native verification covers **1.18.35 and 2.0.25**.

OpenCode 2 discovers available Ollama models automatically. The existing GeckIt **Model** selector shows the enabled Ollama catalog, including Qwen, Gemma, Kimi and Llama. The first request waits for discovery to finish. Select a model there for each conversation; **Default** uses OpenCode's default when it belongs to Ollama, otherwise the first available Ollama model. Other providers are excluded. A removed selection reports an error instead of silently substituting another model.

For OpenCode 1, merge an Ollama provider into your existing `opencode.json` or `opencode.jsonc` without overwriting existing settings:

```json
{
  "model": "ollama/qwen3:8b",
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama",
      "options": { "baseURL": "http://127.0.0.1:11434/v1" },
      "models": { "qwen3:8b": { "name": "Qwen 3 8B" } }
    }
  }
}
```

Choose a model with tool support for coding tasks. Capacity is displayed only when OpenCode reports it. Credentials stay in OpenCode and Ollama. This library stores no keys, downloads no models and changes no global configuration. Ollama models ending in `:cloud` use Ollama's cloud service; their presence in the picker does not imply local inference. See [OpenCode's Ollama setup](https://opencode.ai/docs/providers/#ollama).

## Install or update in GeckIt

Open **Settings > Libraries > Add library** and paste:

```text
https://github.com/anetrebskii/geckit-opencode-llama
```

Enable **OpenCode + Ollama** in **Settings > Assistants**, select it for a new task, then choose a model in **Model**. For an existing installation, use **Settings > Libraries > Check now > Apply update**, then reopen the new-task dialog. The repository name and plugin/session IDs remain stable so existing installations and conversations continue to work.

The repository includes `geckit-plugin.json` and a prebuilt `index.mjs` at its root. GeckIt installs without running npm or build scripts. OpenCode and Ollama must be installed separately.

## Behavior

- Streams text, reasoning and tool activity, including incremental text updates.
- Supports approval replies and questions with several question cards, including OpenCode 2 question forms. Each card submits one selected label or a custom answer; multi-select questions currently accept one selection per card. Other form types report an explicit unsupported-form error.
- **Manual** asks before tools run. Allow for session remembers matching permission patterns only for that conversation until the library unloads; native replies remain once so other conversations cannot inherit the grant. **Plan** uses OpenCode's plan agent and denies editing tools and shell execution. **Auto** runs as Manual; the library does not offer an automatic safety reviewer.
- Native listing includes OpenCode sessions in each exact project folder, including terminal sessions and sessions originally using another model. Follow-up messages use the Ollama model selected in GeckIt. Search, read, rename, fork, links and deletion use native OpenCode history. Deleting a conversation removes it from OpenCode too.
- Stop cancels the current generation; another message can follow. Unloading stops owned drivers and server. No other OpenCode server is reused or stopped.
- Reports context and costs from OpenCode. Costs are API-equivalent estimates, not a verified bill; unknown quotas remain omitted. Metadata reflects OpenCode's model catalog.
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

No runtime dependencies; esbuild bundles local sources into the committed `index.mjs`. Importing the entry and calling `create()` do not launch processes or make requests, so GeckIt can validate an update alongside the loaded library.

Deterministic tests cover the provider contract, namespace round trips, all Ollama model families, selection/defaults, catalog readiness, metadata, unknown quotas, streaming, approvals/questions, cancellation, startup/model/stream failures, native history, folder isolation, fork cutoff, correction and instruction cleanup. Native tests pass with OpenCode 1.18.35 and 2.0.25 using a non-Llama model served by an isolated mock. The actual Ollama catalog was read without inference. Model quality, hardware performance and installed-library desktop/phone visual review remain unverified.

Protocol references: [server API](https://opencode.ai/docs/server/), [current generated schemas](https://github.com/anomalyco/opencode/tree/dev/packages/sdk/js/src/v2). This adapter was independently written for GeckIt; no OpenCode runtime source was copied. License: [MIT](LICENSE).
