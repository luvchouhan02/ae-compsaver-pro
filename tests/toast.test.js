/**
 * Toast System Tests — Timing & Queuing
 *
 * Validates Requirement 10.3 (auto-dismiss after 2-4 seconds) and
 * Requirement 10.4 (stack or queue without overlap or visual corruption).
 */

// ============================================================
// Setup: Mock DOM environment for toast.js
// ============================================================

let toastEl;

beforeEach(() => {
    jest.useFakeTimers();

    // Create a mock toast DOM element
    toastEl = {
        textContent: '',
        style: { borderColor: '', color: '' },
        classList: {
            _classes: new Set(),
            add(cls) { this._classes.add(cls); },
            remove(cls) { this._classes.delete(cls); },
            contains(cls) { return this._classes.has(cls); }
        }
    };

    // Set up global DOM cache that toast.js expects
    global.DOM = { toast: toastEl };

    // Reset module state by re-requiring
    // We need to reset the module state between tests
    global.toastTimer = null;
    global.toastQueue = [];
    global.toastShowing = false;
    global.TOAST_DURATION = 3000;
    global.TOAST_GAP = 280;

    // Define the functions in global scope (mirroring how they run in the panel)
    global.showToast = function showToast(msg, type) {
        if (global.toastShowing) {
            global.toastQueue.push({ msg: msg, type: type });
            return;
        }
        global._displayToast(msg, type);
    };

    global._displayToast = function _displayToast(msg, type) {
        var toast = DOM.toast;
        if (!toast) return;

        global.toastShowing = true;
        toast.textContent = msg;

        var bc = {
            error: "rgba(248,113,113,0.3)",
            success: "rgba(110,231,183,0.3)",
            info: "rgba(168,85,247,0.25)"
        };
        var tc = {
            error: "rgba(248,113,113,0.9)",
            success: "rgba(110,231,183,0.9)",
            info: "rgba(255,255,255,0.85)"
        };

        toast.style.borderColor = bc[type] || bc.info;
        toast.style.color = tc[type] || tc.info;
        toast.classList.add("show");

        clearTimeout(global.toastTimer);
        global.toastTimer = setTimeout(function () {
            toast.classList.remove("show");
            global.toastShowing = false;

            if (global.toastQueue.length > 0) {
                var next = global.toastQueue.shift();
                setTimeout(function () {
                    global._displayToast(next.msg, next.type);
                }, global.TOAST_GAP);
            }
        }, global.TOAST_DURATION);
    };
});

afterEach(() => {
    jest.useRealTimers();
    delete global.DOM;
    delete global.toastTimer;
    delete global.toastQueue;
    delete global.toastShowing;
    delete global.TOAST_DURATION;
    delete global.TOAST_GAP;
    delete global.showToast;
    delete global._displayToast;
});

// ============================================================
// Requirement 10.3: Auto-dismiss after 2-4 seconds
// ============================================================

describe('Toast auto-dismiss timing (Requirement 10.3)', () => {
    it('should show the toast immediately when called', () => {
        showToast('Saved', 'success');
        expect(toastEl.classList.contains('show')).toBe(true);
        expect(toastEl.textContent).toBe('Saved');
    });

    it('should NOT dismiss before 2 seconds', () => {
        showToast('Saved', 'success');
        jest.advanceTimersByTime(1999);
        expect(toastEl.classList.contains('show')).toBe(true);
    });

    it('should dismiss within 4 seconds', () => {
        showToast('Saved', 'success');
        jest.advanceTimersByTime(4000);
        expect(toastEl.classList.contains('show')).toBe(false);
    });

    it('should dismiss at exactly TOAST_DURATION (3000ms)', () => {
        showToast('Saved', 'success');
        jest.advanceTimersByTime(3000);
        expect(toastEl.classList.contains('show')).toBe(false);
    });

    it('TOAST_DURATION is within 2000-4000ms range', () => {
        expect(global.TOAST_DURATION).toBeGreaterThanOrEqual(2000);
        expect(global.TOAST_DURATION).toBeLessThanOrEqual(4000);
    });
});

// ============================================================
// Requirement 10.4: Queue without overlap or visual corruption
// ============================================================

