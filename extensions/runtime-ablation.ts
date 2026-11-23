/**
 * runtime-ablation — per-session switch for inference runtimes that apply an
 * ablation ("heretic") direction correction at request time.
 *
 * The runtime accepts one extra request body field:
 *
 *   "ablation": {"enabled": true, "strength": 1.0,
 *                "direction_set": "<set-name>",
 *                "layers": [2, 3]}          // layers optional: runtime default
 *
 * Without it the engine runs the plain model (OFF). The engine may echo the
 * applied correction in the response body; Pi does not show it.
 *
 * Because the field has to be present on every request, it is attached in
 * `before_provider_request` rather than once at conversation start.
 *
 * Usage
 *   /ablation              show current mode (or pick one, in the TUI)
 *   /ablation off          plain model
 *   /ablation half         0.5 — half of the correction
 *   /ablation full         1.0 — the full correction as calibrated
 *   /ablation 0.35         any strength in 0..1
 *   /ablation layers 2,3   restrict the correction to those layers
 *   /ablation layers off   back to the default layer set (2-39)
 *
 * State is per session, stored as a custom session entry so branching and
 * resume keep the mode that was active on that branch.
 *
 * Configure with the ABLATION_* environment variables (see README); nothing
 * below is tied to a particular deployment.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Provider id to target. Empty = any provider (the model match decides). */
const PROVIDER = process.env.ABLATION_PROVIDER ?? "";
/** Substring of the model id that accepts the correction. */
const MODEL_MATCH = process.env.ABLATION_MODEL ?? "deepseek-v4.1-flash-tp2-exl3";
/** Direction set name the runtime expects; must match its configuration exactly. */
const DIRECTION_SET = process.env.ABLATION_SET ?? "pqhaz-1017-projected-experimental";
/**
 * Multiplier applied to the client strength before it is sent. This build already
 * folds the author's 0..2.5 calibration in (client 1.0 = published strength 2.5),
 * so 1 is correct here; raise it only for a runtime that expects the raw author
 * scale, and only if that runtime does not scale on its own.
 */
const SCALE = positiveNumber(process.env.ABLATION_SCALE, 1);
/** Layers the correction covers unless the user narrows them. */
const DEFAULT_LAYERS = parseLayers(process.env.ABLATION_LAYERS ?? "2-39");
/** Strength for a session with no saved choice (0 = off). */
const DEFAULT_STRENGTH = Number(process.env.ABLATION_DEFAULT ?? 0);
const ENTRY_TYPE = "runtime-ablation";
const STATUS_KEY = "runtime-ablation";

interface State {
	/** 0 = off, otherwise 0..1 */
	strength: number;
	/** which layers to correct; defaults to ABLATION_LAYERS (2-39) */
	layers: number[];
}

const INITIAL: State = {
	strength: Number.isFinite(DEFAULT_STRENGTH) ? Math.min(1, Math.max(0, DEFAULT_STRENGTH)) : 0,
	layers: DEFAULT_LAYERS,
};
let state: State = { ...INITIAL };

function positiveNumber(raw: string | undefined, fallback: number): number {
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

function formatLayers(layers: number[]): string {
	if (!layers.length) return "all layers";
	const sorted = [...new Set(layers)].sort((a, b) => a - b);
	const parts: string[] = [];
	let start = sorted[0];
	let prev = sorted[0];
	for (const n of sorted.slice(1)) {
		if (n === prev + 1) {
			prev = n;
			continue;
		}
		parts.push(start === prev ? `${start}` : `${start}-${prev}`);
		start = n;
		prev = n;
	}
	parts.push(start === prev ? `${start}` : `${start}-${prev}`);
	return `L${parts.join(",")}`;
}

function statusText(s: State): string {
	if (s.strength <= 0) return "ablation off";
	return `ablation ${s.strength} · ${formatLayers(s.layers)}`;
}

function applies(ctx: ExtensionContext): boolean {
	const model = ctx.model;
	if (!model) return false;
	if (PROVIDER && model.provider !== PROVIDER) return false;
	return model.id.toLowerCase().includes(MODEL_MATCH.toLowerCase());
}

function parseLayers(text: string): number[] {
	const out = new Set<number>();
	for (const part of text.split(",")) {
		const chunk = part.trim();
		if (!chunk) continue;
		const range = /^(\d+)\s*-\s*(\d+)$/.exec(chunk);
		if (range) {
			const a = Number(range[1]);
			const b = Number(range[2]);
			for (let n = Math.min(a, b); n <= Math.max(a, b); n++) out.add(n);
			continue;
		}
		const n = Number(chunk);
		if (Number.isFinite(n)) out.add(n);
	}
	return [...out].filter((n) => Number.isInteger(n) && n >= 0).sort((a, b) => a - b);
}

function persist(pi: ExtensionAPI): void {
	pi.appendEntry<State>(ENTRY_TYPE, state);
}

function restore(ctx: ExtensionContext): State {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i] as { type?: string; customType?: string; data?: State };
		if (entry?.type === "custom" && entry.customType === ENTRY_TYPE && entry.data) {
			const data = entry.data as State;
			return {
				strength: Number(data.strength) || 0,
				layers: Array.isArray(data.layers) ? data.layers : DEFAULT_LAYERS,
			};
		}
	}
	return { ...INITIAL };
}

