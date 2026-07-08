    const state = { selectedRun: null, data: null, activeWatchlist: "chart_next", selectedKey: null, sortKey: null, sortDir: "desc", density: "comfortable", theme: "dark" };
    const PREFS_KEY = "tape.prefs";
    const SORT_COLUMNS = {
      symbol: { field: "symbol", type: "string" },
      setup: { field: "setup", type: "string" },
      score: { field: "score", type: "numeric" },
      quality: { field: "quality", type: "numeric" },
      price: { field: "price_change_24h_pct", type: "numeric" },
      oi: { field: "oi_change_24h_pct", type: "numeric" },
      funding: { field: "funding_rate_pct", type: "numeric" },
      ls: { field: "positioning_ratio", type: "numeric" },
      volume: { field: "quote_volume_usd", type: "numeric" },
      source: { field: "data_source", type: "string" },
    };
    const $ = (id) => document.getElementById(id);
    const esc = (value) => String(value ?? "-").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const clsFor = (value) => Number(value || 0) > 0 ? "text-up" : Number(value || 0) < 0 ? "text-down" : "";
    function loadPrefs() {
      try {
        const prefs = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
        if (prefs.theme === "light" || prefs.theme === "dark") state.theme = prefs.theme;
        if (prefs.density === "compact" || prefs.density === "comfortable") state.density = prefs.density;
        if (typeof prefs.sortKey === "string" && SORT_COLUMNS[prefs.sortKey]) state.sortKey = prefs.sortKey;
        if (prefs.sortDir === "asc" || prefs.sortDir === "desc") state.sortDir = prefs.sortDir;
      } catch (error) { /* ignore malformed prefs */ }
    }
    function persistPrefs() {
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify({
          theme: state.theme,
          density: state.density,
          sortKey: state.sortKey,
          sortDir: state.sortDir,
        }));
      } catch (error) { /* storage unavailable */ }
    }
    function applyTheme() {
      const root = document.documentElement;
      if (state.theme === "light") root.setAttribute("data-theme", "light");
      else root.setAttribute("data-theme", "dark");
      const btn = $("themeToggle");
      if (btn) btn.textContent = state.theme === "light" ? "Dark" : "Light";
    }
    function applyDensity() {
      const table = $("watchTable");
      if (table) table.setAttribute("data-density", state.density);
      const btn = $("densityToggle");
      if (btn) btn.textContent = state.density === "compact" ? "Compact" : "Comfortable";
    }
    const reasonTooltip = "Read left to right: 24h price move, OI positioning change, funding, L/S crowding, weighted factor score, confidence, 4h technical context, then the strongest normalized factor drivers. Green is positive, red is negative. Crowding and excluded notes are context flags, not automatic trade instructions.";

    function fmtNum(value, digits = 2) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
      return Number(value).toFixed(digits);
    }
    function fmtPct(value, digits = 2) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
      const n = Number(value);
      return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
    }
    function fmtRate(value, digits = 1) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
      return `${Number(value).toFixed(digits)}%`;
    }
    function fmtUsd(value) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
      const n = Number(value);
      const a = Math.abs(n);
      if (a >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
      if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
      if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
      if (a >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
      return `$${n.toFixed(2)}`;
    }
    function metric(label, value, klass = "") {
      return `<article class="bg-panel border border-line rounded-md min-h-[86px] p-3"><div class="text-muted text-[11px] leading-tight uppercase tracking-wider">${esc(label)}</div><div class="font-mono tabular-nums text-xl font-extrabold mt-2 leading-tight break-words ${klass || "text-ink"}">${esc(value)}</div></article>`;
    }
    function panel(title, count, body) {
      return `<div class="flex justify-between items-center gap-2 min-h-[42px] px-3 py-2.5 border-b border-line bg-panel-2"><h2 class="m-0 text-xs font-semibold uppercase tracking-wide">${esc(title)}</h2><span class="text-muted text-xs font-mono tabular-nums">${esc(count)}</span></div>${body}`;
    }
    function reasonHelp() {
      return `<span class="help-tip" tabindex="0" aria-label="${esc(reasonTooltip)}" data-tooltip="${esc(reasonTooltip)}">?</span>`;
    }
    let tooltipEl = null;
    function ensureTooltip() {
      if (!tooltipEl) {
        tooltipEl = document.createElement("div");
        tooltipEl.className = "tooltip-popover";
        tooltipEl.setAttribute("role", "tooltip");
        tooltipEl.hidden = true;
        document.body.appendChild(tooltipEl);
      }
      return tooltipEl;
    }
    function showTooltip(target) {
      const text = target?.getAttribute("data-tooltip");
      if (!text) return;
      const tip = ensureTooltip();
      tip.textContent = text;
      tip.hidden = false;
      tip.style.visibility = "hidden";
      tip.style.left = "0px";
      tip.style.top = "0px";
      requestAnimationFrame(() => {
        const margin = 12;
        const targetRect = target.getBoundingClientRect();
        const tipRect = tip.getBoundingClientRect();
        const left = Math.min(
          window.innerWidth - tipRect.width - margin,
          Math.max(margin, targetRect.left + (targetRect.width / 2) - (tipRect.width / 2))
        );
        let top = targetRect.bottom + 8;
        if (top + tipRect.height + margin > window.innerHeight) {
          top = targetRect.top - tipRect.height - 8;
        }
        tip.style.left = `${Math.max(margin, left)}px`;
        tip.style.top = `${Math.max(margin, top)}px`;
        tip.style.visibility = "visible";
      });
    }
    function hideTooltip() {
      if (tooltipEl) {
        tooltipEl.style.visibility = "hidden";
        tooltipEl.hidden = true;
      }
    }
    function tooltipTarget(event) {
      return event.target instanceof Element ? event.target.closest(".help-tip") : null;
    }
    document.addEventListener("pointerover", (event) => {
      const target = tooltipTarget(event);
      if (target) showTooltip(target);
    });
    document.addEventListener("pointerout", (event) => {
      const target = tooltipTarget(event);
      if (target && !target.contains(event.relatedTarget)) hideTooltip();
    });
    document.addEventListener("focusin", (event) => {
      const target = tooltipTarget(event);
      if (target) showTooltip(target);
    });
    document.addEventListener("focusout", (event) => {
      if (tooltipTarget(event)) hideTooltip();
    });
    document.addEventListener("scroll", hideTooltip, true);
    window.addEventListener("resize", hideTooltip);
    function fallbackReasonParts(reason) {
      return String(reason || "").split(";").map((part) => part.trim()).filter(Boolean).map((part) => ({
        label: "Note",
        value: part,
        tone: "neutral",
        kind: "metric",
      }));
    }
    function reasonView(row) {
      const parts = Array.isArray(row.reason_parts) && row.reason_parts.length ? row.reason_parts : fallbackReasonParts(row.reason);
      if (!parts.length) return "-";
      return `<div class="reason-stack" title="${esc(row.reason || "")}">${parts.map((part) => `
        <span class="reason-part ${esc(part.kind || "metric")} ${esc(part.tone || "neutral")}" title="${esc(part.help || "")}">
          <span>${esc(part.label)}</span><strong>${esc(part.value)}</strong>
        </span>
      `).join("")}</div>`;
    }
    function sourceTags(source) {
      return String(source || "-").split("+").map((part) => part.trim()).filter(Boolean).map((part) => (
        `<span class="source-tag">${esc(part)}</span>`
      )).join("");
    }
    function tradingViewExchange(exchange) {
      const key = String(exchange || "").toLowerCase();
      const map = {
        binance: "BINANCE",
        okx: "OKX",
        bybit: "BYBIT",
        bitget: "BITGET",
        gate: "GATEIO",
        hyperliquid: "HYPERLIQUID",
      };
      return map[key] || "BYBIT";
    }
    function tradingViewSymbol(row) {
      const base = String(row?.symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      return base ? `${tradingViewExchange(row?.primary_exchange)}:${base}USDT.P` : "";
    }
    function tradingViewUrl(row) {
      const tvSymbol = tradingViewSymbol(row);
      return tvSymbol ? `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tvSymbol)}` : "#";
    }
    function symbolLink(row) {
      const tvSymbol = tradingViewSymbol(row);
      if (!tvSymbol) return esc(row?.symbol || "-");
      return `<a class="symbol-link" href="${tradingViewUrl(row)}" target="_blank" rel="noopener noreferrer" title="Open ${esc(tvSymbol)} on TradingView">${esc(row?.symbol)}</a>`;
    }
    function rowKey(row) {
      return `${row.symbol || "-"}:${row.side || "-"}:${row.score_field || "-"}`;
    }
    function numeric(value) {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
    function qualityTone(value) {
      const q = numeric(value);
      if (q === null || q < 75) return "bad";
      if (q < 90) return "warn";
      return "";
    }
    function setupBadge(row) {
      return `<span class="setup-badge ${esc(row.setup_tone || "neutral")}">${esc(row.setup || "Watchlist")}</span>`;
    }
    function conflictTone(label) {
      const normalized = String(label || "").toLowerCase();
      if (normalized === "aligned" || normalized === "neutral") return "pos";
      if (normalized === "high-conflict" || normalized === "excluded") return "bad";
      if (normalized && normalized !== "unknown") return "warn";
      return "neutral";
    }
    function conflictBadge(row) {
      const label = row?.signal_conflict_label || "unknown";
      return `<span class="conflict-badge ${conflictTone(label)}">${esc(label)}</span>`;
    }
    function positioningDivergence(row) {
      const LONG = 1.2;
      const SHORT = 0.85;
      const retail = numeric(row?.long_short_account_ratio);
      const top = numeric(row?.top_trader_long_short_ratio);
      if (retail === null || top === null) return null;
      if (retail >= LONG && top <= 1.0) {
        return { tone: "warn", mark: "R▲", title: `Retail long ${retail.toFixed(2)}x vs top-trader ${top.toFixed(2)}x — retail-crowded long` };
      }
      if (retail <= SHORT && top >= 1.0) {
        return { tone: "warn", mark: "R▼", title: `Retail short ${retail.toFixed(2)}x vs top-trader ${top.toFixed(2)}x — retail-crowded short` };
      }
      if ((retail >= LONG && top >= LONG) || (retail <= SHORT && top <= SHORT)) {
        return { tone: "pos", mark: "=", title: `Retail ${retail.toFixed(2)}x / top ${top.toFixed(2)}x — aligned` };
      }
      return { tone: "neutral", mark: "", title: `Retail ${retail.toFixed(2)}x / top ${top.toFixed(2)}x` };
    }
    function positioningCell(row) {
      const div = positioningDivergence(row);
      const value = row.positioning_ratio == null ? "-" : fmtNum(row.positioning_ratio);
      const title = div?.title ? ` title="${esc(div.title)}"` : "";
      const mark = div && div.mark ? `<span class="pos-dot ${esc(div.tone)}" title="${esc(div.title)}">${esc(div.mark)}</span>` : "";
      return `<div class="watch-cell" data-label="L/S"${title}>${value}${mark}</div>`;
    }
    function setupMeta(row) {
      const parts = [];
      const conflict = String(row?.signal_conflict_label || "");
      if (conflict && !["aligned", "neutral", "unknown"].includes(conflict)) parts.push(conflict);
      return parts.length ? `<span class="driver-line">${parts.map(esc).join(" / ")}</span>` : "";
    }
    function scoreText(row, maxScore = 1) {
      const confidence = row.confidence_score == null ? "" : ` / C ${fmtNum(row.confidence_score, 0)}`;
      const score = numeric(row.score);
      const width = maxScore > 0 && score !== null ? Math.round(Math.min(Math.abs(score) / maxScore, 1) * 100) : 0;
      return `<span class="score-val">${fmtNum(row.score)}</span>
        <span class="score-bar"><span class="score-fill" style="width:${width}%"></span></span>
        <div class="driver-line">P ${fmtNum(row.priority)}${confidence}</div>`;
    }
    function arrowPct(value, digits = 2) {
      const n = numeric(value);
      if (n === null) return fmtPct(value, digits);
      const mark = n > 0 ? "▲ " : n < 0 ? "▼ " : "";
      return `${mark}${fmtPct(value, digits)}`;
    }
    function sourceParts(source) {
      return String(source || "-").split("+").map((part) => part.trim()).filter(Boolean);
    }
    function watchlistsFrom(data) {
      if (Array.isArray(data.watchlists) && data.watchlists.length) return data.watchlists;
      return [
        { id: "regime_fit", label: "Regime Fit", rows: data.sections?.regime_fit || [] },
        { id: "long", label: "Longs", rows: data.sections?.long || [] },
        { id: "short", label: "Shorts", rows: data.sections?.short || [] },
        { id: "squeeze_risks", label: "Squeeze Risk", rows: data.sections?.squeeze_risks || [] },
        { id: "crowded_longs", label: "Long Fades", rows: data.sections?.crowded_longs || [] },
        { id: "core", label: "Core", rows: data.sections?.core || [] },
      ];
    }
    function activeWatchlist(data) {
      const lists = watchlistsFrom(data);
      return lists.find((list) => list.id === state.activeWatchlist) || lists[0] || { id: "-", label: "Watchlist", rows: [] };
    }
    function filterValues() {
      return {
        query: ($("symbolFilter")?.value || "").trim().toLowerCase(),
        quality: Number($("qualityFilter")?.value || 0),
        source: $("sourceFilter")?.value || "all",
        volume: Number($("volumeFilter")?.value || 0),
        positiveOi: Boolean($("positiveOiFilter")?.checked),
        negativeFunding: Boolean($("negativeFundingFilter")?.checked),
      };
    }
    function rowMatches(row, filters) {
      if ((Number(row.quality || 0)) < filters.quality) return false;
      if ((Number(row.quote_volume_usd || 0)) < filters.volume) return false;
      if (filters.positiveOi && !(Number(row.oi_change_24h_pct || 0) > 0)) return false;
      if (filters.negativeFunding && !(Number(row.funding_rate_pct || 0) < 0)) return false;
      if (filters.source !== "all" && !sourceParts(row.data_source).map((part) => part.toLowerCase()).includes(filters.source)) return false;
      if (filters.query) {
        const haystack = [
          row.symbol,
          row.setup,
          row.technical_setup,
          row.signal_conflict_label,
          row.primary_driver?.label,
          row.explanation?.read,
          row.reason,
          row.data_source,
        ].join(" ").toLowerCase();
        if (!haystack.includes(filters.query)) return false;
      }
      return true;
    }
    function filteredRows(rows) {
      const filters = filterValues();
      return (rows || []).filter((row) => rowMatches(row, filters));
    }
    function updateSourceOptions(data) {
      const select = $("sourceFilter");
      if (!select) return;
      const current = select.value || "all";
      const sources = new Set();
      watchlistsFrom(data).forEach((list) => list.rows.forEach((row) => {
        sourceParts(row.data_source).forEach((source) => sources.add(source.toLowerCase()));
      }));
      select.innerHTML = `<option value="all">All sources</option>${Array.from(sources).sort().map((source) => (
        `<option value="${esc(source)}">${esc(source)}</option>`
      )).join("")}`;
      select.value = sources.has(current) ? current : "all";
    }
    function providerDots(providers) {
      const entries = Object.entries(providers || {});
      if (!entries.length) return "-";
      return `<div class="provider-dots">${entries.map(([name, details]) => {
        const status = String(details.status || "-");
        const tone = status === "ok" ? "" : status === "skipped" || status === "disabled" ? "warn" : "bad";
        return `<span class="provider-dot ${tone}" title="${esc(status)}${details.rows === undefined ? "" : ` / ${esc(details.rows)} rows`}">${esc(name)}</span>`;
      }).join("")}</div>`;
    }
    function metricCard(label, body, klass = "") {
      return `<article class="bg-panel border border-line rounded-md min-h-[86px] p-3"><div class="text-muted text-[11px] leading-tight uppercase tracking-wider">${esc(label)}</div><div class="font-mono tabular-nums text-xl font-extrabold mt-2 leading-tight break-words ${klass || "text-ink"}">${body}</div></article>`;
    }
    function tapeAge(freshness) {
      if (!freshness || freshness.status !== "ok") return "unknown";
      if (freshness.age_minutes != null && Number.isFinite(Number(freshness.age_minutes))) return `${fmtNum(freshness.age_minutes, 0)}m ago`;
      return freshness.label || "unknown";
    }
    function tapeSegment(key, value, klass = "") {
      return `<span class="tape-seg inline-flex items-baseline gap-1.5 px-4 border-l border-line"><span class="text-[10px] font-bold tracking-wider uppercase text-muted">${esc(key)}</span><span class="font-mono tabular-nums text-[13px] font-bold ${klass || "text-ink"}">${value}</span></span>`;
    }
    function marketTape(data) {
      const c = data.market_context || {};
      const r = data.regime || {};
      const q = data.quality || {};
      const fresh = data.freshness || {};
      const excludedTone = q.excluded_count ? "text-warn" : "text-up";
      const live = `<span class="tape-live inline-flex items-center gap-2 pr-4 mr-0.5 border-r border-line"><span class="live-dot"></span><b class="text-[11px] font-extrabold tracking-wider uppercase text-up">Live</b><span class="font-mono tabular-nums text-xs text-muted">${esc(tapeAge(fresh))}</span></span>`;
      return `<div class="col-span-full flex flex-wrap items-center gap-y-1.5 py-[11px] px-3.5 bg-panel border border-line rounded-md" role="status" aria-label="Market pulse">
        ${live}
        ${tapeSegment("Bias", esc(r.bias || "unknown"), "text-gold")}
        ${tapeSegment("Regime", esc(r.label || "unknown"))}
        ${tapeSegment("MC 24h", fmtPct(c.market_cap_change_24h_pct), clsFor(c.market_cap_change_24h_pct))}
        ${tapeSegment("BTC.D", fmtPct(c.btc_dominance_pct, 2).replace("+", ""))}
        ${tapeSegment("Trusted / Excl", `${esc(q.trusted_count ?? "-")} / ${esc(q.excluded_count ?? "-")}`, excludedTone)}
        ${tapeSegment("Providers", providerDots(data.provider_status))}
      </div>`;
    }
    function renderTabs(data) {
      const lists = watchlistsFrom(data);
      if (!lists.some((list) => list.id === state.activeWatchlist)) {
        state.activeWatchlist = lists[0]?.id || "chart_next";
      }
      $("watchTabs").innerHTML = lists.map((list) => {
        const active = list.id === state.activeWatchlist ? " active" : "";
        return `<button class="tab-btn h-[30px] rounded-full px-3 border border-line bg-panel-2 text-muted text-xs font-semibold cursor-pointer${active}" type="button" data-tab="${esc(list.id)}">${esc(list.label)}</button>`;
      }).join("");
    }
    function sparkline(points, key) {
      const values = (points || []).map((point) => numeric(point[key])).filter((value) => value !== null);
      if (values.length < 2) return `<span class="driver-line">Need history</span>`;
      const width = 92;
      const height = 28;
      const min = Math.min(...values);
      const max = Math.max(...values);
      const span = max - min || 1;
      const coords = values.map((value, index) => {
        const x = values.length === 1 ? width : (index / (values.length - 1)) * width;
        const y = height - ((value - min) / span) * (height - 4) - 2;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(" ");
      const tone = values[values.length - 1] > values[0] ? "good" : values[values.length - 1] < values[0] ? "bad" : "neutral";
      return `<svg class="sparkline block w-[92px] h-[28px] ml-auto max-[900px]:ml-0" viewBox="0 0 ${width} ${height}" aria-hidden="true"><line class="axis" x1="0" y1="${height - 2}" x2="${width}" y2="${height - 2}"></line><polyline class="${tone}" points="${coords}"></polyline></svg>`;
    }
    function sortRows(rows) {
      if (!state.sortKey || !SORT_COLUMNS[state.sortKey]) return rows;
      const { field, type } = SORT_COLUMNS[state.sortKey];
      const dir = state.sortDir === "asc" ? 1 : -1;
      return rows.slice().sort((a, b) => {
        if (type === "string") {
          return String(a[field] ?? "").localeCompare(String(b[field] ?? "")) * dir;
        }
        const an = numeric(a[field]);
        const bn = numeric(b[field]);
        if (an === null && bn === null) return 0;
        if (an === null) return 1;
        if (bn === null) return -1;
        return (an - bn) * dir;
      });
    }
    function headCell(key, label) {
      const active = state.sortKey === key;
      const arrow = active ? (state.sortDir === "asc" ? "▲" : "▼") : "";
      const ariaSort = active ? (state.sortDir === "asc" ? "ascending" : "descending") : "none";
      return `<div class="watch-th inline-flex items-center justify-end gap-0.5 cursor-pointer select-none whitespace-nowrap hover:text-ink${active ? " sorted text-gold" : ""}" role="columnheader" tabindex="0" data-sort="${key}" aria-sort="${ariaSort}">${esc(label)}<span class="sort-arrow text-[9px] leading-none transition-colors duration-100">${arrow}</span></div>`;
    }
    function watchHead() {
      return `<div class="watch-head sticky top-0 z-[2] px-3 py-2 border-b border-line bg-panel-2 text-muted text-[11px] font-bold tracking-wide uppercase text-right" role="row">
        ${headCell("symbol", "Symbol")}${headCell("setup", "Setup")}${headCell("score", "Score")}${headCell("quality", "Q")}${headCell("price", "24h")}${headCell("oi", "OI 24h")}${headCell("funding", "Funding")}${headCell("ls", "L/S")}${headCell("volume", "Volume")}${headCell("source", "Source")}
      </div>`;
    }
    function renderWatchTable(data) {
      const list = activeWatchlist(data);
      const rows = sortRows(filteredRows(list.rows));
      const selectedStillVisible = rows.some((row) => rowKey(row) === state.selectedKey);
      if (!selectedStillVisible) state.selectedKey = rows[0] ? rowKey(rows[0]) : null;
      $("watchCount").textContent = `${rows.length} / ${list.rows.length}`;
      if (!rows.length) {
        $("watchTable").innerHTML = `<div class="py-7 px-3 text-muted text-center">No rows match the current filters</div>`;
        renderDetail(null);
        return;
      }
      const maxScore = Math.max(...rows.map((row) => Math.abs(numeric(row.score) ?? 0)), 1);
      $("watchTable").innerHTML = `${watchHead()}${rows.map((row) => {
        const key = rowKey(row);
        const active = key === state.selectedKey ? " active" : "";
        return `<div class="watch-row${active}" role="button" tabindex="0" data-key="${esc(key)}">
          <div class="watch-cell left watch-symbol" data-label="Symbol">${symbolLink(row)}<span class="driver-line">${esc(row.primary_driver?.label || row.side || "-")}</span></div>
          <div class="watch-cell left watch-setup" data-label="Setup">${setupBadge(row)}${setupMeta(row)}</div>
          <div class="watch-cell" data-label="Score">${scoreText(row, maxScore)}</div>
          <div class="watch-cell" data-label="Q"><span class="quality-badge ${qualityTone(row.quality)}">${esc(row.quality ?? "-")}</span></div>
          <div class="watch-cell ${clsFor(row.price_change_24h_pct)}" data-label="24h">${arrowPct(row.price_change_24h_pct)}</div>
          <div class="watch-cell ${clsFor(row.oi_change_24h_pct)}" data-label="OI 24h">${arrowPct(row.oi_change_24h_pct)}</div>
          <div class="watch-cell ${clsFor(row.funding_rate_pct)}" data-label="Funding">${fmtPct(row.funding_rate_pct, 4)}</div>
          ${positioningCell(row)}
          <div class="watch-cell" data-label="Volume">${fmtUsd(row.quote_volume_usd)}</div>
          <div class="watch-cell" data-label="Source"><div class="source-stack">${sourceTags(row.data_source)}</div></div>
        </div>`;
      }).join("")}`;
      renderDetail(rows.find((row) => rowKey(row) === state.selectedKey) || rows[0]);
    }
    function factorBars(row) {
      const parts = row?.factor_parts || [];
      if (!parts.length) return `<div class="py-7 px-3 text-muted text-center">No factor data</div>`;
      const maxAbs = Math.max(...parts.map((part) => Math.abs(Number(part.value || 0))), 1);
      return `<div class="factor-list grid gap-2">${parts.map((part) => {
        const width = Math.round((Math.abs(Number(part.value || 0)) / maxAbs) * 100);
        return `<div class="factor-row grid grid-cols-[minmax(90px,1fr)_minmax(0,1.2fr)_48px] gap-2 items-center text-xs">
          <span>${esc(part.label)}</span>
          <span class="factor-track"><span class="factor-fill ${esc(part.tone || "neutral")}" style="width:${width}%"></span></span>
          <strong class="${part.value > 0 ? "text-up" : part.value < 0 ? "text-down" : ""}">${fmtNum(part.value, 2)}</strong>
        </div>`;
      }).join("")}</div>`;
    }
    function historyBlock(row) {
      if (!row || !Array.isArray(row.history) || row.history.length < 2) {
        return `<div class="driver-line">More saved runs needed for multi-point trend lines.</div>`;
      }
      return `<div class="history-block">
        <div class="history-line"><span>Score</span>${sparkline(row.history, row.score_field || "factor_score")}</div>
        <div class="history-line"><span>OI 24h</span>${sparkline(row.history, "oi_change_24h_pct")}</div>
        <div class="history-line"><span>Funding</span>${sparkline(row.history, "funding_rate_pct")}</div>
        <div class="history-line"><span>RSI</span>${sparkline(row.history, "rsi_14")}</div>
      </div>`;
    }
    function technicalBlock(row) {
      const state = row?.technical_state || {};
      if (!Object.keys(state).length && !row?.technical_setup) {
        return `<div class="driver-line">No CoinGlass OHLC technical snapshot for this row.</div>`;
      }
      return `<div class="detail-grid tech-grid grid grid-cols-2 max-[680px]:grid-cols-1 gap-2 -mt-1">
        <div class="detail-metric min-w-0 border border-line rounded-md p-2 bg-panel-2"><span class="label">4h Setup</span><strong>${esc(row.technical_setup || "-")}</strong></div>
        <div class="detail-metric min-w-0 border border-line rounded-md p-2 bg-panel-2"><span class="label">RSI / MACD</span><strong>${fmtNum(state.rsi_14, 1)} / <span class="${clsFor(state.macd_histogram_pct)}">${fmtPct(state.macd_histogram_pct, 3)}</span></strong></div>
        <div class="detail-metric min-w-0 border border-line rounded-md p-2 bg-panel-2"><span class="label">ATR / BB Width</span><strong>${fmtPct(state.atr_14_pct, 2)} / ${fmtPct(state.bb_width_pct, 2).replace("+", "")}</strong></div>
        <div class="detail-metric min-w-0 border border-line rounded-md p-2 bg-panel-2"><span class="label">BB Pos / EMA20 Dist</span><strong>${fmtNum(state.bb_position, 2)} / <span class="${clsFor(state.distance_ema20_pct)}">${fmtPct(state.distance_ema20_pct, 2)}</span></strong></div>
        <div class="detail-metric min-w-0 border border-line rounded-md p-2 bg-panel-2"><span class="label">Trend / Momentum</span><strong><span class="${clsFor(state.technical_trend_score)}">${fmtNum(state.technical_trend_score, 2)}</span> / <span class="${clsFor(state.technical_momentum_score)}">${fmtNum(state.technical_momentum_score, 2)}</span></strong></div>
        <div class="detail-metric min-w-0 border border-line rounded-md p-2 bg-panel-2"><span class="label">Candles</span><strong>${esc(state.technical_candle_count ?? "-")} ${esc(state.technical_interval || "")}</strong></div>
      </div>`;
    }
    function explanationBlock(row) {
      const explanation = row?.explanation || {};
      const confirm = Array.isArray(explanation.confirm) ? explanation.confirm : [];
      const risk = Array.isArray(explanation.risk) ? explanation.risk : [];
      if (!explanation.read && !confirm.length && !risk.length) {
        return `<div class="driver-line">No token explanation available.</div>`;
      }
      const list = (items, klass) => items.length ? `<ul class="${klass}">${items.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>` : "";
      return `<div class="explanation-box">
        ${explanation.read ? `<p>${esc(explanation.read)}</p>` : ""}
        <div class="explanation-grid">
          <div><div class="label">Confirm</div>${list(confirm, "explanation-list")}</div>
          <div><div class="label">Risk</div>${list(risk, "explanation-list risk")}</div>
        </div>
      </div>`;
    }
    function conflictBlock(row) {
      const conflicts = Array.isArray(row?.signal_conflicts) ? row.signal_conflicts : [];
      if (!conflicts.length) {
        return `<div class="conflict-summary">${conflictBadge(row)}<span>No material conflict detected.</span></div>`;
      }
      return `<div class="conflict-block">
        <div class="conflict-summary">${conflictBadge(row)}<span>Score ${fmtNum(row.signal_conflict_score, 0)}</span></div>
        ${conflicts.map((item) => `
          <div class="conflict-row">
            <strong>${esc(item.label || item.code || "Conflict")}</strong>
            <span>${esc(item.detail || `severity ${fmtNum(item.severity, 2)}`)}</span>
          </div>
        `).join("")}
      </div>`;
    }
    function detailSection(title, body, open = false) {
      return `<details class="detail-section border border-line rounded-md bg-panel-2 overflow-hidden border-l-2 border-l-gold" ${open ? "open" : ""}>
        <summary class="flex items-center gap-2.5 px-2.5 py-2 cursor-pointer list-none text-ink text-xs font-semibold uppercase tracking-wide">${esc(title)}</summary>
        <div class="detail-section-body px-2.5 pb-2.5 grid gap-2">${body}</div>
      </details>`;
    }
    function renderDetail(row) {
      if (!row) {
        $("detailPanel").innerHTML = panel("Selected Coin", "", `<div class="py-7 px-3 text-muted text-center">Select a watchlist row</div>`);
        return;
      }
      const flags = row.data_quality_flags || [];
      $("detailPanel").innerHTML = panel("Selected Coin", esc(row.setup || ""), `<div class="detail-body p-3 grid gap-3">
        <div class="detail-title flex justify-between items-start gap-2.5">
          <div>
            <div class="detail-symbol text-xl font-extrabold leading-tight">${symbolLink(row)}</div>
            <div class="driver-line">${esc(row.primary_driver?.label || "No dominant driver")} / ${esc(row.side || "-")}</div>
          </div>
          <div class="detail-actions flex gap-1.5 flex-wrap justify-end">
            <a class="detail-link inline-flex items-center h-7 border border-line rounded-md px-2 text-blue no-underline text-xs font-bold href="${tradingViewUrl(row)}" target="_blank" rel="noopener noreferrer">TradingView</a>
          </div>
        </div>
        <div class="detail-badges flex flex-wrap gap-1.5">${setupBadge(row)}${conflictBadge(row)}</div>
        <div class="detail-grid grid grid-cols-2 max-[680px]:grid-cols-1 gap-2">
          <div class="detail-metric min-w-0 border border-line rounded-md p-2 bg-panel-2"><span class="label">Score / Priority</span><strong>${fmtNum(row.score)} / ${fmtNum(row.priority)}</strong></div>
          <div class="detail-metric min-w-0 border border-line rounded-md p-2 bg-panel-2"><span class="label">Confidence</span><strong>${row.confidence_score == null ? "-" : fmtNum(row.confidence_score, 0)}</strong></div>
          <div class="detail-metric min-w-0 border border-line rounded-md p-2 bg-panel-2"><span class="label">Quality</span><strong class="${qualityTone(row.quality) === "bad" ? "text-down" : qualityTone(row.quality) === "warn" ? "text-warn" : ""}">${esc(row.quality ?? "-")}</strong></div>
          <div class="detail-metric min-w-0 border border-line rounded-md p-2 bg-panel-2"><span class="label">24h / OI</span><strong><span class="${clsFor(row.price_change_24h_pct)}">${fmtPct(row.price_change_24h_pct)}</span> / <span class="${clsFor(row.oi_change_24h_pct)}">${fmtPct(row.oi_change_24h_pct)}</span></strong></div>
          <div class="detail-metric min-w-0 border border-line rounded-md p-2 bg-panel-2"><span class="label">Funding / L/S</span><strong><span class="${clsFor(row.funding_rate_pct)}">${fmtPct(row.funding_rate_pct, 4)}</span> / ${row.long_short_ratio == null ? "-" : fmtNum(row.long_short_ratio)}</strong></div>
          <div class="detail-metric min-w-0 border border-line rounded-md p-2 bg-panel-2"><span class="label">Positioning (R / T)</span><strong>${(() => {
            const retail = row.long_short_account_ratio;
            const top = row.top_trader_long_short_ratio;
            const div = positioningDivergence(row);
            const valueText = `${retail == null ? "-" : fmtNum(retail)}x / ${top == null ? "-" : fmtNum(top)}x`;
            const badge = retail != null && top != null
              ? `<span class="conflict-badge ${div ? (div.tone === "warn" ? "warn" : div.tone === "pos" ? "pos" : "neutral") : "neutral"}">${esc(div ? (div.mark || "mixed") : "n/a")}</span>`
              : "";
            return `${valueText}${badge}`;
          })()}</strong></div>
          <div class="detail-metric min-w-0 border border-line rounded-md p-2 bg-panel-2"><span class="label">Volume</span><strong>${fmtUsd(row.quote_volume_usd)}</strong></div>
          <div class="detail-metric min-w-0 border border-line rounded-md p-2 bg-panel-2"><span class="label">Open Interest</span><strong>${fmtUsd(row.open_interest_usd)}</strong></div>
        </div>
        <div class="label">Reason ${reasonHelp()}</div>
        ${reasonView(row)}
        ${detailSection("How To Read This Coin", explanationBlock(row), false)}
        ${detailSection("Signal Conflict", conflictBlock(row), (row.signal_conflicts || []).length > 0)}
        ${detailSection("Technical Context", technicalBlock(row), false)}
        ${detailSection("Factor Breakdown", factorBars(row), false)}
        ${detailSection("History", historyBlock(row), false)}
        ${flags.length ? `<div class="quality-flag-list flex flex-wrap gap-1">${qualityFlagView(flags)}</div>` : ""}
      </div>`);
    }
    function providerList(providers) {
      const entries = Object.entries(providers || {});
      if (entries.length === 0) return `<div class="py-7 px-3 text-muted text-center">No providers</div>`;
      return `<div class="provider-list p-3 grid gap-2">${entries.map(([name, details]) => {
        const providerStatus = String(details.status || "-");
        const tone = providerStatus === "ok" ? "" : providerStatus === "skipped" || providerStatus === "disabled" ? "warn" : "bad";
        return `
        <div class="provider-row grid grid-cols-[minmax(0,1fr)_auto_auto] gap-2 items-center min-h-[30px] text-[13px]">
          <strong>${esc(name)}</strong>
          <span class="status-pill ${tone}">${esc(providerStatus)}</span>
          <span class="provider-count text-muted text-xs font-mono text-right min-w-[38px]">${details.rows === undefined ? "-" : esc(details.rows)}</span>
        </div>`;
      }).join("")}</div>`;
    }
    function qualityFlagChip(flag) {
      const [rawLabel, rawValue = ""] = String(flag || "").split(":");
      const labels = {
        extreme_24h_price_change: "Price 24h",
        extreme_24h_oi_change: "OI 24h",
        extreme_24h_volume_change: "Volume 24h",
        extreme_funding_rate: "Funding",
        thin_coinglass_exchange_coverage: "Thin coverage",
        price_deviates_from_index: "Price vs Index",
        price_deviates_from_binance: "Price vs Binance",
        stale_low_quote_volume: "Low volume",
        invalid_price: "Invalid price",
        invalid_open_interest: "Invalid OI",
        weird_symbol: "Symbol",
        weird_contract_symbol: "Contract",
      };
      const label = labels[rawLabel] || rawLabel.replace(/_/g, " ");
      const tone = rawLabel.includes("extreme") || rawLabel.includes("invalid") || rawLabel.includes("deviates") ? "bad" : "warn";
      return `<span class="quality-flag-chip ${tone}" title="${esc(flag)}">${esc(label)}${rawValue ? ` <strong>${esc(rawValue)}</strong>` : ""}</span>`;
    }
    function qualityFlagView(flags) {
      return (flags || []).map(qualityFlagChip).join("");
    }
    function qualityBlock(quality) {
      const flags = quality?.flagged_rows || [];
      if (flags.length === 0) return `<div class="quality-flags p-3 grid gap-2.5"><div class="quality-card grid gap-1.5 p-2 rounded-md"><div class="quality-card-head flex justify-between gap-2 items-baseline text-[13px]"><strong>All clear</strong><span>sanity checks passed</span></div></div></div>`;
      return `<div class="quality-flags p-3 grid gap-2.5">${flags.map((row) => `
        <div class="quality-card grid gap-1.5 p-2 rounded-md">
          <div class="quality-card-head flex justify-between gap-2 items-baseline text-[13px]">
            <strong>${esc(row.symbol)}</strong>
            <span>${fmtPct(row.price_change_24h_pct)} / OI ${fmtPct(row.oi_change_24h_pct)}</span>
          </div>
          <div class="quality-flag-list flex flex-wrap gap-1">${qualityFlagView(row.flags)}</div>
        </div>
      `).join("")}</div>`;
    }
    function modulePanel(title, subtitle, body, open = false, accent = "blue") {
      return `<details class="module-panel border-l-2 border-${accent} rounded-md overflow-hidden bg-panel border border-line" ${open ? "open" : ""}>
        <summary class="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2.5 px-3 py-2.5 cursor-pointer list-none bg-panel-2"><strong class="text-xs font-semibold uppercase tracking-wide">${esc(title)}</strong><span class="text-muted text-xs font-semibold whitespace-nowrap">${esc(subtitle || "")}</span></summary>
        ${body}
      </details>`;
    }
    function providerHasIssue(providers) {
      return Object.values(providers || {}).some((details) => {
        const status = String(details.status || "-");
        return status !== "ok";
      });
    }
    function renderSideModules(data) {
      const providerIssue = providerHasIssue(data.provider_status);
      const providerEntries = Object.keys(data.provider_status || {}).length;
      $("providerPanel").innerHTML = modulePanel(
        "Providers",
        providerIssue ? "needs attention" : `${providerEntries} ok`,
        providerList(data.provider_status),
        false,
        "blue"
      );
      const excluded = data.quality?.excluded_count || 0;
      $("qualityPanel").innerHTML = modulePanel(
        "Data Quality",
        `${excluded} excluded`,
        qualityBlock(data.quality),
        false,
        "blue"
      );
      $("validationPanel").innerHTML = modulePanel(
        "Validation",
        data.validation?.calibration_label || data.validation?.status || "unknown",
        validationBlock(data.validation),
        false,
        "blue"
      );
      const mw = data.model_weights || {};
      const mwSub = `${mw.mode || "prior"} · ${mw.regime?.label || data.regime?.label || "mixed"}`;
      $("weightsPanel").innerHTML = modulePanel("Factor Weights", mwSub, weightsBlock(mw), false, "gold");
      $("sectorPanel").innerHTML = modulePanel(
        "Sector Rotation",
        data.market_context?.sector_rotation?.label || "leaders / laggards",
        sectorList(data.market_context || {}),
        false,
        "gold"
      );
      $("runsPanel").innerHTML = modulePanel(
        "Freshness / Runs",
        data.freshness?.label || `${(data.runs || []).length} loaded`,
        `${freshnessBlock(data.freshness)}${runsBlock(data.runs)}`,
        false,
        "blue"
      );
    }
    function weightsBlock(modelWeights) {
      const factors = modelWeights?.factors || [];
      if (!factors.length) return `<div class="py-7 px-3 text-muted text-center">No factor weights</div>`;
      const maxAbs = Math.max(...factors.map((f) => Math.abs(Number(f.weight || 0))), 0.0001);
      return `<div class="list p-3 grid gap-2">${factors.map((f) => {
        const width = Math.round((Math.abs(Number(f.weight || 0)) / maxAbs) * 100);
        const tone = f.weight > 0 ? "pos" : f.weight < 0 ? "neg" : "neutral";
        const driver = f.mode === "ic"
          ? `<span class="driver-line">IC ${fmtNum(f.ic, 2)} · t ${fmtNum(f.t_stat, 1)} · k ${fmtNum(f.credibility_k, 2)} · ${esc(f.n_periods)}p${f.regime_multiplier != null && Math.abs(f.regime_multiplier - 1) >= 0.01 ? ` · x${fmtNum(f.regime_multiplier, 2)}` : ""}</span>`
          : "";
        return `<div class="weight-row grid grid-cols-[minmax(90px,1fr)_minmax(0,1.2fr)_auto] gap-2 items-center text-xs">
          <div class="weight-label grid gap-0.5 min-w-0"><strong>${esc(f.label || f.name || "-")}</strong>${driver}</div>
          <span class="factor-track"><span class="factor-fill ${tone}" style="width:${width}%"></span></span>
          <div class="weight-meta flex items-center gap-1.5 justify-self-end"><span class="status-pill ${f.mode === "ic" ? "" : "warn"}">${esc((f.mode || "prior").toUpperCase())}</span><strong>${fmtNum(f.weight, 3)}</strong></div>
        </div>`;
      }).join("")}</div>`;
    }
    function validationBlock(validation) {
      if (!validation || Object.keys(validation).length === 0) return `<div class="py-7 px-3 text-muted text-center">No validation data</div>`;
      const best = validation.best_factors?.[0];
      const weak = validation.weakest_factors?.[0];
      const buckets = validation.conflict_buckets || [];
      return `<div class="list p-3 grid gap-2">
        <div class="list-row flex justify-between gap-3 text-[13px]"><strong>Status</strong><span>${esc(validation.status || "unknown")} / ${esc(validation.calibration_label || "learning")}</span></div>
        <div class="list-row flex justify-between gap-3 text-[13px]"><strong>Observations</strong><span>${esc(validation.observations ?? 0)} / ${esc(validation.horizon_hours ?? "-")}h</span></div>
        <div class="list-row flex justify-between gap-3 text-[13px]"><strong>Model Hit</strong><span>${fmtRate(validation.model_hit_rate)}</span></div>
        <div class="list-row flex justify-between gap-3 text-[13px]"><strong>Best Factor</strong><span>${best ? `${esc(best.label)} ${fmtRate(best.hit_rate)}` : "-"}</span></div>
        <div class="list-row flex justify-between gap-3 text-[13px]"><strong>Weak Factor</strong><span>${weak ? `${esc(weak.label)} ${fmtRate(weak.hit_rate)}` : "-"}</span></div>
        <div class="label">Current Signal Mix</div>
        ${buckets.slice(0, 4).map((bucket) => `<div class="list-row flex justify-between gap-3 text-[13px]"><strong>${esc(bucket.label)}</strong><span>${esc(bucket.count)} / C ${fmtNum(bucket.avg_confidence, 0)}</span></div>`).join("") || `<div class="py-7 px-3 text-muted text-center">No signal buckets</div>`}
      </div>`;
    }
    function freshnessBlock(freshness) {
      if (!freshness || freshness.status !== "ok") return `<div class="list p-3 grid gap-2"><div class="list-row flex justify-between gap-3 text-[13px]"><strong>Freshness</strong><span>unknown</span></div></div>`;
      return `<div class="list freshness-list p-3 grid gap-2 border-b border-line">
        <div class="list-row flex justify-between gap-3 text-[13px]"><strong>Selected Run</strong><span>${esc(freshness.generated_at || "-")}</span></div>
        <div class="list-row flex justify-between gap-3 text-[13px]"><strong>Age</strong><span>${esc(freshness.label || "unknown")} / ${fmtNum(freshness.age_minutes, 1)}m</span></div>
      </div>`;
    }
    function sectorList(context) {
      const leaders = context?.categories?.leaders || [];
      const laggards = context?.categories?.laggards || [];
      const breadth = context?.breadth || {};
      const rotation = context?.sector_rotation || {};
      const line = (item) => `<div class="list-row flex justify-between gap-3 text-[13px]"><strong>${esc(item.name || item.id)}</strong><span class="${clsFor(item.market_cap_change_24h_pct)}">${fmtPct(item.market_cap_change_24h_pct)}</span></div>`;
      return `<div class="sector-list grid grid-cols-[0.9fr_1fr_1fr] max-[1100px]:grid-cols-1 gap-3 p-3">
        <div class="sector-block min-w-0 grid content-start gap-2">
          <div class="list-row flex justify-between gap-3 text-[13px]"><strong>Breadth</strong><span>${esc(breadth.label || "unknown")} / ${fmtNum(breadth.score, 2)}</span></div>
          <div class="list-row flex justify-between gap-3 text-[13px]"><strong>Sector Tape</strong><span>${esc(rotation.label || "unknown")}</span></div>
        </div>
        <div class="sector-block min-w-0 grid content-start gap-2">
          <div class="label">Leaders</div>
          ${leaders.slice(0, 3).map(line).join("") || `<div class="py-7 px-3 text-muted text-center">No leaders</div>`}
        </div>
        <div class="sector-block min-w-0 grid content-start gap-2">
          <div class="label">Laggards</div>
          ${laggards.slice(0, 3).map(line).join("") || `<div class="py-7 px-3 text-muted text-center">No laggards</div>`}
        </div>
      </div>`;
    }
    function runsBlock(runs) {
      if (!runs || runs.length === 0) return `<div class="py-7 px-3 text-muted text-center">No runs</div>`;
      return `<div class="list p-3 grid gap-2">${runs.slice(0, 12).map((run) => `
        <div class="list-row flex justify-between gap-3 text-[13px]"><strong>${esc(run.generated_at)}</strong><span>${esc(run.bias)} / ${esc(run.coinglass_status)} / ${esc(run.row_count)} rows</span></div>
      `).join("")}</div>`;
    }
    function runOptions(runs, selected) {
      $("runSelect").innerHTML = (runs || []).map((run) => `<option value="${esc(run.run_id)}" ${run.run_id === selected ? "selected" : ""}>${esc(run.generated_at)}</option>`).join("");
    }
    async function load(runId = null) {
      const url = runId ? `/api/dashboard?run_id=${encodeURIComponent(runId)}` : "/api/dashboard";
      const data = await fetch(url, { cache: "no-store" }).then((res) => res.json());
      if (data.status !== "ok") {
        $("generated").textContent = "No saved screener runs";
        $("metrics").innerHTML = metric("Database", data.database || "-");
        $("watchTabs").innerHTML = "";
        $("watchCount").textContent = "-";
        $("watchTable").innerHTML = `<div class="py-7 px-3 text-muted text-center">No data</div>`;
        $("detailPanel").innerHTML = panel("Selected Coin", "", `<div class="py-7 px-3 text-muted text-center">No data</div>`);
        ["providerPanel","qualityPanel","validationPanel","weightsPanel","sectorPanel","runsPanel"].forEach((id) => $(id).innerHTML = modulePanel(id, "", `<div class="py-7 px-3 text-muted text-center">No data</div>`, false, "blue"));
        return;
      }
      state.selectedRun = data.run.run_id;
      state.data = data;
      runOptions(data.runs, data.run.run_id);
      updateSourceOptions(data);
      $("generated").textContent = `${data.run.generated_at} / ${data.run.row_count} symbols · Use Top Setups first -> filter -> inspect detail -> open TradingView. Freshness: ${data.freshness?.label || "unknown"}.`;
      $("metrics").innerHTML = marketTape(data);
      renderTabs(data);
      renderWatchTable(data);
      renderSideModules(data);
    }
    $("reload").addEventListener("click", () => load(state.selectedRun));
    $("runSelect").addEventListener("change", (event) => {
      state.selectedKey = null;
      load(event.target.value);
    });
    $("watchTabs").addEventListener("click", (event) => {
      const button = event.target.closest("[data-tab]");
      if (!button || !state.data) return;
      state.activeWatchlist = button.dataset.tab;
      state.selectedKey = null;
      renderTabs(state.data);
      renderWatchTable(state.data);
    });
    $("watchTable").addEventListener("click", (event) => {
      if (event.target.closest("a")) return;
      const row = event.target.closest("[data-key]");
      if (!row || !state.data) return;
      state.selectedKey = row.dataset.key;
      renderWatchTable(state.data);
    });
    $("watchTable").addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const header = event.target.closest("[data-sort]");
      if (header) {
        event.preventDefault();
        applySort(header.dataset.sort);
        return;
      }
      const row = event.target.closest("[data-key]");
      if (!row || !state.data) return;
      event.preventDefault();
      state.selectedKey = row.dataset.key;
      renderWatchTable(state.data);
    });
    function applySort(key) {
      if (!SORT_COLUMNS[key] || !state.data) return;
      if (state.sortKey === key) {
        state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
      } else {
        state.sortKey = key;
        state.sortDir = SORT_COLUMNS[key].type === "string" ? "asc" : "desc";
      }
      persistPrefs();
      renderWatchTable(state.data);
    }
    $("watchTable").addEventListener("click", (event) => {
      const header = event.target.closest("[data-sort]");
      if (header) applySort(header.dataset.sort);
    });
    $("themeToggle").addEventListener("click", () => {
      state.theme = state.theme === "light" ? "dark" : "light";
      applyTheme();
      persistPrefs();
    });
    $("densityToggle").addEventListener("click", () => {
      state.density = state.density === "compact" ? "comfortable" : "compact";
      applyDensity();
      persistPrefs();
    });
    ["symbolFilter", "qualityFilter", "sourceFilter", "volumeFilter", "positiveOiFilter", "negativeFundingFilter"].forEach((id) => {
      $(id).addEventListener("input", () => {
        if (state.data) renderWatchTable(state.data);
      });
      $(id).addEventListener("change", () => {
        if (state.data) renderWatchTable(state.data);
      });
    });
    loadPrefs();
    applyTheme();
    applyDensity();
    load().catch((error) => {
      $("generated").textContent = "Dashboard error";
      $("metrics").innerHTML = metric("Error", error.message || String(error), "text-down");
    });