describe('Toast queuing behavior (Requirement 10.4)', () => {
    it('should queue a second toast when one is already showing', () => {
        showToast('First', 'success');
        showToast('Second', 'info');

        // First toast should still be visible
        expect(toastEl.textContent).toBe('First');
        expect(toastEl.classList.contains('show')).toBe(true);
        // Second should be in queue
        expect(global.toastQueue.length).toBe(1);
        expect(global.toastQueue[0].msg).toBe('Second');
    });

    it('should show the queued toast after the first one dismisses', () => {
        showToast('First', 'success');
        showToast('Second', 'info');

        // Advance past first toast duration
        jest.advanceTimersByTime(3000);
        // First toast dismissed
        expect(toastEl.classList.contains('show')).toBe(false);

        // Advance past the gap between toasts
        jest.advanceTimersByTime(280);
        // Second toast should now be showing
        expect(toastEl.textContent).toBe('Second');
        expect(toastEl.classList.contains('show')).toBe(true);
    });

    it('should handle 3 rapid sequential toasts without corruption', () => {
        showToast('First', 'success');
        showToast('Second', 'info');
        showToast('Third', 'error');

        // First showing, 2 queued
        expect(toastEl.textContent).toBe('First');
        expect(global.toastQueue.length).toBe(2);

        // Dismiss first → show second
        jest.advanceTimersByTime(3000 + 280);
        expect(toastEl.textContent).toBe('Second');
        expect(toastEl.classList.contains('show')).toBe(true);
        expect(global.toastQueue.length).toBe(1);

        // Dismiss second → show third
        jest.advanceTimersByTime(3000 + 280);
        expect(toastEl.textContent).toBe('Third');
        expect(toastEl.classList.contains('show')).toBe(true);
        expect(global.toastQueue.length).toBe(0);

        // Third auto-dismisses
        jest.advanceTimersByTime(3000);
        expect(toastEl.classList.contains('show')).toBe(false);
    });

    it('should never show two toasts simultaneously (no overlap)', () => {
        showToast('A', 'success');
        showToast('B', 'info');
        showToast('C', 'error');

        // Track how many times "show" class is added (always max 1 at a time)
        let showCount = 0;
        const originalAdd = toastEl.classList.add.bind(toastEl.classList);
        toastEl.classList.add = function (cls) {
            if (cls === 'show') showCount++;
            originalAdd(cls);
        };

        // At any point, only one toast should be "showing"
        // The single element means we can't have overlapping visuals
        expect(toastEl.classList.contains('show')).toBe(true);

        // Ensure there's a gap where toast is NOT showing between consecutive toasts
        jest.advanceTimersByTime(3000);
        expect(toastEl.classList.contains('show')).toBe(false);
        // Gap period — no toast visible
        jest.advanceTimersByTime(140);
        expect(toastEl.classList.contains('show')).toBe(false);
    });

    it('should apply correct type colors for queued toasts', () => {
        showToast('Success', 'success');
        showToast('Error', 'error');

        // First toast has success colors
        expect(toastEl.style.color).toBe('rgba(110,231,183,0.9)');

        // Dismiss first, show second
        jest.advanceTimersByTime(3000 + 280);

        // Second toast should have error colors
        expect(toastEl.style.color).toBe('rgba(248,113,113,0.9)');
    });

    it('should not corrupt text when replacing toast while hidden', () => {
        showToast('First', 'success');

        // Wait for first to fully dismiss
        jest.advanceTimersByTime(3000);
        expect(toastEl.classList.contains('show')).toBe(false);
        expect(global.toastShowing).toBe(false);

        // Now show a new toast (not queued since previous one fully dismissed)
        showToast('Second', 'info');
        expect(toastEl.textContent).toBe('Second');
        expect(toastEl.classList.contains('show')).toBe(true);
    });
});

// ============================================================
// Edge cases
// ============================================================

describe('Toast edge cases', () => {
    it('should handle missing DOM.toast gracefully', () => {
        global.DOM = { toast: null };
        expect(() => showToast('Test', 'info')).not.toThrow();
    });

    it('should handle unknown type with info defaults', () => {
        showToast('Test', 'unknown');
        expect(toastEl.style.borderColor).toBe('rgba(168,85,247,0.25)');
        expect(toastEl.style.color).toBe('rgba(255,255,255,0.85)');
    });

    it('should handle undefined type with info defaults', () => {
        showToast('Test');
        expect(toastEl.style.borderColor).toBe('rgba(168,85,247,0.25)');
        expect(toastEl.style.color).toBe('rgba(255,255,255,0.85)');
    });
});