function report(ctx: ExtensionContext): void {
	ctx.ui.setStatus(STATUS_KEY, applies(ctx) ? statusText(state) : undefined);
}

function ablationField(s: State) {
	return {
		enabled: s.strength > 0,
		strength: s.strength * SCALE,
		...(DIRECTION_SET ? { direction_set: DIRECTION_SET } : {}),
		...(s.layers.length ? { layers: s.layers } : {}),
	};
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		state = restore(ctx);
		report(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		report(ctx);
	});

	// Every model request: attach the field only for the matching model.
	pi.on("before_provider_request", (event, ctx) => {
		if (!applies(ctx)) return;
		const payload = event.payload as Record<string, unknown> | null;
		if (!payload || typeof payload !== "object") return;
		if (state.strength > 0) payload.ablation = ablationField(state);
		else delete payload.ablation;
		return payload;
	});

	pi.registerCommand("ablation", {
		description: "Runtime-direction correction: off | half | full | <strength> | layers <ids|off>",
		getArgumentCompletions: (prefix: string) => {
			const options = ["off", "half", "full", "0.25", "0.5", "1", "layers"];
			return options.filter((o) => o.startsWith(prefix)).map((o) => ({ value: o, label: o }));
		},
		handler: async (args, ctx) => {
			const text = args.trim();
			if (!applies(ctx)) {
				ctx.ui.notify(
					`This model does not take runtime directions (need a model id containing "${MODEL_MATCH}").`,
					"warning",
				);
				return;
			}

			if (!text) {
				if (!ctx.hasUI) {
					ctx.ui.notify(statusText(state), "info");
					return;
				}
				const choice = await ctx.ui.select("Runtime directions", [
					"off (plain model)",
					"half (0.5, all layers)",
					"full (1.0, all layers)",
					"layers… (only some layers)",
				]);
				if (!choice) return;
				if (choice.startsWith("off")) state = { strength: 0, layers: DEFAULT_LAYERS };
				else if (choice.startsWith("half")) state = { strength: 0.5, layers: DEFAULT_LAYERS };
				else if (choice.startsWith("full")) state = { strength: 1, layers: DEFAULT_LAYERS };
				else {
					const typed = await ctx.ui.input("Layers", "e.g. 2,3 or 2-12 (empty = runtime default)");
					if (typed === undefined) return;
					const layers = parseLayers(typed);
					state = { strength: state.strength > 0 ? state.strength : 0.5, layers: layers.length ? layers : DEFAULT_LAYERS };
				}
				persist(pi);
				report(ctx);
				ctx.ui.notify(statusText(state), "info");
				return;
			}

			const lower = text.toLowerCase();
			if (lower === "off" || lower === "0" || lower === "none") state = { strength: 0, layers: DEFAULT_LAYERS };
			else if (lower === "on" || lower === "half") state = { strength: 0.5, layers: state.layers };
			else if (lower === "full") state = { strength: 1, layers: state.layers };
			else if (lower.startsWith("layers")) {
				const spec = text.slice("layers".length).trim();
				const parsed = /^off$/i.test(spec) ? [] : parseLayers(spec);
				state = { strength: state.strength > 0 ? state.strength : 0.5, layers: parsed.length ? parsed : DEFAULT_LAYERS };
			} else {
				const value = Number(text);
				if (!Number.isFinite(value) || value < 0 || value > 1) {
					ctx.ui.notify("Use off | half | full | 0..1 | layers <ids|off>", "warning");
					return;
				}
				state = { strength: value, layers: state.layers };
			}

			persist(pi);
			report(ctx);
			ctx.ui.notify(statusText(state), "info");
		},
	});
}
