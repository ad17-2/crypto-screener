    const state = { selectedRun: null, data: null, activeWatchlist: "chart_next", selectedKey: null };
    const $ = (id) => document.getElementById(id);
    const esc = (value) => String(value ?? "-").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const clsFor = (value) => Number(value || 0) > 0 ? "good" : Number(value || 0) < 0 ? "bad" : "";
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
      return `<article class="metric"><div class="label">${esc(label)}</div><div class="value ${klass}">${esc(value)}</div></article>`;
    }
    function panel(title, count, body) {
      return `<div class="panel-head"><h2>${esc(title)}</h2><span class="count">${esc(count)}</span></div>${body}`;
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
    function scoreText(row) {
      const confidence = row.confidence_score == null ? "" : ` / C ${fmtNum(row.confidence_score, 0)}`;
      return `<strong>${fmtNum(row.score)}</strong><div class="driver-line">P ${fmtNum(row.priority)}${confidence}</div>`;
    }
    function sourceParts(source) {
      return String(source || "-").split("+").map((part) => part.trim()).filter(Boolean);
    }
    function watchlistsFrom(data) {
      if (Array.isArray(data.watchlists) && data.watchlists.length) return data.watchlists;
      return [
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
          row.primary_driver?.label,
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
      return `<article class="metric"><div class="label">${esc(label)}</div><div class="value ${klass}">${body}</div></article>`;
    }
    function renderTabs(data) {
      const lists = watchlistsFrom(data);
      if (!lists.some((list) => list.id === state.activeWatchlist)) {
        state.activeWatchlist = lists[0]?.id || "chart_next";
      }
      $("watchTabs").innerHTML = lists.map((list) => {
        const active = list.id === state.activeWatchlist ? " active" : "";
        return `<button class="tab-btn${active}" type="button" data-tab="${esc(list.id)}">${esc(list.label)} <span>${esc(list.rows.length)}</span></button>`;
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
      return `<svg class="sparkline" viewBox="0 0 ${width} ${height}" aria-hidden="true"><line class="axis" x1="0" y1="${height - 2}" x2="${width}" y2="${height - 2}"></line><polyline class="${tone}" points="${coords}"></polyline></svg>`;
    }
    function renderWatchTable(data) {
      const list = activeWatchlist(data);
      const rows = filteredRows(list.rows);
      const selectedStillVisible = rows.some((row) => rowKey(row) === state.selectedKey);
      if (!selectedStillVisible) state.selectedKey = rows[0] ? rowKey(rows[0]) : null;
      $("watchCount").textContent = `${rows.length} / ${list.rows.length}`;
      if (!rows.length) {
        $("watchTable").innerHTML = `<div class="empty">No rows match the current filters</div>`;
        renderDetail(null);
        return;
      }
      $("watchTable").innerHTML = `<div class="watch-head">
        <div>Symbol</div><div>Setup</div><div>Score</div><div>Q</div><div>24h</div><div>OI 24h</div><div>Funding</div><div>L/S</div><div>Volume</div><div>Trend</div><div>Source</div>
      </div>${rows.map((row) => {
        const key = rowKey(row);
        const active = key === state.selectedKey ? " active" : "";
        return `<div class="watch-row${active}" role="button" tabindex="0" data-key="${esc(key)}">
          <div class="watch-cell left watch-symbol" data-label="Symbol">${symbolLink(row)}<span class="driver-line">${esc(row.primary_driver?.label || row.side || "-")}</span></div>
          <div class="watch-cell left" data-label="Setup">${setupBadge(row)}</div>
          <div class="watch-cell" data-label="Score">${scoreText(row)}</div>
          <div class="watch-cell" data-label="Q"><span class="quality-badge ${qualityTone(row.quality)}">${esc(row.quality ?? "-")}</span></div>
          <div class="watch-cell ${clsFor(row.price_change_24h_pct)}" data-label="24h">${fmtPct(row.price_change_24h_pct)}</div>
          <div class="watch-cell ${clsFor(row.oi_change_24h_pct)}" data-label="OI 24h">${fmtPct(row.oi_change_24h_pct)}</div>
          <div class="watch-cell ${clsFor(row.funding_rate_pct)}" data-label="Funding">${fmtPct(row.funding_rate_pct, 4)}</div>
          <div class="watch-cell" data-label="L/S">${row.long_short_ratio == null ? "-" : fmtNum(row.long_short_ratio)}</div>
          <div class="watch-cell" data-label="Volume">${fmtUsd(row.quote_volume_usd)}</div>
          <div class="watch-cell" data-label="Trend">${sparkline(row.history, row.score_field || "factor_score")}</div>
          <div class="watch-cell" data-label="Source"><div class="source-stack">${sourceTags(row.data_source)}</div></div>
        </div>`;
      }).join("")}`;
      renderDetail(rows.find((row) => rowKey(row) === state.selectedKey) || rows[0]);
    }
    function factorBars(row) {
      const parts = row?.factor_parts || [];
      if (!parts.length) return `<div class="empty">No factor data</div>`;
      const maxAbs = Math.max(...parts.map((part) => Math.abs(Number(part.value || 0))), 1);
      return `<div class="factor-list">${parts.map((part) => {
        const width = Math.round((Math.abs(Number(part.value || 0)) / maxAbs) * 100);
        return `<div class="factor-row">
          <span>${esc(part.label)}</span>
          <span class="factor-track"><span class="factor-fill ${esc(part.tone || "neutral")}" style="width:${width}%"></span></span>
          <strong class="${part.value > 0 ? "good" : part.value < 0 ? "bad" : ""}">${fmtNum(part.value, 2)}</strong>
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
      return `<div class="detail-grid tech-grid">
        <div class="detail-metric"><span class="label">4h Setup</span><strong>${esc(row.technical_setup || "-")}</strong></div>
        <div class="detail-metric"><span class="label">RSI / MACD</span><strong>${fmtNum(state.rsi_14, 1)} / <span class="${clsFor(state.macd_histogram_pct)}">${fmtPct(state.macd_histogram_pct, 3)}</span></strong></div>
        <div class="detail-metric"><span class="label">ATR / BB Width</span><strong>${fmtPct(state.atr_14_pct, 2)} / ${fmtPct(state.bb_width_pct, 2).replace("+", "")}</strong></div>
        <div class="detail-metric"><span class="label">BB Pos / EMA20 Dist</span><strong>${fmtNum(state.bb_position, 2)} / <span class="${clsFor(state.distance_ema20_pct)}">${fmtPct(state.distance_ema20_pct, 2)}</span></strong></div>
        <div class="detail-metric"><span class="label">Trend / Momentum</span><strong><span class="${clsFor(state.technical_trend_score)}">${fmtNum(state.technical_trend_score, 2)}</span> / <span class="${clsFor(state.technical_momentum_score)}">${fmtNum(state.technical_momentum_score, 2)}</span></strong></div>
        <div class="detail-metric"><span class="label">Candles</span><strong>${esc(state.technical_candle_count ?? "-")} ${esc(state.technical_interval || "")}</strong></div>
      </div>`;
    }
    function renderDetail(row) {
      if (!row) {
        $("detailPanel").innerHTML = panel("Selected Coin", "", `<div class="empty">Select a watchlist row</div>`);
        return;
      }
      const flags = row.data_quality_flags || [];
      $("detailPanel").innerHTML = panel("Selected Coin", esc(row.setup || ""), `<div class="detail-body">
        <div class="detail-title">
          <div>
            <div class="detail-symbol">${symbolLink(row)}</div>
            <div class="driver-line">${esc(row.primary_driver?.label || "No dominant driver")} / ${esc(row.side || "-")}</div>
          </div>
          <div class="detail-actions">
            <a class="detail-link" href="${tradingViewUrl(row)}" target="_blank" rel="noopener noreferrer">TradingView</a>
          </div>
        </div>
        <div>${setupBadge(row)}</div>
        <div class="detail-grid">
          <div class="detail-metric"><span class="label">Score / Priority</span><strong>${fmtNum(row.score)} / ${fmtNum(row.priority)}</strong></div>
          <div class="detail-metric"><span class="label">Confidence</span><strong>${row.confidence_score == null ? "-" : fmtNum(row.confidence_score, 0)}</strong></div>
          <div class="detail-metric"><span class="label">Quality</span><strong class="${qualityTone(row.quality)}">${esc(row.quality ?? "-")}</strong></div>
          <div class="detail-metric"><span class="label">24h / OI</span><strong><span class="${clsFor(row.price_change_24h_pct)}">${fmtPct(row.price_change_24h_pct)}</span> / <span class="${clsFor(row.oi_change_24h_pct)}">${fmtPct(row.oi_change_24h_pct)}</span></strong></div>
          <div class="detail-metric"><span class="label">Funding / L/S</span><strong><span class="${clsFor(row.funding_rate_pct)}">${fmtPct(row.funding_rate_pct, 4)}</span> / ${row.long_short_ratio == null ? "-" : fmtNum(row.long_short_ratio)}</strong></div>
          <div class="detail-metric"><span class="label">Volume</span><strong>${fmtUsd(row.quote_volume_usd)}</strong></div>
          <div class="detail-metric"><span class="label">Open Interest</span><strong>${fmtUsd(row.open_interest_usd)}</strong></div>
        </div>
        <div class="label">Technical Context</div>
        ${technicalBlock(row)}
        <div class="label">Reason ${reasonHelp()}</div>
        ${reasonView(row)}
        <div class="label">Factor Breakdown</div>
        ${factorBars(row)}
        <div class="label">History</div>
        ${historyBlock(row)}
        ${flags.length ? `<div class="quality-flag-list">${qualityFlagView(flags)}</div>` : ""}
      </div>`);
    }
    function providerList(providers) {
      const entries = Object.entries(providers || {});
      if (entries.length === 0) return `<div class="empty">No providers</div>`;
      return `<div class="provider-list">${entries.map(([name, details]) => {
        const providerStatus = String(details.status || "-");
        const tone = providerStatus === "ok" ? "" : providerStatus === "skipped" || providerStatus === "disabled" ? "warn" : "bad";
        return `
        <div class="provider-row">
          <strong>${esc(name)}</strong>
          <span class="status-pill ${tone}">${esc(providerStatus)}</span>
          <span class="provider-count">${details.rows === undefined ? "-" : esc(details.rows)}</span>
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
      if (flags.length === 0) return `<div class="quality-flags"><div class="quality-card"><div class="quality-card-head"><strong>All clear</strong><span>sanity checks passed</span></div></div></div>`;
      return `<div class="quality-flags">${flags.map((row) => `
        <div class="quality-card">
          <div class="quality-card-head">
            <strong>${esc(row.symbol)}</strong>
            <span>${fmtPct(row.price_change_24h_pct)} / OI ${fmtPct(row.oi_change_24h_pct)}</span>
          </div>
          <div class="quality-flag-list">${qualityFlagView(row.flags)}</div>
        </div>
      `).join("")}</div>`;
    }
    function modulePanel(title, subtitle, body, open = false) {
      return `<details class="module-panel" ${open ? "open" : ""}>
        <summary><strong>${esc(title)}</strong><span>${esc(subtitle || "")}</span></summary>
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
        providerIssue
      );
      const excluded = data.quality?.excluded_count || 0;
      $("qualityPanel").innerHTML = modulePanel(
        "Data Quality",
        `${excluded} excluded`,
        qualityBlock(data.quality),
        excluded > 0
      );
      $("sectorPanel").innerHTML = modulePanel("Sector Rotation", "leaders / laggards", sectorList(data.market_context || {}), true);
      $("runsPanel").innerHTML = modulePanel("Recent Runs", `${(data.runs || []).length} loaded`, runsBlock(data.runs), false);
    }
    function sectorList(context) {
      const leaders = context?.categories?.leaders || [];
      const laggards = context?.categories?.laggards || [];
      const breadth = context?.breadth || {};
      const rotation = context?.sector_rotation || {};
      const line = (item) => `<div class="list-row"><strong>${esc(item.name || item.id)}</strong><span class="${clsFor(item.market_cap_change_24h_pct)}">${fmtPct(item.market_cap_change_24h_pct)}</span></div>`;
      return `<div class="list">
        <div class="list-row"><strong>Breadth</strong><span>${esc(breadth.label || "unknown")} / ${fmtNum(breadth.score, 2)}</span></div>
        <div class="list-row"><strong>Sector Tape</strong><span>${esc(rotation.label || "unknown")}</span></div>
        <div class="label">Leaders</div>${leaders.slice(0, 5).map(line).join("") || `<div class="empty">No leaders</div>`}
        <div class="label">Laggards</div>${laggards.slice(0, 5).map(line).join("") || `<div class="empty">No laggards</div>`}
      </div>`;
    }
    function runsBlock(runs) {
      if (!runs || runs.length === 0) return `<div class="empty">No runs</div>`;
      return `<div class="list">${runs.slice(0, 12).map((run) => `
        <div class="list-row"><strong>${esc(run.generated_at)}</strong><span>${esc(run.bias)} / ${esc(run.coinglass_status)} / ${esc(run.row_count)} rows</span></div>
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
        $("watchTable").innerHTML = `<div class="empty">No data</div>`;
        $("detailPanel").innerHTML = panel("Selected Coin", "", `<div class="empty">No data</div>`);
        ["providerPanel","qualityPanel","sectorPanel","runsPanel"].forEach((id) => $(id).innerHTML = modulePanel(id, "", `<div class="empty">No data</div>`));
        return;
      }
      state.selectedRun = data.run.run_id;
      state.data = data;
      runOptions(data.runs, data.run.run_id);
      updateSourceOptions(data);
      const c = data.market_context || {};
      const r = data.regime || {};
      $("generated").textContent = `${data.run.generated_at} / ${data.run.row_count} symbols`;
      $("metrics").innerHTML = [
        metric("Bias", r.bias || "unknown", "accent"),
        metric("Factor Regime", r.label || "unknown", "small"),
        metric("Breadth", c.breadth?.label || "unknown", "small"),
        metric("Market Cap 24h", fmtPct(c.market_cap_change_24h_pct), clsFor(c.market_cap_change_24h_pct)),
        metric("BTC Dominance", fmtPct(c.btc_dominance_pct, 2).replace("+", "")),
        metric("Trusted / Excluded", `${data.quality.trusted_count} / ${data.quality.excluded_count}`, data.quality.excluded_count ? "warn" : "good"),
        metricCard("Providers", providerDots(data.provider_status), "small"),
      ].join("");
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
      const row = event.target.closest("[data-key]");
      if (!row || !state.data) return;
      event.preventDefault();
      state.selectedKey = row.dataset.key;
      renderWatchTable(state.data);
    });
    ["symbolFilter", "qualityFilter", "sourceFilter", "volumeFilter", "positiveOiFilter", "negativeFundingFilter"].forEach((id) => {
      $(id).addEventListener("input", () => {
        if (state.data) renderWatchTable(state.data);
      });
      $(id).addEventListener("change", () => {
        if (state.data) renderWatchTable(state.data);
      });
    });
    load().catch((error) => {
      $("generated").textContent = "Dashboard error";
      $("metrics").innerHTML = metric("Error", error.message || String(error), "bad");
    });
