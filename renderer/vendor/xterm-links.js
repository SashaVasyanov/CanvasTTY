(function(g){var __defs={},__cache={};function __r(i){if(__cache[i])return __cache[i].exports;var m=__cache[i]={exports:{}};__defs[i](m,m.exports);return m.exports;}
__defs[0]=function(module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebLinksAddon = void 0;
const WebLinkProvider_1 = __r(1);
const strictUrlRegex = /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\\^<>`]*[^\s"':,.!?{}|\\\^~\[\]`()<>]/;
function handleLink(event, uri) {
    const newWindow = window.open();
    if (newWindow) {
        try {
            newWindow.opener = null;
        }
        catch {
        }
        newWindow.location.href = uri;
    }
    else {
        console.warn('Opening link blocked as opener could not be cleared');
    }
}
class WebLinksAddon {
    constructor(_handler = handleLink, _options = {}) {
        this._handler = _handler;
        this._options = _options;
    }
    activate(terminal) {
        this._terminal = terminal;
        const options = this._options;
        const regex = options.urlRegex || strictUrlRegex;
        this._linkProvider = this._terminal.registerLinkProvider(new WebLinkProvider_1.WebLinkProvider(this._terminal, regex, this._handler, options));
    }
    dispose() {
        this._linkProvider?.dispose();
    }
}
exports.WebLinksAddon = WebLinksAddon;

};
__defs[1]=function(module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LinkComputer = exports.WebLinkProvider = void 0;
class WebLinkProvider {
    constructor(_terminal, _regex, _handler, _options = {}) {
        this._terminal = _terminal;
        this._regex = _regex;
        this._handler = _handler;
        this._options = _options;
    }
    provideLinks(y, callback) {
        const links = LinkComputer.computeLink(y, this._regex, this._terminal, this._handler);
        callback(this._addCallbacks(links));
    }
    _addCallbacks(links) {
        return links.map(link => {
            link.leave = this._options.leave;
            link.hover = (event, uri) => {
                if (this._options.hover) {
                    const { range } = link;
                    this._options.hover(event, uri, range);
                }
            };
            return link;
        });
    }
}
exports.WebLinkProvider = WebLinkProvider;
function isUrl(urlString) {
    try {
        const url = new URL(urlString);
        const parsedBase = url.password && url.username
            ? `${url.protocol}//${url.username}:${url.password}@${url.host}`
            : url.username
                ? `${url.protocol}//${url.username}@${url.host}`
                : `${url.protocol}//${url.host}`;
        return urlString.toLocaleLowerCase().startsWith(parsedBase.toLocaleLowerCase());
    }
    catch (e) {
        return false;
    }
}
class LinkComputer {
    static computeLink(y, regex, terminal, activate) {
        const rex = new RegExp(regex.source, (regex.flags || '') + 'g');
        const [lines, startLineIndex] = LinkComputer._getWindowedLineStrings(y - 1, terminal);
        const line = lines.join('');
        let match;
        const result = [];
        while (match = rex.exec(line)) {
            const text = match[0];
            if (!isUrl(text)) {
                continue;
            }
            const [startY, startX] = LinkComputer._mapStrIdx(terminal, startLineIndex, 0, match.index);
            const [endY, endX] = LinkComputer._mapStrIdx(terminal, startY, startX, text.length);
            if (startY === -1 || startX === -1 || endY === -1 || endX === -1) {
                continue;
            }
            const range = {
                start: {
                    x: startX + 1,
                    y: startY + 1
                },
                end: {
                    x: endX,
                    y: endY + 1
                }
            };
            result.push({ range, text, activate });
        }
        return result;
    }
    static _getWindowedLineStrings(lineIndex, terminal) {
        let line;
        let topIdx = lineIndex;
        let bottomIdx = lineIndex;
        let length = 0;
        let content = '';
        const lines = [];
        if ((line = terminal.buffer.active.getLine(lineIndex))) {
            const currentContent = line.translateToString(true);
            if (line.isWrapped && currentContent[0] !== ' ') {
                length = 0;
                while ((line = terminal.buffer.active.getLine(--topIdx)) && length < 2048) {
                    content = line.translateToString(true);
                    length += content.length;
                    lines.push(content);
                    if (!line.isWrapped || content.indexOf(' ') !== -1) {
                        break;
                    }
                }
                lines.reverse();
            }
            lines.push(currentContent);
            length = 0;
            while ((line = terminal.buffer.active.getLine(++bottomIdx)) && line.isWrapped && length < 2048) {
                content = line.translateToString(true);
                length += content.length;
                lines.push(content);
                if (content.indexOf(' ') !== -1) {
                    break;
                }
            }
        }
        return [lines, topIdx];
    }
    static _mapStrIdx(terminal, lineIndex, rowIndex, stringIndex) {
        const buf = terminal.buffer.active;
        const cell = buf.getNullCell();
        let start = rowIndex;
        while (stringIndex) {
            const line = buf.getLine(lineIndex);
            if (!line) {
                return [-1, -1];
            }
            for (let i = start; i < line.length; ++i) {
                line.getCell(i, cell);
                const chars = cell.getChars();
                const width = cell.getWidth();
                if (width) {
                    stringIndex -= chars.length || 1;
                    if (i === line.length - 1 && chars === '') {
                        const line = buf.getLine(lineIndex + 1);
                        if (line && line.isWrapped) {
                            line.getCell(0, cell);
                            if (cell.getWidth() === 2) {
                                stringIndex += 1;
                            }
                        }
                    }
                }
                if (stringIndex < 0) {
                    return [lineIndex, i];
                }
            }
            lineIndex++;
            start = 0;
        }
        return [lineIndex, start];
    }
}
exports.LinkComputer = LinkComputer;

};
g.XtermLinks=__r(0);})(typeof window!=='undefined'?window:globalThis);
