// ============================================================
// toolkit/flow.js - easing-curve (Flow) graph editor
// ------------------------------------------------------------
// normalizeCurveForView + the FlowSystem object + initFlowSystem /
// initFlowCompactObserver. Moved verbatim from main.js. Depends only
// on globals: DOM, bindClick, csInterface, decodeBridge, showToast,
// localStorage. init() in main.js calls initFlowSystem/Observer.
// Loaded before main.js.
// ============================================================

// ── Curve normalization engine ─────────────────────────────
// Maps all bezier points (anchors + control points) to fit proportionally
// within the SVG viewBox, preserving the curve's visual character.
// This ensures extreme presets (Back In/Out, elastic) show their overshoot.
function normalizeCurveForView(h1x, h1y, h2x, h2y, viewSize, pad) {
    var ax = 0, ay = viewSize;     // start anchor (bottom-left in graph space)
    var bx = viewSize, by = 0;     // end anchor (top-right in graph space)

    // Sample the cubic bezier to find its bounding box
    var minX = 0, maxX = viewSize;
    var minY = 0, maxY = viewSize;
    var steps = 24;
    for (var i = 0; i <= steps; i++) {
        var t = i / steps;
        var mt = 1 - t;
        var px = mt * mt * mt * ax + 3 * mt * mt * t * h1x + 3 * mt * t * t * h2x + t * t * t * bx;
        var py = mt * mt * mt * ay + 3 * mt * mt * t * h1y + 3 * mt * t * t * h2y + t * t * t * by;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
    }

    // Include control points in bounds (they may extend beyond curve)
    if (h1x < minX) minX = h1x;
    if (h1x > maxX) maxX = h1x;
    if (h1y < minY) minY = h1y;
    if (h1y > maxY) maxY = h1y;
    if (h2x < minX) minX = h2x;
    if (h2x > maxX) maxX = h2x;
    if (h2y < minY) minY = h2y;
    if (h2y > maxY) maxY = h2y;

    var rangeX = maxX - minX || 1;
    var rangeY = maxY - minY || 1;
    var safeSize = viewSize - pad * 2;

    // Uniform scale to preserve aspect ratio
    var scale = Math.min(safeSize / rangeX, safeSize / rangeY);
    var offsetX = pad + (safeSize - rangeX * scale) / 2;
    var offsetY = pad + (safeSize - rangeY * scale) / 2;

    function mapX(v) { return offsetX + (v - minX) * scale; }
    function mapY(v) { return offsetY + (v - minY) * scale; }

    return {
        ax: mapX(ax), ay: mapY(ay),
        bx: mapX(bx), by: mapY(by),
        h1x: mapX(h1x), h1y: mapY(h1y),
        h2x: mapX(h2x), h2y: mapY(h2y)
    };
}

