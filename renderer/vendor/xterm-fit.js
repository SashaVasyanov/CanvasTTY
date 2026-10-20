(function(g){var __defs={},__cache={};function __r(i){if(__cache[i])return __cache[i].exports;var m=__cache[i]={exports:{}};__defs[i](m,m.exports);return m.exports;}
__defs[0]=function(module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FitAddon = void 0;
const MINIMUM_COLS = 2;
const MINIMUM_ROWS = 1;
class FitAddon {
    activate(terminal) {
        this._terminal = terminal;
    }
    dispose() { }
    fit() {
        const dims = this.proposeDimensions();
        if (!dims || !this._terminal || isNaN(dims.cols) || isNaN(dims.rows)) {
            return;
        }
        const core = this._terminal._core;
        if (this._terminal.rows !== dims.rows || this._terminal.cols !== dims.cols) {
            core._renderService.clear();
            this._terminal.resize(dims.cols, dims.rows);
        }
    }
    proposeDimensions() {
        if (!this._terminal) {
            return undefined;
        }
        if (!this._terminal.element || !this._terminal.element.parentElement) {
            return undefined;
        }
        const core = this._terminal._core;
        const dims = core._renderService.dimensions;
        if (dims.css.cell.width === 0 || dims.css.cell.height === 0) {
            return undefined;
        }
        const scrollbarWidth = this._terminal.options.scrollback === 0 ?
            0 : core.viewport.scrollBarWidth;
        const parentElementStyle = window.getComputedStyle(this._terminal.element.parentElement);
        const parentElementHeight = parseInt(parentElementStyle.getPropertyValue('height'));
        const parentElementWidth = Math.max(0, parseInt(parentElementStyle.getPropertyValue('width')));
        const elementStyle = window.getComputedStyle(this._terminal.element);
        const elementPadding = {
            top: parseInt(elementStyle.getPropertyValue('padding-top')),
            bottom: parseInt(elementStyle.getPropertyValue('padding-bottom')),
            right: parseInt(elementStyle.getPropertyValue('padding-right')),
            left: parseInt(elementStyle.getPropertyValue('padding-left'))
        };
        const elementPaddingVer = elementPadding.top + elementPadding.bottom;
        const elementPaddingHor = elementPadding.right + elementPadding.left;
        const availableHeight = parentElementHeight - elementPaddingVer;
        const availableWidth = parentElementWidth - elementPaddingHor - scrollbarWidth;
        const geometry = {
            cols: Math.max(MINIMUM_COLS, Math.floor(availableWidth / dims.css.cell.width)),
            rows: Math.max(MINIMUM_ROWS, Math.floor(availableHeight / dims.css.cell.height))
        };
        return geometry;
    }
}
exports.FitAddon = FitAddon;

};
g.XtermFit=__r(0);})(typeof window!=='undefined'?window:globalThis);
