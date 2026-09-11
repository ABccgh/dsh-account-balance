window.__ModuleLoader__.load({
	id: "dsh-account-balance",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region dsh-account-balance: styles
		// Every token below already appears in a shipped sidebar-footer occupant
		// (`@deepseek-ai/dsh-client-ui-cordis`), so light, dark, and any future
		// product theme resolve without this plugin knowing about them.
		const css = ".dshBal_badge{box-sizing:border-box;display:flex;align-items:center;gap:6px;min-width:0;max-width:100%;height:28px;padding:0 10px;border:none;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:var(--dsw-font-xs-13);line-height:20px;cursor:pointer}.dshBal_badge:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.dshBal_badge:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}.dshBal_badge[data-state=stale]{color:var(--dsw-alias-label-tertiary)}.dshBal_badge[data-state=unavailable]{color:var(--dsw-alias-state-error-primary)}.dshBal_rail{width:28px;justify-content:center;padding:0}.dshBal_dot{width:6px;height:6px;border-radius:999px;flex:none}.dshBal_dot[data-state=ok]{background:var(--dsw-alias-state-success-primary)}.dshBal_dot[data-state=stale]{background:var(--dsw-alias-label-tertiary)}.dshBal_dot[data-state=unavailable]{background:var(--dsw-alias-state-error-primary)}.dshBal_amount{font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dshBal_details{display:flex;flex-direction:column;gap:4px;font-size:var(--dsw-font-xs-13);line-height:18px}.dshBal_detailRow{display:flex;gap:12px;justify-content:space-between}.dshBal_detailLabel{color:var(--dsw-alias-label-caption)}";
		const tagId = "dsh-account-balance/BalanceBadge.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-account-balance";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion
		//#region dsh-account-balance: locale
		/** Dictionary namespace owned by this plugin; also the `locale` on its slot entry. */
		const NS = "dsh-account-balance";
		const zh = {
			"label.short": "余额",
			"state.loading": "读取余额",
			"state.stale": "余额未更新",
			"state.unavailable": "余额不可用",
			"detail.currency": "币种",
			"detail.total": "可用总额",
			"detail.granted": "赠送余额",
			"detail.toppedUp": "充值余额"
		};
		const en = {
			"label.short": "Balance",
			"state.loading": "Reading balance",
			"state.stale": "Balance not updated",
			"state.unavailable": "Balance unavailable",
			"detail.currency": "Currency",
			"detail.total": "Total available",
			"detail.granted": "Granted",
			"detail.toppedUp": "Topped up"
		};
		//#endregion
		//#region dsh-account-balance: reader
		/** Fallback poll period when the host reports none; the host's own value wins. */
		const DEFAULT_REFRESH_SECONDS = 60;
		/** Consecutive failed polls before a held amount stops reading as current. */
		const UNAVAILABLE_AFTER_FAILURES = 2;
		/** @returns the page's own fetch bound to its realm, or undefined when absent. */
		function readFetch() {
			if (typeof window === "undefined" || typeof window.fetch !== "function") return undefined;
			return window.fetch.bind(window);
		}
		/**
		 * Read one snapshot through the host's authenticated `/api/balance` route.
		 *
		 * The envelope's own `ok` is the oracle rather than the HTTP status, so a
		 * proxy that rewrites statuses still surfaces the reason the host reported.
		 * @param fetchFn - page fetch bound to its realm.
		 * @returns the read outcome.
		 */
		async function readBalance(fetchFn) {
			try {
				const response = await fetchFn("/api/balance", {
					method: "GET",
					credentials: "same-origin",
					headers: { accept: "application/json" },
					cache: "no-store"
				});
				const body = await response.json().catch(() => undefined);
				if (body !== undefined && body !== null && body.ok === true) return { kind: "ok", value: body };
				return {
					kind: "error",
					message: body !== undefined && body !== null && typeof body.message === "string"
						? body.message
						: "HTTP " + String(response.status)
				};
			} catch (error) {
				return { kind: "error", message: error instanceof Error ? error.message : String(error) };
			}
		}
		/**
		 * Poll the host route until the component unmounts.
		 *
		 * A self-rescheduling `setTimeout` rather than an interval, so at most one
		 * read is ever in flight and a slow host cannot stack requests, and the
		 * period comes from the host's own `refreshSeconds`.
		 * @param fetchRef - ref holding the page fetch.
		 * @returns `{ state, refresh }`.
		 */
		function useBalance(fetchRef) {
			const [state, setState] = react.useState({ kind: "loading", failures: 0, refreshSeconds: DEFAULT_REFRESH_SECONDS });
			const [epoch, setEpoch] = react.useState(0);
			const inFlight = react.useRef(false);
			const period = react.useRef(DEFAULT_REFRESH_SECONDS);
			if (typeof state.refreshSeconds === "number" && state.refreshSeconds > 0) period.current = state.refreshSeconds;
			react.useEffect(() => {
				let cancelled = false;
				let timer;
				inFlight.current = false;
				const attempt = async () => {
					const reader = fetchRef.current;
					if (reader === undefined) {
						if (!cancelled) {
							setState((previous) => ({
								...previous,
								kind: "error",
								failures: previous.failures + 1,
								message: "fetch unavailable in this realm"
							}));
						}
						return;
					}
					inFlight.current = true;
					setState((previous) => (previous.kind === "ok" ? { ...previous, kind: "stale" } : previous));
					const outcome = await readBalance(reader);
					inFlight.current = false;
					if (cancelled) return;
					setState((previous) => {
						if (outcome.kind === "ok") {
							const reported = typeof outcome.value.refreshSeconds === "number" && outcome.value.refreshSeconds > 0
								? outcome.value.refreshSeconds
								: previous.refreshSeconds;
							return { kind: "ok", failures: 0, value: outcome.value, refreshSeconds: reported };
						}
						return {
							...previous,
							kind: "error",
							failures: previous.failures + 1,
							last: previous.kind === "ok" ? previous.value : previous.last,
							message: outcome.message
						};
					});
					timer = window.setTimeout(() => { void attempt(); }, period.current * 1000);
				};
				void attempt();
				return () => {
					cancelled = true;
					if (timer !== undefined) window.clearTimeout(timer);
				};
			}, [epoch, fetchRef]);
			const refresh = react.useCallback(() => {
				if (inFlight.current) return;
				setEpoch((value) => value + 1);
			}, []);
			return { state, refresh };
		}
		//#endregion
		//#region dsh-account-balance: presentation
		/**
		 * Pick the displayed amount: the first currency the provider listed, since
		 * the upstream array has no documented sort and this badge is one amount
		 * wide. Every currency stays visible in the tooltip.
		 * @param balances - provider entries.
		 * @returns the chosen entry, or undefined while none exists.
		 */
		function primaryBalance(balances) {
			return Array.isArray(balances) && balances.length > 0 ? balances[0] : undefined;
		}
		/**
		 * @param entry - primary provider entry, or undefined.
		 * @returns the amount text, or the empty string while there is none.
		 */
		function amountText(entry) {
			if (entry === undefined || typeof entry.total !== "string" || entry.total === "") return "";
			return entry.currency === "" ? entry.total : entry.currency + " " + entry.total;
		}
		/**
		 * @param value - any provider string field.
		 * @returns the value, or an em dash while absent.
		 */
		function detailText(value) {
			return typeof value === "string" && value !== "" ? value : "—";
		}
		/** The list-slot key this plugin occupies; its descriptor and its render key. */
		const SLOT_ID = "sidebar.footer.action";
		//#endregion
		//#region dsh-account-balance: BalanceBadge
		/**
		 * Tooltip body: the provider's currency, total, granted, and topped-up
		 * amounts, plus a footer line carrying the local state or the host's reason.
		 * @param entry - primary provider entry, or undefined.
		 * @param t - translate function (the locale seat, or a passthrough).
		 * @param footer - local state or failure text.
		 * @returns the tooltip content element.
		 */
		function detailPanel(entry, t, footer) {
			const source = entry === undefined ? {} : entry;
			const rows = [
				[t("detail.currency"), detailText(source.currency)],
				[t("detail.total"), detailText(source.total)],
				[t("detail.granted"), detailText(source.granted)],
				[t("detail.toppedUp"), detailText(source.toppedUp)]
			];
			return react_jsx_runtime.jsxs("div", {
				className: "dshBal_details",
				children: [
					rows.map((row) => react_jsx_runtime.jsxs("div", {
						className: "dshBal_detailRow",
						children: [
							react_jsx_runtime.jsx("span", { className: "dshBal_detailLabel", children: row[0] }),
							react_jsx_runtime.jsx("span", { children: row[1] })
						]
					}, row[0])),
					react_jsx_runtime.jsx("div", {
						className: "dshBal_detailRow",
						children: react_jsx_runtime.jsx("span", { className: "dshBal_detailLabel", children: footer })
					})
				]
			});
		}
		/**
		 * The sidebar-footer balance badge.
		 *
		 * Owner share is `{ wide }` from the sidebar shell: wide renders the state
		 * dot, the localized label, and the amount; the 56px rail renders the dot
		 * and the amount only. A failed read never clears what is already on screen
		 * — the badge holds the last known amount, marks itself stale, and only
		 * after {@link UNAVAILABLE_AFTER_FAILURES} consecutive failures stops
		 * presenting that amount as current.
		 * @param props - owner share plus the framework's standard seats.
		 * @returns the badge, or null while it has nothing to show and no failure.
		 */
		function BalanceBadge(props) {
			const wide = props.wide !== false;
			// The locale seat arrives as `t`; fall back to a passthrough that keeps
			// the English literals visible rather than the raw keys.
			const t = typeof props.t === "function" ? props.t : (key) => key;
			const fetchRef = react.useRef(undefined);
			if (fetchRef.current === undefined) fetchRef.current = readFetch();
			const { state, refresh } = useBalance(fetchRef);
			const hasAmount = state.kind === "ok" || (state.kind !== "loading" && state.last !== undefined);
			// Nothing read yet and nothing to report: stay out of the foot entirely.
			if (state.kind === "loading" && !hasAmount) return null;
			const unavailable = state.kind === "error" && state.failures >= UNAVAILABLE_AFTER_FAILURES;
			const presentation = state.kind === "ok" ? "ok" : unavailable ? "unavailable" : "stale";
			const entry = hasAmount ? primaryBalance(state.value === undefined ? undefined : state.value.balances) : undefined;
			const amount = hasAmount ? amountText(entry) : "";
			const localState = state.kind === "ok"
				? ""
				: state.kind === "loading"
					? t("state.loading")
					: unavailable
						? t("state.unavailable")
						: t("state.stale");
			const footer = state.kind === "error" && typeof state.message === "string" && state.message !== ""
				? localState + " · " + state.message
				: localState;
			const accessible = presentation === "ok" && amount !== ""
				? t("label.short") + " " + amount
				: localState + (amount === "" ? "" : " · " + amount);
			const text = amount === "" ? t("label.short") : t("label.short") + " " + amount;
			return react_jsx_runtime.jsx(primitives.Tooltip, {
				label: detailPanel(entry, t, footer),
				side: "right",
				delayMs: 120,
				maxWidth: 260,
				children: react_jsx_runtime.jsxs(primitives.Pill, {
					className: "dshBal_badge" + (wide ? "" : " dshBal_rail"),
					onClick: refresh,
					"data-balance": "true",
					"data-state": presentation,
					"aria-label": accessible,
					title: accessible,
					children: [
						react_jsx_runtime.jsx("span", { className: "dshBal_dot", "data-state": presentation }),
						wide ? react_jsx_runtime.jsx("span", { className: "dshBal_amount", children: text }) : null
					]
				})
			});
		}
		//#endregion
		//#region dsh-account-balance: plugin
		/**
		 * Required client services.
		 *
		 * `slots` and ONLY `slots`. Every name here is a cordis service the fiber
		 * WAITS for, and a client entry that never reaches `active` fails the whole
		 * page (`web boot: N entries did not activate`), so the set is kept to the
		 * one service this plugin reads. `locale` is deliberately not declared: it
		 * is read through `ctx.get` and its absence only costs the Chinese
		 * dictionary, not the badge.
		 */
		const inject = ["slots"];
		/**
		 * Client plugin body: register the footer-action occupant.
		 *
		 * `slots.inject` waits for the declaration instead of assuming activation
		 * order — the sidebar declares `sidebar.footer.action` while this plugin may
		 * activate before or after it.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			const locale = ctx.get("locale");
			if (locale !== undefined && typeof locale.register === "function") {
				ctx.effect(() => locale.register(NS, "zh", zh), "dsh-account-balance: zh dictionary");
				ctx.effect(() => locale.register(NS, "en", en), "dsh-account-balance: en dictionary");
			}
			ctx.slots.inject(SLOT_ID, () => ctx.slots.register({
				name: SLOT_ID,
				id: "dsh-account-balance",
				order: 20,
				label: "余额",
				locale: NS
			}, BalanceBadge));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.BalanceBadge = BalanceBadge;
		return module.exports;
	}
});