var FlowSystem = {
    h1: { x: 33, y: 100 },
    h2: { x: 66, y: 0 },
    strength: 100,
    activeTab: "built-in",
    recent: [],
    builtIn: [
        // BASIC — clearly distinct base curves
        { name: "Linear", h1: { x: 0, y: 100 }, h2: { x: 100, y: 0 } },
        { name: "Ease", h1: { x: 25, y: 100 }, h2: { x: 25, y: 0 } },
        { name: "Ease In", h1: { x: 42, y: 100 }, h2: { x: 100, y: 0 } },
        { name: "Ease Out", h1: { x: 0, y: 100 }, h2: { x: 58, y: 0 } },
        { name: "Ease In Out", h1: { x: 42, y: 100 }, h2: { x: 58, y: 0 } },
        // COMMON — exaggerated curves for clear visual differentiation
        { name: "Quad In", h1: { x: 22, y: 100 }, h2: { x: 55, y: 85 } },
        { name: "Quad Out", h1: { x: 45, y: 15 }, h2: { x: 78, y: 0 } },
        { name: "Quad In Out", h1: { x: 45, y: 100 }, h2: { x: 55, y: 0 } },
        { name: "Cubic In", h1: { x: 38, y: 100 }, h2: { x: 62, y: 92 } },
        { name: "Cubic Out", h1: { x: 38, y: 8 }, h2: { x: 62, y: 0 } },
        { name: "Cubic In Out", h1: { x: 62, y: 100 }, h2: { x: 38, y: 0 } },
        { name: "Quart In", h1: { x: 50, y: 100 }, h2: { x: 72, y: 96 } },
        { name: "Quart Out", h1: { x: 28, y: 4 }, h2: { x: 50, y: 0 } },
        { name: "Quart In Out", h1: { x: 72, y: 100 }, h2: { x: 28, y: 0 } },
        { name: "Quint In", h1: { x: 60, y: 100 }, h2: { x: 76, y: 98 } },
        { name: "Quint Out", h1: { x: 24, y: 2 }, h2: { x: 40, y: 0 } },
        { name: "Quint In Out", h1: { x: 78, y: 100 }, h2: { x: 22, y: 0 } },
        // SMOOTH — softer curves with visible arc personality
        { name: "Sine In", h1: { x: 44, y: 100 }, h2: { x: 70, y: 68 } },
        { name: "Sine Out", h1: { x: 30, y: 32 }, h2: { x: 56, y: 0 } },
        { name: "Sine In Out", h1: { x: 34, y: 100 }, h2: { x: 66, y: 0 } },
        { name: "Circ In", h1: { x: 52, y: 100 }, h2: { x: 92, y: 52 } },
        { name: "Circ Out", h1: { x: 8, y: 48 }, h2: { x: 48, y: 0 } },
        { name: "Circ In Out", h1: { x: 80, y: 100 }, h2: { x: 20, y: 0 } },
        { name: "Expo In", h1: { x: 66, y: 100 }, h2: { x: 78, y: 96 } },
        { name: "Expo Out", h1: { x: 22, y: 4 }, h2: { x: 34, y: 0 } },
        { name: "Expo In Out", h1: { x: 84, y: 100 }, h2: { x: 16, y: 0 } },
        // STYLIZED — dramatic curves with overshoot/undershoot
        { name: "Back In", h1: { x: 36, y: 100 }, h2: { x: 66, y: 156 } },
        { name: "Back Out", h1: { x: 34, y: -56 }, h2: { x: 64, y: 0 } },
        { name: "Back In Out", h1: { x: 68, y: -60 }, h2: { x: 32, y: 160 } }
    ],
    extra: [
        { name: "Fast In", h1: { x: 90, y: 100 }, h2: { x: 95, y: 15 } },
        { name: "Fast Out", h1: { x: 5, y: 85 }, h2: { x: 10, y: 0 } },
        { name: "Snappy Pop", h1: { x: 20, y: 100 }, h2: { x: 15, y: 0 } },
        { name: "Extreme Launch", h1: { x: 95, y: 100 }, h2: { x: 5, y: 0 } },
        { name: "Soft Cushion", h1: { x: 40, y: 80 }, h2: { x: 60, y: 20 } },
        { name: "Heavy Impact", h1: { x: 10, y: 100 }, h2: { x: 95, y: 5 } },
        { name: "Over-Launch", h1: { x: 50, y: -30 }, h2: { x: 50, y: 130 } },
        { name: "Anticipate", h1: { x: 60, y: 140 }, h2: { x: 20, y: 0 } },
        { name: "Jelly Glide", h1: { x: 25, y: -20 }, h2: { x: 75, y: 120 } }
    ],
    user: [],
    isDragging: null,

    init: function () {
        this.loadUserPresets();
        this.renderPresets();
        this.updateUI();
        this.attachListeners();
    },

    loadUserPresets: function () {
        try {
            var raw = localStorage.getItem("cs_flow_user_presets");
            if (raw) this.user = JSON.parse(raw);
            var rec = localStorage.getItem("cs_flow_recent_presets");
            if (rec) this.recent = JSON.parse(rec);
        } catch (e) { this.user = []; this.recent = []; }
    },

    saveUserPresets: function () {
        localStorage.setItem("cs_flow_user_presets", JSON.stringify(this.user));
    },

    saveRecent: function () {
        localStorage.setItem("cs_flow_recent_presets", JSON.stringify(this.recent));
    },

    initGraphSplitter: function () {
        var splitter = document.getElementById('flow-graph-splitter');
        var graphView = document.getElementById('toolkit-graph-view');
        var splitRow = graphView ? graphView.querySelector('.tk-flow-split-row') : null;
        if (!splitter || !graphView) return;

        // Idempotent init (Req 12): a second call used to attach a SECOND pair of
        // permanent document-level mousemove/mouseup listeners, so every re-init
        // multiplied the drag work and leaked handlers past panel disposal.
        if (this._splitterBound) return;
        this._splitterBound = true;

        // Restore saved sizes
        var savedGraphSize = localStorage.getItem('flowGraphSize');
        if (savedGraphSize) {
            var s = parseInt(savedGraphSize);
            if (s >= 80 && s <= 200) {
                graphView.style.setProperty('--graph-size', s + 'px');
            } else {
                localStorage.removeItem('flowGraphSize');
                graphView.style.setProperty('--graph-size', '130px');
            }
        } else {
            graphView.style.setProperty('--graph-size', '130px');
        }

        var savedColWidth = localStorage.getItem('flowGraphColWidth');
        if (savedColWidth) {
            var w = parseInt(savedColWidth);
            if (w >= 120 && w <= 400) {
                graphView.style.setProperty('--graph-col-width', w + 'px');
            } else {
                localStorage.removeItem('flowGraphColWidth');
            }
        }

        function isSideBySide() {
            if (!splitRow) return false;
            return getComputedStyle(splitRow).flexDirection === 'row';
        }

        var isDragging = false;
        var startPos = 0;
        var startSize = 0;

        // Named handlers so they can be detached on panel disposal (Req 4/12).
        function onSplitterDown(e) {
            isDragging = true;
            splitter.classList.add('dragging');

            if (isSideBySide()) {
                // Horizontal: resize graph column width
                startPos = e.clientX;
                startSize = graphView.querySelector('.tk-flow-col-left').offsetWidth;
                document.body.style.cursor = 'ew-resize';
            } else {
                // Vertical: resize graph height
                startPos = e.clientY;
                startSize = graphView.querySelector('.tk-flow-canvas-wrap').offsetHeight;
                document.body.style.cursor = 'ns-resize';
            }
            e.preventDefault();
        }

        function onSplitterMove(e) {
            if (!isDragging) return;

            if (isSideBySide()) {
                var MIN_GRAPH_WIDTH = 140;
                var MIN_PRESET_WIDTH = 180;
                var parentWidth = splitRow.offsetWidth || 300;
                var delta = e.clientX - startPos;

                var newWidth = Math.max(
                    MIN_GRAPH_WIDTH,
                    Math.min(parentWidth - MIN_PRESET_WIDTH, startSize + delta)
                );
                graphView.style.setProperty('--graph-col-width', newWidth + 'px');
            } else {
                var deltaY = e.clientY - startPos;
                var newSize = Math.max(100, Math.min(300, startSize + deltaY));
                graphView.style.setProperty('--graph-size', newSize + 'px');
            }
        }

        function onSplitterUp() {
            if (!isDragging) return;
            isDragging = false;
            splitter.classList.remove('dragging');
            document.body.style.cursor = '';

            if (isSideBySide()) {
                var colLeft = graphView.querySelector('.tk-flow-col-left');
                localStorage.setItem('flowGraphColWidth', colLeft.offsetWidth);
            } else {
                var canvasWrap = graphView.querySelector('.tk-flow-canvas-wrap');
                localStorage.setItem('flowGraphSize', canvasWrap.offsetHeight);
            }
        }

        // Route through AppLifecycle when available so the document-level
        // listeners are removed on panel teardown instead of living forever.
        var lifecycleListen = null;
        try {
            if (typeof AppLifecycle !== "undefined" && AppLifecycle && AppLifecycle.listen) {
                lifecycleListen = AppLifecycle.listen;
            }
        } catch (eLC) { lifecycleListen = null; }

        if (lifecycleListen) {
            lifecycleListen(splitter, 'mousedown', onSplitterDown);
            lifecycleListen(document, 'mousemove', onSplitterMove);
            lifecycleListen(document, 'mouseup', onSplitterUp);
        } else {
            splitter.addEventListener('mousedown', onSplitterDown);
            document.addEventListener('mousemove', onSplitterMove);
            document.addEventListener('mouseup', onSplitterUp);
        }
    },

    renderPresets: function () {
        var grid = DOM["flow-presets-grid"];
        if (!grid) return;
        grid.innerHTML = "";
        var list = this.activeTab === "built-in" ? this.builtIn :
            (this.activeTab === "extra" || this.activeTab === "extreme") ? this.extra :
            this.activeTab === "user" ? this.user : this.recent;

        if (list.length === 0) {
            grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:15px;opacity:0.3;font-size:9px;">EMPTY</div>';
            return;
        }

        for (var i = 0; i < list.length; i++) {
            var p = list[i];
            var card = document.createElement("button");
            card.type = "button";
            card.className = "tk-flow-preset-card";
            card.title = p.name;
            card.style.animationDelay = (i * 20) + 'ms';

            // Thumbnail — normalized bezier rendering
            var n = normalizeCurveForView(p.h1.x, p.h1.y, p.h2.x, p.h2.y, 100, 10);
            var pathD = "M " + n.ax.toFixed(1) + " " + n.ay.toFixed(1) +
                " C " + n.h1x.toFixed(1) + " " + n.h1y.toFixed(1) +
                " " + n.h2x.toFixed(1) + " " + n.h2y.toFixed(1) +
                " " + n.bx.toFixed(1) + " " + n.by.toFixed(1);

            var svg =
                // Defs: gradient for curve stroke
                '<defs>' +
                '<linearGradient id="cg' + i + '" x1="0" y1="1" x2="1" y2="0">' +
                '<stop offset="0%" stop-color="var(--p-400)" stop-opacity="0.6"/>' +
                '<stop offset="100%" stop-color="var(--p-300)" stop-opacity="1"/>' +
                '</linearGradient>' +
                '<radialGradient id="cglow' + i + '" cx="0.5" cy="0.5" r="0.5">' +
                '<stop offset="0%" stop-color="var(--p-400)" stop-opacity="0.15"/>' +
                '<stop offset="100%" stop-color="var(--p-400)" stop-opacity="0"/>' +
                '</radialGradient>' +
                '</defs>' +
                // Layer 1: grid — reference diagonal
                '<line x1="' + n.ax.toFixed(1) + '" y1="' + n.ay.toFixed(1) + '" x2="' + n.bx.toFixed(1) + '" y2="' + n.by.toFixed(1) + '" ' +
                'stroke="rgba(255,255,255,0.04)" stroke-width="0.5" stroke-dasharray="3 3"/>' +
                // Layer 2: ambient glow behind curve
                '<path d="' + pathD + '" stroke="url(#cglow' + i + ')" stroke-width="8" fill="none" ' +
                'stroke-linecap="round" class="tk-preset-glow"/>' +
                // Layer 3: handle guide lines — visible tethers
                '<line x1="' + n.ax.toFixed(1) + '" y1="' + n.ay.toFixed(1) + '" x2="' + n.h1x.toFixed(1) + '" y2="' + n.h1y.toFixed(1) + '" ' +
                'stroke="var(--p-400)" stroke-width="0.7" stroke-dasharray="2 1.5" class="tk-preset-handle-line"/>' +
                '<line x1="' + n.bx.toFixed(1) + '" y1="' + n.by.toFixed(1) + '" x2="' + n.h2x.toFixed(1) + '" y2="' + n.h2y.toFixed(1) + '" ' +
                'stroke="var(--p-400)" stroke-width="0.7" stroke-dasharray="2 1.5" class="tk-preset-handle-line"/>' +
                // Layer 4: easing curve — hero line
                '<path d="' + pathD + '" stroke="url(#cg' + i + ')" stroke-width="2" fill="none" ' +
                'stroke-linecap="round" stroke-linejoin="round" shape-rendering="geometricPrecision"/>' +
                // Layer 5: control points — visible hollow
                '<circle cx="' + n.h1x.toFixed(1) + '" cy="' + n.h1y.toFixed(1) + '" r="2" fill="rgba(167,139,250,0.06)" ' +
                'stroke="var(--p-400)" stroke-width="0.7" class="tk-preset-ctrl"/>' +
                '<circle cx="' + n.h2x.toFixed(1) + '" cy="' + n.h2y.toFixed(1) + '" r="2" fill="rgba(167,139,250,0.06)" ' +
                'stroke="var(--p-400)" stroke-width="0.7" class="tk-preset-ctrl"/>' +
                // Layer 6: anchor points — solid endpoints
                '<circle cx="' + n.ax.toFixed(1) + '" cy="' + n.ay.toFixed(1) + '" r="2" fill="var(--p-400)" class="tk-preset-anchor"/>' +
                '<circle cx="' + n.bx.toFixed(1) + '" cy="' + n.by.toFixed(1) + '" r="2" fill="var(--p-400)" class="tk-preset-anchor"/>';

            svg = '<svg class="tk-flow-preset-svg" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">' + svg + '</svg>';

            // The SVG is generated from numeric curve values only, so it is safe
            // to set as markup. The preset NAME is user input (prompt() →
            // localStorage), so it is written as text — interpolating it into
            // innerHTML let a name containing "<" break or inject markup.
            card.innerHTML = svg;
            var nameEl = document.createElement("span");
            nameEl.className = "tk-flow-preset-name";
            nameEl.textContent = p.name;
            card.appendChild(nameEl);

            (function (preset, idx) {
                card.onclick = function () {
                    FlowSystem.selectedPreset = idx;
                    FlowSystem.setCurve(preset.h1.x, preset.h1.y, preset.h2.x, preset.h2.y);
                    FlowSystem.addToRecent(preset);
                    // Silent apply — no toast on failure (user is browsing presets)
                    FlowSystem.applyEasing(true);

                    var cards = grid.querySelectorAll('.tk-flow-preset-card');
                    for (var c = 0; c < cards.length; c++) cards[c].classList.remove('selected');
                    card.classList.add('selected');

                    var delBtn = document.getElementById('btn-flow-delete-preset');
                    var favBtn = document.getElementById('btn-flow-favorite');
                    if (delBtn) delBtn.disabled = (FlowSystem.activeTab !== 'user');
                    if (favBtn) favBtn.classList.toggle('active', preset.favorite || false);
                };
            })(p, i);

            grid.appendChild(card);
        }
    },

    setCurve: function (x1, y1, x2, y2) {
        this.h1 = { x: x1, y: y1 };
        this.h2 = { x: x2, y: y2 };
        this.updateUI();
    },

    addToRecent: function (preset) {
        this.recent = this.recent.filter(function (r) { return r.name !== preset.name; });
        this.recent.unshift(preset);
        if (this.recent.length > 8) this.recent.pop();
        this.saveRecent();
        if (this.activeTab === "recent") this.renderPresets();
    },

    deleteUserPreset: function (name) {
        this.user = this.user.filter(function (u) { return u.name !== name; });
        this.saveUserPresets();
        if (this.activeTab === "user") this.renderPresets();
    },

    updateUI: function () {
        var path = DOM["flow-curve-path"];
        var h1 = DOM["flow-handle-1"];
        var h2 = DOM["flow-handle-2"];
        var l1 = DOM["flow-handle-line-1"];
        var l2 = DOM["flow-handle-line-2"];
        var vin = DOM["flow-val-in"];
        var vout = DOM["flow-val-out"];

        if (!path || !h1) return;

        // Clamp handles to 0-100 for the main graph
        var h1x = Math.max(0, Math.min(100, this.h1.x));
        var h1y = Math.max(0, Math.min(100, this.h1.y));
        var h2x = Math.max(0, Math.min(100, this.h2.x));
        var h2y = Math.max(0, Math.min(100, this.h2.y));

        var d = "M 0 100 C " + h1x + " " + h1y + " " + h2x + " " + h2y + " 100 0";
        path.setAttribute("d", d);

        h1.setAttribute("cx", h1x);
        h1.setAttribute("cy", h1y);
        h2.setAttribute("cx", h2x);
        h2.setAttribute("cy", h2y);

        l1.setAttribute("x2", h1x);
        l1.setAttribute("y2", h1y);
        l2.setAttribute("x2", h2x);
        l2.setAttribute("y2", h2y);

        if (vin) vin.textContent = Math.round(this.h1.x) + " / " + Math.round(100 - this.h1.y);
        if (vout) vout.textContent = Math.round(this.h2.x) + " / " + Math.round(100 - this.h2.y);
        this.updateValuesDisplay();
    },

    updateValuesDisplay: function () {
        var view = document.getElementById('toolkit-graph-view');
        if (!view) return;

        var valuesBelow = view.querySelector('.tk-flow-values-below');
        if (valuesBelow && valuesBelow.parentNode) {
            valuesBelow.parentNode.removeChild(valuesBelow);
        }

        var inEl = view.querySelector('#flow-val-in-below');
        var outEl = view.querySelector('#flow-val-out-below');
        if (inEl) inEl.textContent = Math.round(this.h1.x) + ' / ' + Math.round(100 - this.h1.y);
        if (outEl) outEl.textContent = Math.round(this.h2.x) + ' / ' + Math.round(100 - this.h2.y);
    },

    attachListeners: function () {
        var self = this;
        var svg = DOM["flow-graph-svg"];

        var handleMove = function (e) {
            if (!self.isDragging) return;
            var rect = svg.getBoundingClientRect();
            // Map mouse to data coordinates accounting for viewBox padding (-6 to 106)
            var x = ((e.clientX - rect.left) / rect.width) * 112 - 6;
            var y = ((e.clientY - rect.top) / rect.height) * 112 - 6;

            // Clamp to 0-100 data range
            x = Math.max(0, Math.min(100, x));
            y = Math.max(0, Math.min(100, y));

            if (self.isDragging === "h1") {
                self.h1.x = x; self.h1.y = y;
            } else {
                self.h2.x = x; self.h2.y = y;
            }
            self.updateUI();
        };

        var handleUp = function () {
            if (self.isDragging) {
                var el = DOM["flow-handle-" + (self.isDragging === "h1" ? "1" : "2")];
                if (el) el.classList.remove("dragging");
            }
            self.isDragging = null;
            window.removeEventListener("mousemove", handleMove);
            window.removeEventListener("mouseup", handleUp);
        };

        DOM["flow-handle-1"].onmousedown = function (e) {
            e.preventDefault();
            self.isDragging = "h1";
            this.classList.add("dragging");
            window.addEventListener("mousemove", handleMove);
            window.addEventListener("mouseup", handleUp);
        };

        DOM["flow-handle-2"].onmousedown = function (e) {
            e.preventDefault();
            self.isDragging = "h2";
            this.classList.add("dragging");
            window.addEventListener("mousemove", handleMove);
            window.addEventListener("mouseup", handleUp);
        };

        // Click ANYWHERE on the graph → the NEAREST handle jumps to that
        // point and immediately enters drag mode (classic curve-editor feel).
        // Clicks that start directly on a handle are ignored here so the
        // handle's own mousedown takes over.
        if (svg) {
            svg.onmousedown = function (e) {
                if (e.target === DOM["flow-handle-1"] || e.target === DOM["flow-handle-2"]) return;
                var rect = svg.getBoundingClientRect();
                var x = ((e.clientX - rect.left) / rect.width) * 112 - 6;
                var y = ((e.clientY - rect.top) / rect.height) * 112 - 6;
                x = Math.max(0, Math.min(100, x));
                y = Math.max(0, Math.min(100, y));

                // Pick the closer handle by squared distance.
                var d1 = (x - self.h1.x) * (x - self.h1.x) + (y - self.h1.y) * (y - self.h1.y);
                var d2 = (x - self.h2.x) * (x - self.h2.x) + (y - self.h2.y) * (y - self.h2.y);
                self.isDragging = (d1 <= d2) ? "h1" : "h2";

                if (self.isDragging === "h1") { self.h1.x = x; self.h1.y = y; }
                else { self.h2.x = x; self.h2.y = y; }

                var el = DOM["flow-handle-" + (self.isDragging === "h1" ? "1" : "2")];
                if (el) el.classList.add("dragging");
                self.updateUI();

                window.addEventListener("mousemove", handleMove);
                window.addEventListener("mouseup", handleUp);
                e.preventDefault();
            };
        }

        var tabs = document.querySelectorAll(".tk-flow-tab");
        for (var i = 0; i < tabs.length; i++) {
            tabs[i].onclick = function () {
                for (var j = 0; j < tabs.length; j++) tabs[j].classList.remove("active");
                this.classList.add("active");
                self.activeTab = this.dataset.flowTab;
                self.renderPresets();
            };
        }

        // Curve mode selector (Bezier / Elastic / Bounce / Steps)
        self.curveMode = "bezier";
        var modeBtns = document.querySelectorAll("#flow-mode-selector .flow-mode-btn");
        var advPanel = document.getElementById("flow-advanced-panel");
        for (var m = 0; m < modeBtns.length; m++) {
            modeBtns[m].onclick = function () {
                for (var k = 0; k < modeBtns.length; k++) modeBtns[k].classList.remove("active");
                this.classList.add("active");
                self.curveMode = this.dataset.curveMode || "bezier";
                if (advPanel) {
                    if (self.curveMode === "elastic" || self.curveMode === "bounce") {
                        advPanel.style.display = "flex";
                    } else {
                        advPanel.style.display = "none";
                    }
                }
            };
        }

        // Direction segmented control (Both / In / Out)
        self.direction = "both";
        var dirBtns = document.querySelectorAll("#flow-dir-toggle .flow-seg-btn");
        for (var d = 0; d < dirBtns.length; d++) {
            dirBtns[d].onclick = function () {
                for (var k = 0; k < dirBtns.length; k++) dirBtns[k].classList.remove("active");
                this.classList.add("active");
                self.direction = this.dataset.flowDir || "both";
            };
        }

        // Target segmented control (Keyframes / Expression)
        self.target = "keys";
        var targetBtns = document.querySelectorAll("#flow-apply-target-toggle [data-flow-target]");
        for (var t = 0; t < targetBtns.length; t++) {
            targetBtns[t].onclick = function () {
                for (var k = 0; k < targetBtns.length; k++) targetBtns[k].classList.remove("active");
                this.classList.add("active");
                self.target = this.dataset.flowTarget || "keys";
                if (advPanel && self.target === "expr") {
                    advPanel.style.display = "flex";
                }
            };
        }

        // Flip Horizontal: mirrors in/out velocity
        bindClick("btn-flow-flip-h", function () {
            var newH1x = Math.max(0, Math.min(100, 100 - self.h2.x));
            var newH1y = Math.max(0, Math.min(100, 100 - self.h2.y));
            var newH2x = Math.max(0, Math.min(100, 100 - self.h1.x));
            var newH2y = Math.max(0, Math.min(100, 100 - self.h1.y));
            self.setCurve(newH1x, newH1y, newH2x, newH2y);
            self.applyEasing(true);
        });

        // Flip Vertical: inverts curvature
        bindClick("btn-flow-flip-v", function () {
            var newH1y = Math.max(0, Math.min(100, 100 - self.h1.y));
            var newH2y = Math.max(0, Math.min(100, 100 - self.h2.y));
            self.setCurve(self.h1.x, newH1y, self.h2.x, newH2y);
            self.applyEasing(true);
        });

        // Reset Linear
        bindClick("btn-flow-reset-linear", function () {
            self.setCurve(0, 100, 100, 0);
            self.applyEasing(true);
        });

        // Reset Ease
        bindClick("btn-flow-reset-ease", function () {
            self.setCurve(33, 100, 66, 0);
            self.applyEasing(true);
        });

        bindClick("btn-flow-reset", function () {
            self.setCurve(33, 100, 66, 0);
            self.selectedPreset = null;
            // Deselect all preset cards
            var cards = document.querySelectorAll('.tk-flow-preset-card');
            for (var c = 0; c < cards.length; c++) cards[c].classList.remove('selected');
            var delBtn = document.getElementById('btn-flow-delete-preset');
            var favBtn = document.getElementById('btn-flow-favorite');
            if (delBtn) delBtn.disabled = true;
            if (favBtn) favBtn.classList.remove('active');
        });

        bindClick("btn-flow-apply", function () {
            self.applyEasing(false); // Non-silent: show toast on error
        });

        bindClick("btn-flow-reset-graph", function () {
            self.setCurve(33, 100, 66, 0);
            self.selectedPreset = null;
            var cards = document.querySelectorAll('.tk-flow-preset-card');
            for (var c = 0; c < cards.length; c++) cards[c].classList.remove('selected');
            var delBtn = document.getElementById('btn-flow-delete-preset');
            var favBtn = document.getElementById('btn-flow-favorite');
            if (delBtn) delBtn.disabled = true;
            if (favBtn) favBtn.classList.remove('active');
        });
    },

    applyEasing: function (silent) {
        var btn = DOM["btn-flow-apply"];
        if (!btn) return;

        // If target is Expression or curveMode is Bounce/Elastic, apply bounce overshoot expression
        if (this.target === "expr" || this.curveMode === "bounce" || this.curveMode === "elastic") {
            var bouncesEl = document.getElementById("flow-param-bounces");
            var elastEl = document.getElementById("flow-param-elasticity");
            var decayEl = document.getElementById("flow-param-decay");

            var freq = bouncesEl ? parseFloat(bouncesEl.value) || 3 : 3;
            var amp = elastEl ? parseFloat(elastEl.value) || 40 : 40;
            var decay = decayEl ? parseFloat(decayEl.value) || 5 : 5;

            var paramsStr = freq + "|" + amp + "|" + decay;
            var encodedParams = typeof encodeBridge === "function" ? encodeBridge(paramsStr) : paramsStr;

            ToolBridge.call({
                key: "flow.bounce",
                script: 'toolkitApplyBounce("' + encodedParams + '")',
                button: btn,
                silentBusy: !!silent,
                onResult: function (result) {
                    if (result.status !== "success") return;
                    var r = result.decoded;
                    if (r && r.indexOf("OK") === 0) {
                        btn.classList.add("apply-flash");
                        setTimeout(function () { btn.classList.remove("apply-flash"); }, 400);
                    } else if (!silent) {
                        showToast(r || "Select keyframes first", "error");
                    }
                }
            });
            return;
        }

        // Standard Temporal Bezier Ease
        var rawInf1 = Math.max(0.1, Math.min(100, this.h1.x));
        var rawInf2 = Math.max(0.1, Math.min(100, 100 - this.h2.x));

        var inf1 = rawInf1;
        var inf2 = rawInf2;

        if (this.direction === "in") {
            inf1 = 33; // Neutral out-influence
        } else if (this.direction === "out") {
            inf2 = 33; // Neutral in-influence
        }

        ToolBridge.call({
            key: "flow.apply",
            script: 'toolkitApplyFlow(' + inf1 + ',' + inf2 + ')',
            button: btn,
            // Preset browsing fires this on every card click; suppress the
            // "already running" toast for those (real failures still toast).
            silentBusy: !!silent,
            onResult: function (result) {
                if (result.status !== "success") return; // timeout/host error already toasted
                var r = result.decoded;
                if (r === "true") {
                    btn.classList.add("apply-flash");
                    setTimeout(function () { btn.classList.remove("apply-flash"); }, 400);
                } else if (!silent) {
                    // Only show toast when Apply button is clicked directly
                    showToast(r || "Select keyframes first", "error");
                }
            }
        });
    }
};

