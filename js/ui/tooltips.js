// ============================================================
// ui/tooltips.js — custom low-latency hover tooltips
// ------------------------------------------------------------
// Replaces native title tooltips with a single floating element
// that tracks the cursor. Fully self-contained — only touches
// document/window. Moved verbatim from main.js; initCustomTooltips
// is called from init(). Loaded before main.js.
//
// Requirements 9.1–9.4:
//   - Show delay: 300–600ms (avoids flicker on casual movement)
//   - Hide timing: ≤150ms after cursor leaves (CSS transition handles fade)
//   - Edge repositioning: tooltip stays within panel viewport
//   - Single tooltip: only one visible at a time
//   - Narrow overflow: reduced padding/font at ≤320px
// ============================================================

function initCustomTooltips() {
    var tooltipEl = document.createElement("div");
    tooltipEl.className = "custom-tooltip";
    document.body.appendChild(tooltipEl);

    var activeTarget = null;
    var showTimer = null;
    var hideTimer = null;

    // Configuration
    var SHOW_DELAY = 250;    // ms — refined initial delay
    var WARM_DELAY = 50;     // ms — near-instant delay when moving between nearby controls
    var COLD_TIMEOUT = 300;  // ms — time to keep the system 'warm' after a tooltip hides
    var EDGE_MARGIN = 4;     // px — minimum distance from panel edge
    
    // State
    var isWarm = false;
    var warmTimer = null;

    /**
     * Hide the tooltip immediately and clear any pending show timer.
     * Ensures only one tooltip is visible at a time (Requirement 9.3).
     */
    function hideTooltip() {
        if (showTimer) {
            clearTimeout(showTimer);
            showTimer = null;
        }
        var wasVisible = tooltipEl.classList.contains("show");
        tooltipEl.classList.remove("show");
        activeTarget = null;

        if (wasVisible) {
            isWarm = true;
            if (warmTimer) clearTimeout(warmTimer);
            warmTimer = setTimeout(function() {
                isWarm = false;
            }, COLD_TIMEOUT);
        }
    }

    /**
     * Reposition the tooltip so it remains fully visible within the panel
     * viewport. Handles edge-of-panel clipping (Requirement 9.2) and
     * adjusts for narrow widths (Requirement 9.4).
     */
    function updateTooltipPos(e) {
        if (!activeTarget) return;

        var panelW = window.innerWidth;
        var panelH = window.innerHeight;
        var tooltipWidth = tooltipEl.offsetWidth;
        var tooltipHeight = tooltipEl.offsetHeight;

        // Default position: below and right of cursor
        var x = e.clientX + 10;
        var y = e.clientY + 15;

        // Edge repositioning — horizontal
        if (x + tooltipWidth > panelW - EDGE_MARGIN) {
            x = e.clientX - tooltipWidth - 10;
        }
        if (x < EDGE_MARGIN) {
            x = EDGE_MARGIN;
        }

        // Edge repositioning — vertical
        if (y + tooltipHeight > panelH - EDGE_MARGIN) {
            y = e.clientY - tooltipHeight - 10;
        }
        if (y < EDGE_MARGIN) {
            y = EDGE_MARGIN;
        }

        // Tooltip uses position:fixed — no scrollY offset needed
        tooltipEl.style.left = x + "px";
        tooltipEl.style.top = y + "px";
    }

    /**
     * Apply narrow-width adjustments for Breakpoint_Narrow (≤320px).
     * Adds .tooltip-narrow class to allow text wrapping and reduced sizing
     * so tooltips don't overflow at 180px panel width (Requirement 9.4).
     */
    function applyNarrowAdjustments() {
        var panelW = window.innerWidth;
        if (panelW <= 320) {
            tooltipEl.classList.add("tooltip-narrow");
        } else {
            tooltipEl.classList.remove("tooltip-narrow");
        }
    }

    document.body.addEventListener("mouseover", function (e) {
        var target = e.target;
        while (target && target !== document.body) {
            if (target.hasAttribute("title") || target.hasAttribute("data-tooltip")) {
                break;
            }
            target = target.parentNode;
        }
        if (!target || target === document.body) return;

        // If hovering the same target that's already active, do nothing
        if (target === activeTarget) return;

        // Hide any existing tooltip first (Requirement 9.3: only one at a time)
        hideTooltip();

        // Convert title to data-tooltip to prevent native tooltip
        var title = target.getAttribute("title");
        if (title) {
            target.setAttribute("data-tooltip", title);
            target.removeAttribute("title");
        }

        var text = target.getAttribute("data-tooltip");
        if (!text) return;

        // Clear any pending hide timer
        if (hideTimer) {
            clearTimeout(hideTimer);
            hideTimer = null;
        }

        // Set up the tooltip content and position before delay
        // (so measurements are correct when it becomes visible)
        tooltipEl.textContent = text;
        applyNarrowAdjustments();

        // Pre-position off-screen to get accurate measurements
        tooltipEl.style.left = "-9999px";
        tooltipEl.style.top = "-9999px";

        var pendingTarget = target;
        var pendingEvent = e;

        // Track the pending target so mousemove can update position
        activeTarget = pendingTarget;

        var currentDelay = isWarm ? WARM_DELAY : SHOW_DELAY;

        // Show after delay
        showTimer = setTimeout(function () {
            showTimer = null;
            // Verify the target is still the one we intend to show
            if (pendingTarget === activeTarget) {
                tooltipEl.classList.add("show");
                updateTooltipPos(pendingEvent);
                
                // Once a tooltip is shown, we are definitively warm.
                isWarm = true;
                if (warmTimer) {
                    clearTimeout(warmTimer);
                    warmTimer = null;
                }
            }
        }, currentDelay);
    });

    document.body.addEventListener("mousemove", function (e) {
        if (!activeTarget) return;
        updateTooltipPos(e);
    });

    document.body.addEventListener("mouseout", function (e) {
        var target = e.target;
        while (target && target !== document.body) {
            if (target.hasAttribute("data-tooltip")) {
                break;
            }
            target = target.parentNode;
        }
        if (!target || target === document.body) return;

        // Only hide if leaving the active target
        if (target !== activeTarget) return;

        // Restore title attribute for accessibility
        var tooltipText = target.getAttribute("data-tooltip");
        if (tooltipText) {
            target.setAttribute("title", tooltipText);
        }

        // Hide immediately — CSS transition provides the ≤150ms fade (Requirement 9.1 hide)
        hideTooltip();
    });
}
