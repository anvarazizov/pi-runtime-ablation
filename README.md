# pi-runtime-ablation

Per-session switch for an inference runtime that applies an **ablation ("heretic")
direction correction at request time** — the model refuses less, and no separate weight
copy is needed. This is an optional extra request field, not a fork of the model.

The extension attaches the field to every request for the matching model, and adds an
`/ablation` command plus a footer status line.

```json
"ablation": {"enabled": true, "strength": 1.0,
             "direction_set": "<set-name>",
             "layers": [2, 3]}
```

`layers` is optional (default: whatever the runtime uses). An absent field means the plain
model. It has to be sent on **every** request — server-side chat state does not remember it —
which is why it is attached in `before_provider_request`, not once at conversation start.

## Install

```bash
pi install ./pi-runtime-ablation            # from a local checkout
pi install git:github.com/anvarazizov/pi-runtime-ablation@v0.1.0
```

If you also keep a copy in `~/.pi/agent/extensions/`, remove it — two copies register
`/ablation` twice.

## Configure

For the [TensorFold TP2 recipe](https://github.com/anvarazizov/tensorfold-tp2-directions), set `ABLATION_MODEL` to the served model ID before launching Pi.

Defaults are the calibrated deployment — a DeepSeek V4.1 Flash build serving
`deepseek-v4.1-flash-tp2-exl3` with the `pqhaz-1017-projected-experimental` directions on layers 2–39.
Nothing has to be set for that; the variables exist only to retarget the package.

| Variable | Default | Meaning |
|---|---|---|
| `ABLATION_MODEL` | `deepseek-v4.1-flash-tp2-exl3` | substring of the model id that accepts the correction |
| `ABLATION_SET` | `pqhaz-1017-projected-experimental` | direction-set name the runtime expects; must match its configuration |
| `ABLATION_LAYERS` | `2-39` | layer set the correction covers by default; `/ablation layers off` returns here |
| `ABLATION_SCALE` | `1` | multiplier applied to the client strength before sending (see below) |
| `ABLATION_PROVIDER` | *(any)* | provider id to target; set it if several providers serve the same model id |
| `ABLATION_DEFAULT` | `0` | strength for new sessions; `1` starts every session at full correction |

Example for a different runtime in a shell profile:

```bash
export ABLATION_MODEL=my-model
export ABLATION_SET=my-directions-set
export ABLATION_LAYERS=1-28
```

## Use

| Command | Effect |
|---|---|
| `/ablation` | show state, or pick interactively |
| `/ablation off` | plain model |
| `/ablation full` | 1.0 — the full correction |
| `/ablation half` | 0.5 — half of it |
| `/ablation 0.35` | any strength in 0…1 |
| `/ablation layers 2,3` | restrict the correction to those layers |
| `/ablation layers off` | back to the default layer set (2–39) |

The current mode sits in the footer (`ablation 1 · L2-39`). State is per session: it
is stored as a custom session entry, so branches and resumed sessions keep the mode that was
active on that branch.

## Strength scale

The client-facing scale is 0…1, where 1.0 means "the correction as calibrated" and 0.35
means "a third of it". In this build the runtime already folds the author's 0…2.5 calibration
in: client `1.0` is the published strength 2.5, `0.5` is half of that, and the engine applies
the multiplier itself. So the value is sent verbatim and `ABLATION_SCALE` stays at `1`.

Set `ABLATION_SCALE` only for a runtime that expects the raw author scale and does not scale
on its own — e.g. `ABLATION_SCALE=2.5` sends `0…2.5` while the command line still takes
`0…1`. Do not set it for this build, or the multiplier is applied twice.

Calibrate by the refusal rate on your own prompts, not by the number: start at 1.0, then
step down to 0.5 / 0.25 if answers get terse or repetitive.

## Limits

- The field only exists on the chat-completions route. If the runtime rejects it on other
  routes (`/v1/responses`, `/v1/messages`), a gateway that fails closed returns 400 — use a
  model entry with `api: "openai-completions"`.
- Prefix caching may be mode-bound: a prompt warmed with the correction OFF may not hit for
  ON. Expect a slower first token after toggling.
- The correction removes the tendency to refuse; it does not add knowledge, and it does not
  guarantee accuracy on long answers.