function initFlowSystem() {
    FlowSystem.init();
    FlowSystem.initGraphSplitter();
    FlowSystem.updateValuesDisplay();

    // Action icon handlers
    FlowSystem.selectedPreset = null;

    var saveBtn = document.getElementById('btn-flow-save-preset');
    var favBtn = document.getElementById('btn-flow-favorite');
    var delBtn = document.getElementById('btn-flow-delete-preset');

    if (saveBtn) {
        saveBtn.addEventListener('click', function () {
            var name = prompt('Preset name:', 'My Curve');
            if (name && name.trim()) {
                FlowSystem.user.push({
                    name: name.trim(),
                    h1: { x: FlowSystem.h1.x, y: FlowSystem.h1.y },
                    h2: { x: FlowSystem.h2.x, y: FlowSystem.h2.y },
                    favorite: false
                });
                FlowSystem.saveUserPresets();
                if (FlowSystem.activeTab === 'user') FlowSystem.renderPresets();
            }
        });
    }

    if (favBtn) {
        favBtn.addEventListener('click', function () {
            if (FlowSystem.selectedPreset !== null && FlowSystem.activeTab === 'user') {
                var preset = FlowSystem.user[FlowSystem.selectedPreset];
                if (preset) {
                    preset.favorite = !preset.favorite;
                    FlowSystem.saveUserPresets();
                    favBtn.classList.toggle('active', preset.favorite);
                }
            }
        });
    }

    if (delBtn) {
        delBtn.addEventListener('click', function () {
            if (FlowSystem.activeTab !== 'user' || FlowSystem.selectedPreset === null) return;
            if (confirm('Delete this preset?')) {
                FlowSystem.user.splice(FlowSystem.selectedPreset, 1);
                FlowSystem.selectedPreset = null;
                FlowSystem.saveUserPresets();
                FlowSystem.renderPresets();
                delBtn.disabled = true;
                favBtn.classList.remove('active');
            }
        });
    }

    // Inline save button (beside apply)
    var saveInline = document.getElementById('btn-flow-save-inline');
    if (saveInline) {
        saveInline.addEventListener('click', function () {
            var name = prompt('Preset name:', 'My Curve');
            if (name && name.trim()) {
                FlowSystem.user.push({
                    name: name.trim(),
                    h1: { x: FlowSystem.h1.x, y: FlowSystem.h1.y },
                    h2: { x: FlowSystem.h2.x, y: FlowSystem.h2.y },
                    favorite: false
                });
                FlowSystem.saveUserPresets();
                if (FlowSystem.activeTab === 'user') FlowSystem.renderPresets();
            }
        });
    }
}

function initFlowCompactObserver() {
    var flowRoot = document.querySelector('.tk-flow-root');
    if (!flowRoot || !window.ResizeObserver) return;
    if (initFlowCompactObserver._observer) return;

    var COMPACT_THRESHOLD = 200;
    var ro = new ResizeObserver(function (entries) {
        var height = entries[0].contentRect.height;
        flowRoot.classList.toggle('flow-compact', height < COMPACT_THRESHOLD);
    });
    initFlowCompactObserver._observer = ro;
    ro.observe(flowRoot);
    if (typeof FeatureFlags !== "undefined" && FeatureFlags.flags.lifecycleV1 &&
        typeof AppLifecycle !== "undefined") {
        AppLifecycle.register("observer", ro, function (observer) {
            observer.disconnect();
            initFlowCompactObserver._observer = null;
        });
    }
}
