# Сборка xterm.js для VibeTabula

В `renderer/vendor/` лежат готовые бандлы xterm.js 5.5.0 (`xterm.js`, `xterm-fit.js`, `xterm-links.js`, `xterm.css`), собранные из исходников с одним патчем, поэтому `npm install` для них не нужен.

**Зачем патч.** Canvas масштабирует окна через CSS `transform: scale()`, а стандартный xterm считает координаты мыши без учёта масштаба, и выделение текста съезжает при зуме. Патч `mouse-scale.patch` делит смещение курсора на текущий масштаб элемента.

## Как пересобрать

```bash
git clone --depth 1 --branch 5.5.0 https://github.com/xtermjs/xterm.js
cd xterm.js
git apply ../VibeTabula/scripts/xterm/mouse-scale.patch
cp ../VibeTabula/scripts/xterm/tsconfig.json tsconfig.mine.json
npx -p typescript tsc -p tsconfig.mine.json      # ошибки типов можно игнорировать, JS всё равно генерируется

node ../VibeTabula/scripts/xterm/bundle.js myout myout/src/browser/public/Terminal.js XtermModule ../VibeTabula/renderer/vendor/xterm.js
node ../VibeTabula/scripts/xterm/bundle.js myout myout/addons/addon-fit/src/FitAddon.js XtermFit ../VibeTabula/renderer/vendor/xterm-fit.js
node ../VibeTabula/scripts/xterm/bundle.js myout myout/addons/addon-web-links/src/WebLinksAddon.js XtermLinks ../VibeTabula/renderer/vendor/xterm-links.js
cp css/xterm.css ../VibeTabula/renderer/vendor/
```

`bundle.js` — минимальный CommonJS-бандлер (около 40 строк): он склеивает модули, скомпилированные `tsc`, в один файл и выставляет глобальную переменную (`window.XtermModule`, `window.XtermFit`, `window.XtermLinks`).

xterm.js распространяется по лицензии MIT (см. `renderer/vendor/xterm-LICENSE`).
