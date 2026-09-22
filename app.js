/* 写真PDF配置ツール
 * 写真のExif GPS情報から緯度経度を取得し、PDF図面上にピンとして配置する。
 * 緯度→上下、経度→左右。写真レイヤーは 拡大/縮小=左下基点、回転=中心基点 で変形する。
 */
"use strict";

pdfjsLib.GlobalWorkerOptions.workerSrc = "lib/pdf.worker.min.js";

const M_PER_DEG_LAT = 111320; // 緯度1度あたりのおおよその距離(m)
const DEFAULT_PIN_COLOR = "#ef4444";

function hexToRgbTriple(hex) {
  const h = (hex || DEFAULT_PIN_COLOR).replace("#", "");
  return [
    parseInt(h.substring(0, 2), 16) / 255,
    parseInt(h.substring(2, 4), 16) / 255,
    parseInt(h.substring(4, 6), 16) / 255,
  ];
}
// ピンの色が明るい場合は黒文字、暗い場合は白文字にして番号を読みやすくする
function contrastTextColor(hex) {
  const [r, g, b] = hexToRgbTriple(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 0.6 ? "#111111" : "#ffffff";
}

const state = {
  pdfDoc: null,
  pdfBytesForExport: null,
  pdfName: "",
  numPages: 0,
  currentPage: 0, // 0-indexed。常に合成後PDF内での物理ページ番号(srcIndex)、または"compare"
  lastRealPage: 0, // 比較ページ表示前にいた実ページ。「プレビューに戻る」で使う
  pageView: new Map(),      // srcIndex -> { zoom(%), rotation(deg,0/90/180/270) }
  pageTransform: new Map(), // srcIndex -> { scale, rotationDeg, offsetX, offsetY }
  pageViewport: null,       // 現在描画中ページの pdf.js viewport (canvas座標系の基準)

  // ページの表示順とゴミ箱状態。{srcIndex, trashed} の配列で、並びが「ページ一覧」の表示順。
  // srcIndexは合成後PDF内での物理ページ番号で、並べ替え・ゴミ箱に入れても不変
  // (pageView/pageTransform/photo.pageIndexは常にこのsrcIndexをキーにする)。
  pages: [],
  pdfSources: [], // 取り込んだPDFファイルの履歴 [{name, pageCount}]（表示用）

  photos: [],  // { id, file, name, thumbDataUrl, lat, lon, hasGps, pageIndex, baseX, baseY, manualOffset:{x,y}|null }
  nextPhotoId: 1,

  thumbSize: 70,
  pinSize: 9,
  leaderLineWidth: 1.4,
  leaderLineLength: 4,
  leaderLineColor: "#2563eb",
  arrowWidth: 2,
  arrowLength: 24,
  arrowColor: "#16a34a",
  thumbBorderWidth: 2,
  thumbBorderColor: "#2563eb",

  layerPanMode: false,
  draggingPin: null,   // photo id being dragged
  draggingArrow: null, // photo id whose direction arrow is being dragged
  draggingThumb: null, // photo id whose thumbnail(だけ)を移動中
  draggingLayer: false,
  dragLast: null,

  calibrating: false,
  calibPoints: [],      // clicked target points [{x,y}]
  calibSelectedIds: [], // selected photo ids (max 2)

  selectedPhotoIds: [], // 一覧で複数選択中の写真id（一括ページ移動・一括削除用）
  lastClickedPhotoId: null, // shift+クリックの範囲選択の基点

  currentProjectDirHandle: null, // 直前に読込み/保存したプロジェクトフォルダ(FileSystemDirectoryHandle)。「保存(上書)」用
  currentProjectName: null,

  // ---- 日付比較(1回目/2回目の同一地点写真の突き合わせ) ----
  dayCompareThreshold: 1,  // 同じ地点とみなす距離(m)
  dayCompareGapHours: 2,   // 撮影時刻の間隔がこの時間(時間)以上空いたら別回とみなす
  // [{ originId, label, roundCandidates: [[round0の写真id,...], [round1の...], …] }]。地点ごとに
  // 何回でも列を持てる。1回目はroundCandidates[0]、2回目以降で新規に登場した地点も累積で登録される。
  dayCompareRows: [],
  dayCompareRoundLabels: [], // 各回の表示ラベル(撮影時刻の範囲)。roundCandidatesの列数と対応
};

const el = (id) => document.getElementById(id);

// ---------- 初期化 ----------
function init() {
  wireDropzone(el("pdfDrop"), el("pdfInput"), el("pdfPickBtn"), onPdfFiles);
  wireDropzone(el("photoDrop"), el("photoInput"), el("photoPickBtn"), onPhotoFiles);

  el("prevPageBtn").addEventListener("click", () => {
    const target = adjacentVisiblePage(state.currentPage, -1);
    if (target != null) gotoPage(target);
  });
  el("nextPageBtn").addEventListener("click", () => {
    const target = adjacentVisiblePage(state.currentPage, 1);
    if (target != null) gotoPage(target);
  });

  wireRangeWithNumber("pdfZoom", "pdfZoomVal", (val) => {
    if (setPageZoom(state.currentPage, val)) syncLayerControlsToCurrentPage();
    renderPage();
  });
  wireRangeWithNumber("pdfRotate", "pdfRotateVal", (val) => {
    const v = getPageView(state.currentPage);
    v.rotation = val;
    applyCanvasTransform();
    renderPins(); // ピンの描画位置はこの回転角ぶん逆算しているため、値が変わるたび再描画が必要
  });

  el("layerScale").addEventListener("input", (e) => {
    const t = getPageTransform(state.currentPage);
    t.scale = sliderToScale(Number(e.target.value));
    el("layerScaleVal").value = t.scale.toFixed(2);
    renderPins();
  });
  el("layerScaleVal").addEventListener("change", (e) => {
    let val = Number(e.target.value);
    if (!isFinite(val) || val <= 0) val = 1;
    val = Math.min(100, Math.max(0.01, val));
    const t = getPageTransform(state.currentPage);
    t.scale = val;
    el("layerScale").value = scaleToSlider(val);
    el("layerScaleVal").value = val.toFixed(2);
    renderPins();
  });

  el("layerScaleY").addEventListener("input", (e) => {
    const t = getPageTransform(state.currentPage);
    t.scaleY = Number(e.target.value);
    el("layerScaleYVal").value = t.scaleY.toFixed(2);
    renderPins();
  });
  el("layerScaleYVal").addEventListener("change", (e) => {
    let val = Number(e.target.value);
    if (!isFinite(val) || val <= 0) val = 1;
    val = Math.min(3, Math.max(0.2, val));
    const t = getPageTransform(state.currentPage);
    t.scaleY = val;
    el("layerScaleY").value = val;
    el("layerScaleYVal").value = val.toFixed(2);
    renderPins();
  });
  el("layerScaleX").addEventListener("input", (e) => {
    const t = getPageTransform(state.currentPage);
    t.scaleX = Number(e.target.value);
    el("layerScaleXVal").value = t.scaleX.toFixed(2);
    renderPins();
  });
  el("layerScaleXVal").addEventListener("change", (e) => {
    let val = Number(e.target.value);
    if (!isFinite(val) || val <= 0) val = 1;
    val = Math.min(3, Math.max(0.2, val));
    const t = getPageTransform(state.currentPage);
    t.scaleX = val;
    el("layerScaleX").value = val;
    el("layerScaleXVal").value = val.toFixed(2);
    renderPins();
  });

  wireRangeWithNumber("layerRotate", "layerRotateVal", (val) => {
    const t = getPageTransform(state.currentPage);
    t.rotationDeg = val;
    renderPins();
  });
  wireRangeWithNumber("thumbSize", "thumbSizeVal", (val) => {
    state.thumbSize = val;
    renderPins();
  });
  wireRangeWithNumber("thumbBorderWidth", "thumbBorderWidthVal", (val) => {
    state.thumbBorderWidth = val;
    renderPins();
  });
  el("thumbBorderColor").addEventListener("input", (e) => {
    state.thumbBorderColor = e.target.value;
    renderPins();
  });
  wireRangeWithNumber("pinSize", "pinSizeVal", (val) => {
    state.pinSize = val;
    renderPins();
  });
  wireRangeWithNumber("leaderWidth", "leaderWidthVal", (val) => {
    state.leaderLineWidth = val;
    renderPins();
  });
  wireRangeWithNumber("leaderLength", "leaderLengthVal", (val) => {
    state.leaderLineLength = val;
    renderPins();
  });
  el("leaderColor").addEventListener("input", (e) => {
    state.leaderLineColor = e.target.value;
    renderPins();
  });
  wireRangeWithNumber("arrowWidth", "arrowWidthVal", (val) => {
    state.arrowWidth = val;
    renderPins();
  });
  wireRangeWithNumber("arrowLength", "arrowLengthVal", (val) => {
    state.arrowLength = val;
    renderPins();
  });
  el("arrowColor").addEventListener("input", (e) => {
    state.arrowColor = e.target.value;
    renderPins();
  });

  initPinDetailPanel();

  el("layerPanBtn").addEventListener("click", () => {
    state.layerPanMode = !state.layerPanMode;
    el("layerPanBtn").classList.toggle("active", state.layerPanMode);
    if (state.layerPanMode) { state.calibrating = false; updateCalibUi(); }
  });
  el("resetLayerBtn").addEventListener("click", () => {
    state.pageTransform.set(state.currentPage, defaultTransform());
    syncLayerControlsToCurrentPage();
    renderPins();
  });
  el("calibrateBtn").addEventListener("click", () => {
    state.calibrating = !state.calibrating;
    state.calibPoints = [];
    state.calibSelectedIds = [];
    if (state.calibrating) { state.layerPanMode = false; el("layerPanBtn").classList.remove("active"); }
    updateCalibUi();
    renderPhotoList();
  });

  el("exportPdfBtn").addEventListener("click", exportCompositePdf);
  el("exportExcelBtn").addEventListener("click", exportExcel);

  el("dayCompareThreshold").addEventListener("change", (e) => {
    const v = Number(e.target.value);
    if (!isNaN(v) && v >= 0) state.dayCompareThreshold = v;
  });
  el("dayCompareGapHours").addEventListener("change", (e) => {
    const v = Number(e.target.value);
    if (!isNaN(v) && v > 0) state.dayCompareGapHours = v;
  });
  el("dayCompareRunBtn").addEventListener("click", () => {
    if (!state.pdfDoc) { alert("先にPDFを読み込んでください。"); return; }
    runDayComparison();
  });
  el("dayCompareViewBtn").addEventListener("click", toggleComparePage);

  el("saveOverwriteBtn").addEventListener("click", saveProjectOverwrite);
  el("saveAsBtn").addEventListener("click", saveProjectAs);
  el("loadProjectBtn").addEventListener("click", startLoadProject);
  el("projectInput").addEventListener("change", (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (file) onProjectFileSelected(file);
  });

  const pinCanvas = el("pinCanvas");
  pinCanvas.addEventListener("mousedown", onCanvasMouseDown);
  window.addEventListener("mousemove", onCanvasMouseMove);
  window.addEventListener("mouseup", onCanvasMouseUp);
  pinCanvas.addEventListener("click", onCanvasClick);
  pinCanvas.addEventListener("dblclick", onCanvasDblClick);
  pinCanvas.addEventListener("contextmenu", onCanvasContextMenu);
  window.addEventListener("click", hideContextMenu);
  window.addEventListener("scroll", hideContextMenu, true);

  el("canvasScroll").addEventListener("wheel", onCanvasWheel, { passive: false });

  updateCalibUi();
  initSplitHandle();
}

// ---------- マウスホイール操作 ----------
// Ctrl+ホイール: PDF表示倍率を変更。ホイールのみ: 縦スクロール、端まで来たら前後のページへ移動。
function onCanvasWheel(e) {
  if (!state.pdfDoc) return;

  if (e.ctrlKey) {
    e.preventDefault();
    zoomByWheel(e.deltaY);
    return;
  }

  const scroller = el("canvasScroll");
  const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
  const atTop = scroller.scrollTop <= 0;
  const nextPageIndex = adjacentVisiblePage(state.currentPage, 1);
  const prevPageIndex = adjacentVisiblePage(state.currentPage, -1);
  if (e.deltaY > 0 && atBottom && nextPageIndex != null) {
    e.preventDefault();
    goToAdjacentPageViaScroll(nextPageIndex, 1);
  } else if (e.deltaY < 0 && atTop && prevPageIndex != null) {
    e.preventDefault();
    goToAdjacentPageViaScroll(prevPageIndex, -1);
  }
  // それ以外は既定の縦(横)スクロール動作に任せる
}

function zoomByWheel(deltaY) {
  const v = getPageView(state.currentPage);
  const factor = Math.exp(-deltaY * 0.0015);
  const newZoom = Math.round(v.zoom * factor);
  if (!setPageZoom(state.currentPage, newZoom)) return;
  el("pdfZoom").value = v.zoom;
  el("pdfZoomVal").value = v.zoom;
  syncLayerControlsToCurrentPage();
  renderPage();
}

// 表示倍率を変更する。pdf.jsは図面をキャンバス原点(0,0)基準で拡大縮小するため、
// 写真レイヤー(と個別に手動移動したピン)も同じ倍率で原点基準にスケールし直し、
// 図面上の位置がズレないようにする。変更があった場合のみ true を返す。
function setPageZoom(pageIndex, newZoom) {
  const v = getPageView(pageIndex);
  newZoom = Math.min(400, Math.max(25, Math.round(newZoom)));
  if (newZoom === v.zoom) return false;
  const factor = newZoom / v.zoom;
  v.zoom = newZoom;
  rescaleLayerForZoom(pageIndex, factor);
  return true;
}

function rescaleLayerForZoom(pageIndex, factor) {
  const t = getPageTransform(pageIndex);
  const photosOnPage = getPagePhotos(pageIndex);
  if (photosOnPage.length) {
    const bb = getBaseBBox(photosOnPage);
    const anchor = { x: bb.minX, y: bb.maxY };
    t.offsetX = factor * t.offsetX + (factor - 1) * anchor.x;
    t.offsetY = factor * t.offsetY + (factor - 1) * anchor.y;
  } else {
    t.offsetX *= factor;
    t.offsetY *= factor;
  }
  t.scale *= factor;
  // 手動で微調整した写真(manualOffset)は基準(base)座標系の値なので、
  // レイヤー変換(t.scale/rotationDeg)を通じて自動的に一緒にスケールされる。
}

async function goToAdjacentPageViaScroll(targetPageIndex, direction) {
  await gotoPage(targetPageIndex);
  const scroller = el("canvasScroll");
  scroller.scrollTop = direction > 0 ? 0 : scroller.scrollHeight;
}

// ---------- 左右分割の境界ドラッグ ----------
function initSplitHandle() {
  const handle = el("splitHandle");
  const layout = el("mainLayout");
  const preview = el("previewPane");
  let dragging = false;

  handle.addEventListener("mousedown", (e) => {
    dragging = true;
    handle.classList.add("dragging");
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const rect = layout.getBoundingClientRect();
    let pct = (e.clientX - rect.left) / rect.width * 100;
    pct = Math.min(90, Math.max(30, pct));
    preview.style.flex = `0 0 ${pct}%`;
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("dragging");
  });
}

function defaultTransform() {
  // scaleX/scaleY は scale に掛かる縦横individual補正倍率(既定1=補正なし)。
  // 図面とGPSとで縦横比がズレている場合に、通常の拡大縮小とは別に微調整する。
  return { scale: 1, scaleX: 1, scaleY: 1, rotationDeg: 0, offsetX: 0, offsetY: 0, centered: false };
}
function getPageTransform(pageIndex) {
  if (!state.pageTransform.has(pageIndex)) state.pageTransform.set(pageIndex, defaultTransform());
  return state.pageTransform.get(pageIndex);
}
function getPageView(pageIndex) {
  if (!state.pageView.has(pageIndex)) state.pageView.set(pageIndex, { zoom: 100, rotation: 0 });
  return state.pageView.get(pageIndex);
}

// ---------- ページの表示順・ゴミ箱(state.pages) ----------
// ゴミ箱に入っていないページだけを、現在の表示順で返す
function visiblePages() {
  return state.pages.filter((pg) => !pg.trashed);
}
// srcIndexで指定したページから見て、表示順でdirection(+1/-1)隣にある
// ゴミ箱でないページのsrcIndexを返す。存在しなければnull。
function adjacentVisiblePage(srcIndex, direction) {
  const visible = visiblePages();
  const pos = visible.findIndex((pg) => pg.srcIndex === srcIndex);
  if (pos < 0) return null;
  const next = visible[pos + direction];
  return next ? next.srcIndex : null;
}
// srcIndexのページが一覧上で何番目(1始まり)に表示されているかを返す。
// ゴミ箱に入っている場合はnull。出力(PDF/Excel)の「ページN」表記に使う。
function displayPageNumber(srcIndex) {
  const pos = visiblePages().findIndex((pg) => pg.srcIndex === srcIndex);
  return pos < 0 ? null : pos + 1;
}
// スライダー(-300..300) <-> 倍率。0 = ×1、+300 = ×約20、-300 = ×約0.05 の対数スケール
function sliderToScale(v) { return Math.pow(10, v / 150); }
function scaleToSlider(s) { return Math.log10(s) * 150; }

// range(スライダー)と number(数値入力)を相互に同期させる共通処理
function wireRangeWithNumber(rangeId, numberId, onChange) {
  const range = el(rangeId), number = el(numberId);
  const min = Number(range.min), max = Number(range.max);
  const apply = (val) => {
    val = Math.min(max, Math.max(min, val));
    range.value = val;
    number.value = val;
    onChange(val);
  };
  range.addEventListener("input", () => apply(Number(range.value)));
  number.addEventListener("change", () => apply(Number(number.value) || 0));
}

// PDFビューの回転角(0-360)はpdf.js側の再描画は行わず、CSSの回転表示のみ更新する
function applyCanvasTransform() {
  const v = getPageView(state.currentPage);
  el("canvasStack").style.transform = `rotate(${v.rotation || 0}deg)`;
  // pinCanvasは親(canvasStack)と逆方向に回転させて相殺し、見た目は常にまっすぐ(回転なし)に保つ。
  // ピンの位置自体はrenderPins内でこの回転角ぶん逆算して描画するため、図面と一緒に正しい位置に表示される。
  el("pinCanvas").style.transform = `rotate(${-(v.rotation || 0)}deg)`;
}

// ---------- ドラッグ&ドロップ共通 ----------
function wireDropzone(zoneEl, inputEl, btnEl, onFiles) {
  btnEl.addEventListener("click", () => inputEl.click());
  inputEl.addEventListener("change", () => { onFiles(Array.from(inputEl.files)); inputEl.value = ""; });
  ["dragenter", "dragover"].forEach((ev) =>
    zoneEl.addEventListener(ev, (e) => { e.preventDefault(); zoneEl.classList.add("dragover"); }));
  ["dragleave", "drop"].forEach((ev) =>
    zoneEl.addEventListener(ev, (e) => { e.preventDefault(); zoneEl.classList.remove("dragover"); }));
  zoneEl.addEventListener("drop", (e) => {
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length) onFiles(files);
  });
}

// ---------- PDF読込 ----------
// 複数のPDF(それぞれ複数ページ可)を取り込める。既にPDFを読み込み済みの場合は
// 後から取り込んだページを末尾に追加する(既存ページの設定・写真配置はそのまま維持)。
async function onPdfFiles(files) {
  const pdfFiles = files.filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
  if (!pdfFiles.length) { alert("PDFファイルを選択してください。"); return; }

  const { PDFDocument } = PDFLib;
  const isFirstImport = !state.pdfDoc;
  const mergedDoc = state.pdfBytesForExport
    ? await PDFDocument.load(state.pdfBytesForExport)
    : await PDFDocument.create();

  let firstNewSrcIndex = null;
  for (const file of pdfFiles) {
    let srcDoc;
    try {
      srcDoc = await PDFDocument.load(await file.arrayBuffer());
    } catch (err) {
      console.error(err);
      alert(`「${file.name}」はPDFとして読み込めませんでした。`);
      continue;
    }
    const copiedPages = await mergedDoc.copyPages(srcDoc, srcDoc.getPageIndices());
    const startSrcIndex = mergedDoc.getPageCount();
    if (firstNewSrcIndex == null) firstNewSrcIndex = startSrcIndex;
    copiedPages.forEach((p, i) => {
      mergedDoc.addPage(p);
      state.pages.push({ srcIndex: startSrcIndex + i, trashed: false });
    });
    state.pdfSources.push({ name: file.name, pageCount: copiedPages.length });
  }
  if (firstNewSrcIndex == null) return; // すべて読み込みに失敗した

  const mergedBytes = await mergedDoc.save();
  state.pdfBytesForExport = mergedBytes.slice(0);
  state.pdfName = state.pdfSources.length === 1
    ? state.pdfSources[0].name
    : baseNameNoExt(state.pdfSources[0].name) + "_他" + (state.pdfSources.length - 1) + "件";

  const loadingTask = pdfjsLib.getDocument({ data: mergedBytes.slice(0) });
  state.pdfDoc = await loadingTask.promise;
  state.numPages = state.pdfDoc.numPages;

  el("pdfMeta").textContent =
    `${state.pdfSources.map((s) => s.name).join("、")}\n合計 ${state.numPages} ページ（${state.pdfSources.length}個のPDF）`;
  el("pageListBlock").hidden = false;
  el("viewerHint").hidden = true;
  buildPageList();
  await gotoPage(isFirstImport ? firstNewSrcIndex : state.currentPage);
}

function buildPageList() {
  const box = el("pageList");
  box.innerHTML = "";
  const visible = visiblePages();
  visible.forEach((pg, i) => {
    const pageIndex = pg.srcIndex;
    const row = document.createElement("div");
    row.className = "pageThumb" + (pageIndex === state.currentPage ? " active" : "");
    row.innerHTML = `<span>ページ ${i + 1}</span><span class="count">${countPhotosOnPage(pageIndex)}枚</span>` +
      `<button type="button" class="pageMoveBtn" data-dir="-1" title="前に入れ替え"${i === 0 ? " disabled" : ""}>▲</button>` +
      `<button type="button" class="pageMoveBtn" data-dir="1" title="後ろに入れ替え"${i === visible.length - 1 ? " disabled" : ""}>▼</button>` +
      `<button type="button" class="renumberBtn" title="このページのピン番号を振り直す(1,2,3…)">🔢</button>` +
      `<button type="button" class="pageTrashBtn" title="このページをゴミ箱へ移動">🗑</button>`;
    row.addEventListener("click", () => gotoPage(pageIndex));
    row.querySelector(".renumberBtn").addEventListener("click", (e) => {
      e.stopPropagation();
      renumberPage(pageIndex);
    });
    row.querySelectorAll(".pageMoveBtn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        movePageInOrder(pageIndex, Number(btn.dataset.dir));
      });
    });
    row.querySelector(".pageTrashBtn").addEventListener("click", (e) => {
      e.stopPropagation();
      trashPage(pageIndex);
    });
    box.appendChild(row);
  });

  // 日付比較ページ(実際のPDFページではない仮想ページ)。常に一覧の最後に表示する。
  if (visible.length) {
    const compareRow = document.createElement("div");
    compareRow.className = "pageThumb" + (state.currentPage === "compare" ? " active" : "");
    compareRow.innerHTML = `<span>📊 日付比較ページ</span>`;
    compareRow.addEventListener("click", () => gotoComparePage());
    box.appendChild(compareRow);
  }

  const trashed = state.pages.filter((pg) => pg.trashed);
  el("pageTrashBlock").hidden = trashed.length === 0;
  el("pageTrashCount").textContent = trashed.length ? `(${trashed.length})` : "";
  const trashBox = el("pageTrashList");
  trashBox.innerHTML = "";
  trashed.forEach((pg) => {
    const row = document.createElement("div");
    row.className = "pageThumb";
    row.innerHTML = `<span>ページ（写真${countPhotosOnPage(pg.srcIndex)}枚）</span>` +
      `<button type="button" class="restoreBtn">復元</button>`;
    row.querySelector(".restoreBtn").addEventListener("click", () => restorePage(pg.srcIndex));
    trashBox.appendChild(row);
  });
}

// ページの表示順を、隣接するゴミ箱でないページと入れ替える(direction: -1=前へ, 1=後ろへ)
function movePageInOrder(srcIndex, direction) {
  const fullIdx = state.pages.findIndex((pg) => pg.srcIndex === srcIndex);
  if (fullIdx < 0) return;
  let neighborIdx = fullIdx + direction;
  while (neighborIdx >= 0 && neighborIdx < state.pages.length && state.pages[neighborIdx].trashed) {
    neighborIdx += direction;
  }
  if (neighborIdx < 0 || neighborIdx >= state.pages.length) return;
  const tmp = state.pages[fullIdx];
  state.pages[fullIdx] = state.pages[neighborIdx];
  state.pages[neighborIdx] = tmp;
  buildPageList();
}

// ページをゴミ箱へ移動する。写真配置やページ自体のデータは削除せず保持したまま、
// ページ一覧・ナビゲーション・出力からだけ除外する(「復元」でいつでも元に戻せる)。
function trashPage(srcIndex) {
  const pg = state.pages.find((p) => p.srcIndex === srcIndex);
  if (!pg) return;
  const photoCount = countPhotosOnPage(srcIndex);
  if (photoCount > 0 && !confirm(`このページには写真が${photoCount}枚配置されています。ゴミ箱へ移動しますか？\n(写真の配置情報は保持され、「復元」でいつでも元に戻せます)`)) {
    return;
  }
  pg.trashed = true;
  if (state.currentPage === srcIndex) {
    const next = visiblePages()[0];
    if (next) {
      gotoPage(next.srcIndex);
    } else {
      state.currentPage = -1;
      el("pdfCanvas").getContext("2d").clearRect(0, 0, el("pdfCanvas").width, el("pdfCanvas").height);
      el("pinCanvas").getContext("2d").clearRect(0, 0, el("pinCanvas").width, el("pinCanvas").height);
      el("pageIndicator").textContent = "- / -";
      el("viewerHint").hidden = false;
      buildPageList();
      renderPhotoList();
    }
  } else {
    buildPageList();
    renderPhotoList();
  }
}
function restorePage(srcIndex) {
  const pg = state.pages.find((p) => p.srcIndex === srcIndex);
  if (!pg) return;
  pg.trashed = false;
  if (state.currentPage < 0) {
    el("viewerHint").hidden = true;
    gotoPage(srcIndex);
  } else {
    buildPageList();
    renderPhotoList();
  }
}

// そのページのピンを現在の並び順(番号順、負の数も含む)のまま 1,2,3… に振り直す
function renumberPage(pageIndex) {
  const photos = getPagePhotos(pageIndex);
  if (!photos.length) return;
  const sorted = [...photos].sort((a, b) => compareLabels(labelOfPhoto(a), labelOfPhoto(b)));
  sorted.forEach((p, i) => { p.numberLabel = String(i + 1); });
  renderPhotoList();
  renderPins();
}
function countPhotosOnPage(pageIndex) {
  return state.photos.filter((p) => p.pageIndex === pageIndex && !p.trashed).length;
}

async function gotoPage(index) {
  if (!state.pdfDoc) return;
  const visible = visiblePages();
  const pos = visible.findIndex((pg) => pg.srcIndex === index);
  if (pos < 0) return; // ゴミ箱に入っている、または存在しないページ
  el("compareView").hidden = true;
  el("canvasScroll").hidden = false;
  state.currentPage = index;
  state.lastRealPage = index; // 比較ページから「戻る」際に使う
  el("dayCompareViewBtn").textContent = "比較ページを表示";
  el("pageIndicator").textContent = `${pos + 1} / ${visible.length}`;
  const v = getPageView(index);
  el("pdfZoom").value = v.zoom;
  el("pdfZoomVal").value = v.zoom;
  el("pdfRotate").value = v.rotation;
  el("pdfRotateVal").value = v.rotation;
  syncLayerControlsToCurrentPage();
  buildPageList();
  await renderPage();
  renderPhotoList();
}

// 日付比較ページ(実際のPDFページを持たない仮想ページ)を表示する
function gotoComparePage() {
  if (!state.pdfDoc) return;
  state.currentPage = "compare";
  el("canvasScroll").hidden = true;
  el("compareView").hidden = false;
  el("dayCompareViewBtn").textContent = "プレビューに戻る";
  el("pageIndicator").textContent = "比較";
  buildPageList();
  renderComparePage();
  renderPhotoList();
}
// 「比較ページを表示」ボタン用。比較ページ表示中は元のページに戻る動作に切り替わる。
function toggleComparePage() {
  if (state.currentPage === "compare") {
    const visible = visiblePages();
    const target = visible.some((pg) => pg.srcIndex === state.lastRealPage)
      ? state.lastRealPage
      : (visible[0] ? visible[0].srcIndex : null);
    if (target != null) gotoPage(target);
  } else {
    gotoComparePage();
  }
}

function comparePhotoCardHtml(photo, label) {
  const color = photo.pinColor || DEFAULT_PIN_COLOR;
  return `<img src="${photo.thumbDataUrl}" alt="">` +
    `<div class="pinBadge" style="background:${color}; color:${contrastTextColor(color)}">${label}</div>` +
    `<div class="name" title="${photo.name}">${photo.name}</div>`;
}

// 「日付比較ページ」の中身を組み立てる。列=回(1回目、2回目、…何回でも)、行=地点(ピン番号)。
function renderComparePage() {
  const box = el("compareView");
  if (!box) return;
  box.innerHTML = "";

  const { roundLabels, rows } = buildCompareLayoutRows();
  if (!roundLabels.length) {
    box.innerHTML = `<div class="hint">撮影日時(Exif)付きのGPS写真が見つかりません。日付比較には撮影日時の入った写真が必要です。「照合する」を押すと結果が表示されます。</div>`;
    return;
  }

  const info = document.createElement("div");
  info.className = "hint";
  info.textContent = roundLabels.map((label, i) => `${i + 1}回目：${label}`).join(" / ");
  box.appendChild(info);

  const gridCols = `repeat(${roundLabels.length}, minmax(140px, 1fr))`;

  const header = document.createElement("div");
  header.className = "compareRow compareHeaderRow";
  header.style.gridTemplateColumns = gridCols;
  roundLabels.forEach((label, i) => {
    const cell = document.createElement("div");
    cell.className = "compareCell compareHeaderCell";
    cell.textContent = `${i + 1}回目`;
    header.appendChild(cell);
  });
  box.appendChild(header);

  rows.forEach((row) => {
    const rowEl = document.createElement("div");
    rowEl.className = "compareRow";
    rowEl.style.gridTemplateColumns = gridCols;

    row.byRound.forEach((photos, roundIdx) => {
      const cell = document.createElement("div");
      cell.className = "compareCell";
      if (!photos.length) {
        cell.innerHTML = `<div class="hint">-</div>`;
      }
      photos.forEach((photo) => {
        const card = document.createElement("div");
        card.className = "comparePhotoCard";
        card.innerHTML = comparePhotoCardHtml(photo, roundIdx === 0 ? labelOfPhoto(photo) : photo.numberLabel);
        if (roundIdx > 0) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "removeBtn";
          btn.title = "候補から外す";
          btn.textContent = "×";
          btn.addEventListener("click", () => removeDayCompareCandidate(row.originId, roundIdx, photo.id));
          card.appendChild(btn);
        }
        cell.appendChild(card);
      });
      rowEl.appendChild(cell);
    });
    box.appendChild(rowEl);
  });
}

let currentRenderTask = null;
async function renderPage() {
  if (!state.pdfDoc) return;
  const page = await state.pdfDoc.getPage(state.currentPage + 1);
  const v = getPageView(state.currentPage);
  // 回転角(0-360)はpdf.js には渡さず、描画後にCSSでまとめて回転させる
  // (pdf.jsのviewport回転は90度単位のみ対応のため)
  const viewport = page.getViewport({ scale: v.zoom / 100 });
  state.pageViewport = viewport;

  const pdfCanvas = el("pdfCanvas");
  const pinCanvas = el("pinCanvas");
  pdfCanvas.width = pinCanvas.width = Math.ceil(viewport.width);
  pdfCanvas.height = pinCanvas.height = Math.ceil(viewport.height);
  el("canvasStack").style.width = pdfCanvas.width + "px";
  el("canvasStack").style.height = pdfCanvas.height + "px";

  // ズームスライダー操作やページ連打で render() が重複起動されるとpdf.jsが例外を
  // 投げるため、前回の描画を明示的にキャンセルしてから新しい描画を開始する。
  if (currentRenderTask) currentRenderTask.cancel();
  const ctx = pdfCanvas.getContext("2d");
  const task = page.render({ canvasContext: ctx, viewport });
  currentRenderTask = task;
  try {
    await task.promise;
  } catch (err) {
    if (err && err.name === "RenderingCancelledException") return;
    throw err;
  }
  if (currentRenderTask === task) currentRenderTask = null;
  applyCanvasTransform();
  renderPins();
}

// ---------- 写真読込 & Exif ----------
async function onPhotoFiles(files) {
  const imgFiles = files.filter((f) => /image\//.test(f.type) || /\.(jpe?g|png|tiff?|heic)$/i.test(f.name));
  if (!imgFiles.length) return;
  el("photoMeta").textContent = `読み込み中... 0/${imgFiles.length}`;
  let done = 0;
  for (const file of imgFiles) {
    await addPhoto(file);
    done++;
    el("photoMeta").textContent = `読み込み中... ${done}/${imgFiles.length}`;
  }
  el("photoMeta").textContent = `${state.photos.length} 枚読み込み済み（GPSなし: ${state.photos.filter((p) => !p.hasGps).length}枚）`;
  recomputeBasePositions();
  renderPhotoList();
  buildPageList();
  renderPins();
}

async function addPhoto(file) {
  let gps = null;
  try { gps = await exifr.gps(file); } catch (e) { gps = null; }
  let capturedAt = null;
  try {
    const exifData = await exifr.parse(file, { pick: ["DateTimeOriginal", "CreateDate"] });
    const raw = exifData && (exifData.DateTimeOriginal || exifData.CreateDate);
    if (raw) capturedAt = raw instanceof Date ? raw : new Date(raw);
    if (capturedAt && isNaN(capturedAt.getTime())) capturedAt = null;
  } catch (e) { capturedAt = null; }

  const { dataUrl: thumbDataUrl, aspectRatio } = await makeThumbnail(file, 320);

  const photo = {
    id: state.nextPhotoId++,
    file,
    name: file.name,
    thumbDataUrl,
    aspectRatio, // 元写真の横÷縦。サムネイル枠を元の縦横比のまま表示するために使う
    lat: gps ? gps.latitude : null,
    lon: gps ? gps.longitude : null,
    hasGps: !!gps,
    capturedAt, // Exif撮影日時(Date|null)。日付比較機能(1日目/2日目の自動グループ分け)に使う
    pageIndex: typeof state.currentPage === "number" && state.currentPage >= 0
      ? state.currentPage
      : (visiblePages()[0] ? visiblePages()[0].srcIndex : 0),
    baseX: 0, baseY: 0,
    manualOffset: null,  // {x,y}|null。baseX/baseYと同じ基準座標系での手動位置調整分(ピン自体の位置)
    thumbOffset: null,   // {x,y}|null。画面ピクセル単位でのサムネイル位置の手動微調整分(ピンからは独立。重なり回避用)
    numberLabel: null,   // null = 自動採番（一覧順）。手動変更するとその文字列を表示
    directionDeg: 0,     // 撮影方向（レイヤー回転0のときの上方向を0とする、時計回り）
    trashed: false,      // true の間はゴミ箱に入っており、ピン等には表示されない
    pinColor: DEFAULT_PIN_COLOR, // ピン(番号バッジ)の色。プレビューと一覧で共通
    // 以下は null なら一括設定(state.pinSize等)に従い、値があればこの写真だけ個別に上書きする
    pinSizeOverride: null,
    leaderWidthOverride: null,
    leaderLengthOverride: null,
    leaderColorOverride: null,
    arrowWidthOverride: null,
    arrowLengthOverride: null,
    arrowColorOverride: null,
    thumbBorderWidthOverride: null,
    thumbBorderColorOverride: null,
  };
  state.photos.push(photo);
}

function makeThumbnail(file, maxSize) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      let w = img.naturalWidth, h = img.naturalHeight;
      const aspectRatio = w / h;
      const ratio = Math.min(1, maxSize / Math.max(w, h));
      w = Math.round(w * ratio); h = Math.round(h * ratio);
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      c.getContext("2d").drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve({ dataUrl: c.toDataURL("image/jpeg", 0.85), aspectRatio });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("image load failed")); };
    img.src = url;
  });
}

// 緯度経度 -> ローカル平面座標(m)。緯度=上下(Y、北がマイナス=上)、経度=左右(X、東がプラス=右)
function recomputeBasePositions() {
  const withGps = state.photos.filter((p) => p.hasGps);
  if (!withGps.length) return;
  const lat0 = withGps.reduce((s, p) => s + p.lat, 0) / withGps.length;
  const lon0 = withGps.reduce((s, p) => s + p.lon, 0) / withGps.length;
  const mPerDegLon = M_PER_DEG_LAT * Math.cos(lat0 * Math.PI / 180);
  for (const p of withGps) {
    p.baseX = (p.lon - lon0) * mPerDegLon;
    p.baseY = -(p.lat - lat0) * M_PER_DEG_LAT;
  }
}

// ページごとに違う色を割り当てる(何ページあっても巡回して割り当てる)
const PAGE_BADGE_COLORS = [
  { bg: "#dcf5c4", fg: "#3f6b12" }, // 緑
  { bg: "#ffe1b8", fg: "#8a4b00" }, // オレンジ
  { bg: "#cfe3ff", fg: "#1d4ed8" }, // 青
  { bg: "#ecdcff", fg: "#6b21a8" }, // 紫
  { bg: "#ffd6e7", fg: "#9d174d" }, // ピンク
  { bg: "#c7f2e8", fg: "#0f766e" }, // 青緑
  { bg: "#ffd2d2", fg: "#b91c1c" }, // 赤
  { bg: "#eee0c9", fg: "#78350f" }, // 茶
];
function pageBadgeStyle(pageIndex) {
  const c = PAGE_BADGE_COLORS[pageIndex % PAGE_BADGE_COLORS.length];
  return `background:${c.bg}; color:${c.fg}; border-color:${c.bg};`;
}

// ピン番号(数値なら負の数も含めて正しく大小比較、非数値は自然順の文字列比較)
function compareLabels(a, b) {
  const na = Number(a), nb = Number(b);
  const aIsNum = a.trim() !== "" && !isNaN(na);
  const bIsNum = b.trim() !== "" && !isNaN(nb);
  if (aIsNum && bIsNum) return na - nb;
  return a.localeCompare(b, "ja", { numeric: true, sensitivity: "base" });
}
// ピン番号(手動指定があればそれ、無ければ一覧内(採番の基準=getActivePhotos順)での通し番号)
function labelOfPhoto(p) {
  return p.numberLabel != null ? p.numberLabel : String(getActivePhotos().indexOf(p) + 1);
}

// ---------- 日付比較(1回目/2回目の同一地点写真の突き合わせ) ----------
// 別の日とは限らない(同じ日でも間隔が空けば別回)ため、暦日ではなく
// 撮影時刻の間隔(state.dayCompareGapHours時間以上空いたら別回)でグループ分けする。
function pad2(n) { return String(n).padStart(2, "0"); }
function formatDateTimeShort(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function sessionLabel(group) {
  const first = group[0].capturedAt, last = group[group.length - 1].capturedAt;
  const a = formatDateTimeShort(first), b = formatDateTimeShort(last);
  return a === b ? a : `${a}〜${b}`;
}
// 撮影日時のあるGPS写真を、撮影時刻順に並べて間隔が空いたところで区切ったグループの配列にする
function computeSessionGroups(photos) {
  const sorted = [...photos].sort((a, b) => a.capturedAt - b.capturedAt);
  const gapMs = state.dayCompareGapHours * 3600 * 1000;
  const groups = [];
  let current = [];
  let lastTime = null;
  for (const p of sorted) {
    if (lastTime != null && (p.capturedAt - lastTime) > gapMs) {
      groups.push(current);
      current = [];
    }
    current.push(p);
    lastTime = p.capturedAt;
  }
  if (current.length) groups.push(current);
  return groups;
}
// baseX/baseYは全写真共通の1つの基準点からの平面座標(m換算)なので、
// 撮影ページが違っても単純なユークリッド距離で実距離(m)とみなせる。
function photoDistanceMeters(a, b) {
  return Math.hypot(a.baseX - b.baseX, a.baseY - b.baseY);
}
// 撮影時刻の間隔で区切った各回(何回でも可)を対象に、地点を累積で登録しながら突き合わせる。
// 1回目で登録した地点だけでなく、2回目以降で新たに登場した地点も、以降のどの回でも
// 同じピン番号として認識できるようにする(回数の上限は無く、必要な回数ぶん列が増える)。
// state.dayCompareRows: [{ originId, label, roundCandidates: [ [round0の写真id,...], [round1の...], … ] }]
function runDayComparison() {
  const gpsPhotos = getActivePhotos().filter((p) => p.hasGps && p.capturedAt);
  const groups = computeSessionGroups(gpsPhotos);
  if (!groups.length) {
    state.dayCompareRows = [];
    state.dayCompareRoundLabels = [];
    renderPhotoList();
    renderPins();
    renderComparePage();
    updateDayCompareStatus();
    return;
  }

  const threshold = state.dayCompareThreshold;
  const round0 = [...groups[0]].sort((a, b) => compareLabels(labelOfPhoto(a), labelOfPhoto(b)));
  const rows = round0.map((p) => {
    const row = { originId: p.id, label: labelOfPhoto(p), roundCandidates: groups.map(() => []) };
    row.roundCandidates[0] = [p.id];
    return row;
  });

  const usedNumeric = round0.map((p) => Number(labelOfPhoto(p))).filter((n) => !Number.isNaN(n));
  let nextNewLabel = (usedNumeric.length ? Math.max(...usedNumeric) : 0) + 1;

  for (let roundIdx = 1; roundIdx < groups.length; roundIdx++) {
    for (const photo of groups[roundIdx]) {
      const matchingRows = rows.filter((row) => {
        const origin = state.photos.find((p) => p.id === row.originId);
        return origin && photoDistanceMeters(origin, photo) <= threshold;
      });
      if (matchingRows.length) {
        matchingRows.forEach((row) => row.roundCandidates[roundIdx].push(photo.id));
      } else {
        const newRow = { originId: photo.id, label: String(nextNewLabel++), roundCandidates: groups.map(() => []) };
        newRow.roundCandidates[roundIdx] = [photo.id];
        rows.push(newRow);
      }
    }
  }

  state.dayCompareRows = rows;
  state.dayCompareRoundLabels = groups.map(sessionLabel);
  applyDayCompareLabels();
  renderPhotoList();
  renderPins();
  renderComparePage();
  updateDayCompareStatus();
}
// 候補一覧から不要なものを手動で外す。他のどの地点(行)・どの回にも属さなくなった場合は、
// その写真を新しい地点として登録し直す(新しいピン番号を振る)。
function removeDayCompareCandidate(originId, roundIdx, photoId) {
  const row = state.dayCompareRows.find((r) => r.originId === originId);
  if (!row) return;
  row.roundCandidates[roundIdx] = row.roundCandidates[roundIdx].filter((id) => id !== photoId);

  const stillMatched = state.dayCompareRows.some((r) => r.roundCandidates.some((ids) => ids.includes(photoId)));
  if (!stillMatched) {
    const maxLabel = Math.max(0, ...state.dayCompareRows.map((r) => Number(r.label)).filter((n) => !Number.isNaN(n)));
    const newRow = { originId: photoId, label: String(maxLabel + 1), roundCandidates: row.roundCandidates.map(() => []) };
    newRow.roundCandidates[roundIdx] = [photoId];
    state.dayCompareRows.push(newRow);
  }

  applyDayCompareLabels();
  renderPhotoList();
  renderPins();
  renderComparePage();
  updateDayCompareStatus();
}
// 現在のstate.dayCompareRows(候補を手動で間引いた結果)に基づき、2回目以降の写真のピン番号を
// 実際に書き換える。1回目(roundCandidates[0])の番号は一切変更しない。
function applyDayCompareLabels() {
  for (const row of state.dayCompareRows) {
    for (let roundIdx = 1; roundIdx < row.roundCandidates.length; roundIdx++) {
      for (const pid of row.roundCandidates[roundIdx]) {
        const photo = state.photos.find((p) => p.id === pid);
        if (photo) photo.numberLabel = row.label;
      }
    }
  }
}
function updateDayCompareStatus() {
  const box = el("dayCompareStatus");
  if (!box) return;
  const roundLabels = state.dayCompareRoundLabels || [];
  if (!roundLabels.length) {
    box.textContent = "撮影日時(Exif)付きのGPS写真がありません。";
    return;
  }
  const counts = roundLabels.map((label, i) =>
    `${i + 1}回目(${label})：${state.dayCompareRows.reduce((s, r) => s + r.roundCandidates[i].length, 0)}枚`);
  box.textContent = `地点数：${state.dayCompareRows.length}件\n${counts.join(" / ")}`;
}

// 日付比較の行データ(地点ごとの各回の写真一覧)を、PDF/Excel出力・プレビューの
// 3箇所で共通して使う形にまとめる
function buildCompareLayoutRows() {
  const roundLabels = state.dayCompareRoundLabels || [];
  const rows = [...state.dayCompareRows]
    .sort((a, b) => compareLabels(a.label, b.label))
    .map((row) => ({
      originId: row.originId,
      label: row.label,
      byRound: row.roundCandidates.map((ids) => ids.map((id) => state.photos.find((p) => p.id === id)).filter(Boolean)),
    }));
  return { roundLabels, rows };
}
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
// 写真を縁取り・番号バッジ・ファイル名を一切付けず、元の縦横比を保ったまま
// 指定した幅(px)にリサイズするだけの画像にする(引き伸ばし・切り抜きはしない)。
// Excel出力の日付比較シートで、写真をそのまま貼り付けるために使う。
async function resizePhotoImage(photo, targetWidth) {
  const img = await loadImage(photo.thumbDataUrl);
  const ar = photo.aspectRatio || (img.width / img.height);
  const targetHeight = Math.max(1, Math.round(targetWidth / ar));
  const c = document.createElement("canvas");
  c.width = targetWidth;
  c.height = targetHeight;
  c.getContext("2d").drawImage(img, 0, 0, targetWidth, targetHeight);
  return { dataUrl: c.toDataURL("image/png"), width: targetWidth, height: targetHeight };
}
// 写真の原本(photo.file)を一切圧縮・再エンコードせず、そのままのバイト列でExcelに
// 埋め込む。表示サイズだけ指定した幅(cm)に収め、縦横比は元写真のまま。
// photo.fileが原本でない場合(プロジェクト読込み後などサムネイルしか無い場合)は
// resizePhotoImageでの縮小版に自動でフォールバックする。
async function addOriginalPhotoImage(wb, sheet, photo, displayWidthCm, nativeCol, colOffPx, nativeRow, rowOffPx) {
  const EMU_PER_PX = 9525;
  const widthPx = (displayWidthCm * 360000) / EMU_PER_PX;
  const ar = photo.aspectRatio || 1;
  const heightPx = widthPx / ar;

  let imgId = null;
  if (photo.file) {
    try {
      const mime = photo.file.type || (/\.png$/i.test(photo.name) ? "image/png" : "image/jpeg");
      const ext = /png/i.test(mime) ? "png" : "jpeg";
      const b64 = arrayBufferToBase64(await photo.file.arrayBuffer());
      imgId = wb.addImage({ base64: `data:${mime};base64,${b64}`, extension: ext });
    } catch (e) { imgId = null; }
  }
  if (imgId == null) {
    const resized = await resizePhotoImage(photo, Math.round(widthPx));
    imgId = wb.addImage({ base64: resized.dataUrl, extension: "png" });
  }

  sheet.addImage(imgId, {
    tl: {
      nativeCol, nativeColOff: Math.round(colOffPx * EMU_PER_PX),
      nativeRow, nativeRowOff: Math.round(rowOffPx * EMU_PER_PX),
    },
    ext: { width: widthPx, height: heightPx },
  });
  return { widthPx, heightPx };
}
// 1枚の写真を「サムネイル＋丸番号バッジ＋ファイル名」の1枚のカード画像(PNG)にまとめる。
// PDF出力の日付比較ページで、このカード単位の画像をそのまま配置する。
async function buildCompareCardImage(photo, label, w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fafbfc";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "#d7dce3";
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);

  const pad = 6, nameH = 16;
  const areaW = w - pad * 2, areaH = h - nameH - pad * 2;
  try {
    const img = await loadImage(photo.thumbDataUrl);
    const scale = Math.max(areaW / img.width, areaH / img.height);
    const dw = img.width * scale, dh = img.height * scale;
    const dx = pad + (areaW - dw) / 2, dy = pad + (areaH - dh) / 2;
    ctx.save();
    ctx.beginPath();
    ctx.rect(pad, pad, areaW, areaH);
    ctx.clip();
    ctx.drawImage(img, dx, dy, dw, dh);
    ctx.restore();
  } catch (e) { /* サムネイルが読めなくても枠だけは出す */ }

  const color = photo.pinColor || DEFAULT_PIN_COLOR;
  const r = 12;
  ctx.beginPath();
  ctx.arc(pad + r, pad + r, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "#fff";
  ctx.stroke();
  ctx.fillStyle = contrastTextColor(color);
  ctx.font = "bold 13px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(label), pad + r, pad + r + 1);

  ctx.fillStyle = "#333";
  ctx.font = "11px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  let name = photo.name;
  while (name.length > 4 && ctx.measureText(name).width > w - 8) name = name.slice(0, -1);
  if (name !== photo.name) name = name.replace(/\.[^.]*$/, "").slice(0, Math.max(1, name.length - 1)) + "…";
  ctx.fillText(name, w / 2, h - 6);

  return c.toDataURL("image/png");
}

// ---------- 写真一覧UI ----------
function renderPhotoList() {
  const box = el("photoList");
  box.innerHTML = "";
  // ピン番号(採番)はこの元の並び順(=キャンバス/出力と共通)を基準にする。
  const activePhotos = getActivePhotos();
  const labelOf = labelOfPhoto;
  // 表示順だけはページ番号→ピン番号の順に並べ替える(採番そのものは変えない)。
  const sortedForDisplay = [...activePhotos].sort((a, b) => {
    if (a.pageIndex !== b.pageIndex) return a.pageIndex - b.pageIndex;
    return compareLabels(labelOf(a), labelOf(b));
  });

  sortedForDisplay.forEach((p) => {
    const row = document.createElement("div");
    const isMultiSelected = state.selectedPhotoIds.includes(p.id);
    row.className = "photoRow"
      + (p.hasGps ? "" : " noGps")
      + (state.calibSelectedIds.includes(p.id) ? " calibSelected" : "")
      + (isMultiSelected ? " multiSelected" : "");
    const label = labelOf(p);
    const pinColor = p.pinColor || DEFAULT_PIN_COLOR;
    const numberCell = state.calibrating
      ? `<input type="checkbox" data-calib="${p.id}" ${state.calibSelectedIds.includes(p.id) ? "checked" : ""}>`
      : (p.hasGps ? `<input type="text" class="numInput" data-num="${p.id}" value="${label}" style="background:${pinColor}; color:${contrastTextColor(pinColor)};" title="ピン番号（クリックして手動変更）">` : `<span class="num" style="background:var(--muted)">-</span>`);
    row.innerHTML = `
      ${numberCell}
      <img src="${p.thumbDataUrl}" alt="">
      <div class="info">
        <div class="name" title="${p.name}">${p.name}</div>
        <div class="gps">${p.hasGps ? `${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}` : "GPS情報なし"}</div>
      </div>
      <span class="pageBadge" style="${pageBadgeStyle(p.pageIndex)}" title="右クリックで移動先ページを選択、またはゴミ箱へ移動">P${displayPageNumber(p.pageIndex) || "?"}</span>
      <button type="button" data-del="${p.id}" title="ゴミ箱へ移動">×</button>
    `;
    if (!state.calibrating) {
      row.addEventListener("click", (e) => {
        if (e.target.closest("button, input")) return;
        onPhotoRowClick(e, p, sortedForDisplay);
      });
    }
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (!state.selectedPhotoIds.includes(p.id)) {
        state.selectedPhotoIds = [p.id];
        state.lastClickedPhotoId = p.id;
        renderPhotoList();
      }
      const targets = state.photos.filter((ph) => state.selectedPhotoIds.includes(ph.id));
      showPageContextMenu(e.clientX, e.clientY, targets);
    });
    box.appendChild(row);
  });

  box.querySelectorAll("input.numInput").forEach((inp) => {
    inp.addEventListener("click", (e) => e.stopPropagation());
    inp.addEventListener("change", (e) => {
      const id = Number(e.target.getAttribute("data-num"));
      const photo = state.photos.find((p) => p.id === id);
      const val = e.target.value.trim();
      photo.numberLabel = val === "" ? null : val;
      renderPins();
      renderPhotoList(); // 番号順に並べ替え直す
    });
  });
  box.querySelectorAll("button[data-del]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const id = Number(e.target.getAttribute("data-del"));
      trashPhoto(state.photos.find((p) => p.id === id));
    });
  });
  box.querySelectorAll("input[data-calib]").forEach((cb) => {
    cb.addEventListener("change", (e) => {
      const id = Number(e.target.getAttribute("data-calib"));
      if (e.target.checked) {
        if (state.calibSelectedIds.length >= 2) state.calibSelectedIds.shift();
        state.calibSelectedIds.push(id);
      } else {
        state.calibSelectedIds = state.calibSelectedIds.filter((x) => x !== id);
      }
      renderPhotoList();
      tryRunCalibration();
    });
  });

  renderTrashList();
}

// 一覧の行クリックによる複数選択（通常クリック=単独選択、Ctrl/Cmd=追加/解除、Shift=範囲選択）
function onPhotoRowClick(e, photo, activePhotos) {
  if (e.shiftKey && state.lastClickedPhotoId != null) {
    const fromIdx = activePhotos.findIndex((p) => p.id === state.lastClickedPhotoId);
    const toIdx = activePhotos.findIndex((p) => p.id === photo.id);
    if (fromIdx !== -1 && toIdx !== -1) {
      const [lo, hi] = fromIdx < toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx];
      state.selectedPhotoIds = activePhotos.slice(lo, hi + 1).map((p) => p.id);
    }
  } else if (e.ctrlKey || e.metaKey) {
    if (state.selectedPhotoIds.includes(photo.id)) {
      state.selectedPhotoIds = state.selectedPhotoIds.filter((id) => id !== photo.id);
    } else {
      state.selectedPhotoIds = [...state.selectedPhotoIds, photo.id];
    }
    state.lastClickedPhotoId = photo.id;
  } else {
    state.selectedPhotoIds = [photo.id];
    state.lastClickedPhotoId = photo.id;
  }
  renderPhotoList();
}

// ---------- ゴミ箱 ----------
function trashPhoto(photo) {
  if (!photo) return;
  photo.trashed = true;
  renderPhotoList();
  buildPageList();
  renderPins();
}
function restorePhoto(photo) {
  photo.trashed = false;
  renderPhotoList();
  buildPageList();
  renderPins();
}
function purgePhoto(photo) {
  if (!confirm(`「${photo.name}」を完全に削除します。元に戻せません。よろしいですか？`)) return;
  state.photos = state.photos.filter((p) => p.id !== photo.id);
  renderPhotoList();
  buildPageList();
  renderPins();
}
function renderTrashList() {
  const trashed = state.photos.filter((p) => p.trashed);
  el("trashBlock").hidden = trashed.length === 0;
  el("trashCount").textContent = trashed.length ? `(${trashed.length})` : "";
  const box = el("trashList");
  box.innerHTML = "";
  trashed.forEach((p) => {
    const row = document.createElement("div");
    row.className = "photoRow trashedRow";
    row.innerHTML = `
      <img src="${p.thumbDataUrl}" alt="">
      <div class="info">
        <div class="name" title="${p.name}">${p.name}</div>
        <div class="gps">${p.hasGps ? `${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}` : "GPS情報なし"}</div>
      </div>
      <div class="trashActions">
        <button type="button" data-restore="${p.id}">元に戻す</button>
        <button type="button" class="purge" data-purge="${p.id}">完全に削除</button>
      </div>
    `;
    box.appendChild(row);
  });
  box.querySelectorAll("button[data-restore]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const id = Number(e.target.getAttribute("data-restore"));
      restorePhoto(state.photos.find((p) => p.id === id));
    });
  });
  box.querySelectorAll("button[data-purge]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const id = Number(e.target.getAttribute("data-purge"));
      purgePhoto(state.photos.find((p) => p.id === id));
    });
  });
}

function syncLayerControlsToCurrentPage() {
  const t = getPageTransform(state.currentPage);
  el("layerScale").value = scaleToSlider(t.scale);
  el("layerScaleVal").value = t.scale.toFixed(2);
  const scaleY = t.scaleY || 1, scaleX = t.scaleX || 1;
  el("layerScaleY").value = scaleY;
  el("layerScaleYVal").value = scaleY.toFixed(2);
  el("layerScaleX").value = scaleX;
  el("layerScaleXVal").value = scaleX.toFixed(2);
  el("layerRotate").value = t.rotationDeg;
  el("layerRotateVal").value = t.rotationDeg;
}

// ---------- レイヤー変形（拡大縮小=左下基点／回転=中心基点） ----------
function getActivePhotos() {
  return state.photos.filter((p) => !p.trashed);
}
function getPagePhotos(pageIndex) {
  return state.photos.filter((p) => p.pageIndex === pageIndex && p.hasGps && !p.trashed);
}
function getBaseBBox(photos) {
  const xs = photos.map((p) => p.baseX), ys = photos.map((p) => p.baseY);
  return {
    minX: Math.min(...xs), maxX: Math.max(...xs),
    minY: Math.min(...ys), maxY: Math.max(...ys),
  };
}
// 手動位置調整分(manualOffset)も含めたbbox。写真レイヤーの範囲表示(drawLayerBoundsOverlay)専用。
// レイヤー変形自体の基点/中心(anchor/center)はtransformPoint内でgetBaseBBox(生のGPS位置)を
// 使い続けるため、ここで手動調整分を混ぜても他のピンの位置計算には影響しない。
function getEffectiveBaseBBox(photos) {
  const xs = photos.map((p) => p.baseX + (p.manualOffset ? p.manualOffset.x : 0));
  const ys = photos.map((p) => p.baseY + (p.manualOffset ? p.manualOffset.y : 0));
  return {
    minX: Math.min(...xs), maxX: Math.max(...xs),
    minY: Math.min(...ys), maxY: Math.max(...ys),
  };
}
// p (baseX,baseY + 手動調整分) をキャンバス座標へ変換。
// 手動で位置を微調整した写真も、baseX/baseYと同じ基準(base)座標系の
// オフセットとして加算するだけなので、レイヤーの拡大縮小・回転・移動の
// 対象に他の写真と同じように含まれる。
function transformPoint(p, photosOnPage, t) {
  const baseX = p.baseX + (p.manualOffset ? p.manualOffset.x : 0);
  const baseY = p.baseY + (p.manualOffset ? p.manualOffset.y : 0);
  // 写真が1枚だけの場合、bboxは1点に潰れるため anchor=center=その点になり、
  // 以下の一般式がそのまま「offsetだけ動く」という妥当な結果を返す。
  const bb = getBaseBBox(photosOnPage);
  const anchor = { x: bb.minX, y: bb.maxY }; // 左下
  const center0 = { x: (bb.minX + bb.maxX) / 2, y: (bb.minY + bb.maxY) / 2 };
  // 縦横比補正(scaleX/scaleY)は基本のscaleにさらに掛け合わせる。
  // baseX=anchor.x, baseY=anchor.y のとき常に anchor 自身に戻るため、
  // 縦横で倍率が違っても基点(左下)は変わらない。
  const sx = t.scale * (t.scaleX || 1);
  const sy = t.scale * (t.scaleY || 1);
  const p1 = { x: anchor.x + (baseX - anchor.x) * sx, y: anchor.y + (baseY - anchor.y) * sy };
  const center1 = { x: anchor.x + (center0.x - anchor.x) * sx, y: anchor.y + (center0.y - anchor.y) * sy };
  const rad = t.rotationDeg * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const dx = p1.x - center1.x, dy = p1.y - center1.y;
  const p2 = { x: center1.x + dx * cos - dy * sin, y: center1.y + dx * sin + dy * cos };
  return { x: p2.x + t.offsetX, y: p2.y + t.offsetY };
}

function normalizeAngle(deg) { return ((deg % 360) + 360) % 360; }

// 「2.PDF図面」の回転角(pdf.js自体は回転させず、canvasStackにCSSでrotateをかけているだけ)による
// 見た目上の回転に合わせて、位置pだけをキャンバス中心まわりに回転させる。
// pinCanvas自体は逆回転で相殺してまっすぐ(回転なし)に保っているため、ここで位置だけ
// 回転させて描画すれば「位置は図面と一緒に動くが、写真・ピン自体の向きはまっすぐ」になる。
function rotateForView(p, canvas, viewRotationDeg) {
  if (!viewRotationDeg) return p;
  const cx = canvas.width / 2, cy = canvas.height / 2;
  const rad = viewRotationDeg * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const dx = p.x - cx, dy = p.y - cy;
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

const ARROW_HEAD_LEN = 8;
const ARROW_HEAD_ANGLE = 26; // deg

// 矢印が太いほど先端の矢じりも大きくする(細いままだとただの棒に見えるため)。
// ただし矢印本体より長くなりすぎないよう、全長の70%を上限とする。
function arrowHeadLength(width, shaftLength) {
  const base = Math.max(ARROW_HEAD_LEN, width * 4);
  return Math.min(base, shaftLength * 0.7);
}

// 一括設定(state.xxx)を基本とし、写真ごとの個別上書き(xxxOverride)があればそちらを優先する
function effPinSize(p) { return p.pinSizeOverride != null ? p.pinSizeOverride : state.pinSize; }
function effLeaderWidth(p) { return p.leaderWidthOverride != null ? p.leaderWidthOverride : state.leaderLineWidth; }
function effLeaderLength(p) { return p.leaderLengthOverride != null ? p.leaderLengthOverride : state.leaderLineLength; }
function effLeaderColor(p) { return p.leaderColorOverride != null ? p.leaderColorOverride : state.leaderLineColor; }
function effArrowWidth(p) { return p.arrowWidthOverride != null ? p.arrowWidthOverride : state.arrowWidth; }
function effArrowLength(p) { return p.arrowLengthOverride != null ? p.arrowLengthOverride : state.arrowLength; }
function effArrowColor(p) { return p.arrowColorOverride != null ? p.arrowColorOverride : state.arrowColor; }
function effThumbBorderWidth(p) { return p.thumbBorderWidthOverride != null ? p.thumbBorderWidthOverride : state.thumbBorderWidth; }
function effThumbBorderColor(p) { return p.thumbBorderColorOverride != null ? p.thumbBorderColorOverride : state.thumbBorderColor; }

// サムネイル枠のサイズ(px)。state.thumbSize(スライダー)を長辺の目安とし、
// 元写真の縦横比(photo.aspectRatio)を保ったまま短辺を縮める(引き伸ばし・切り抜きをしない)。
function thumbBoxSize(photo, sizePx) {
  const base = sizePx != null ? sizePx : state.thumbSize;
  const ar = photo.aspectRatio || 1;
  return ar >= 1 ? { w: base, h: base / ar } : { w: base * ar, h: base };
}
// サムネイルの中心位置。ピンから右上へ(pinサイズ+サムネ半分+引き出し線長さ)ぶん離れた位置が既定で、
// そこにさらに写真ごとの手動調整分(thumbOffset、画面ピクセル単位)を加える。
// 重なりやすい「同一地点で撮った複数枚」を、ピンとは別に写真だけ動かして避けられるようにするためのもの。
function thumbCenter(pos, r, thumbW, thumbH, leaderLen, thumbOffset) {
  const ox = thumbOffset ? thumbOffset.x : 0, oy = thumbOffset ? thumbOffset.y : 0;
  return { x: pos.x + r + thumbW / 2 + leaderLen + ox, y: pos.y - r - thumbH / 2 - leaderLen + oy };
}

// cx,cy: ピン中心。angleDeg: 上(画面のY-)を0とし時計回りの角度。
// headLen: 矢じり(先端の三角)の長さ。省略時は既定値(ARROW_HEAD_LEN)を使う。
function arrowGeometry(cx, cy, angleDeg, length, headLen) {
  if (headLen == null) headLen = ARROW_HEAD_LEN;
  const rad = angleDeg * Math.PI / 180;
  const dx = Math.sin(rad), dy = -Math.cos(rad);
  const tip = { x: cx + dx * length, y: cy + dy * length };
  const mkWing = (sign) => {
    const a = ARROW_HEAD_ANGLE * Math.PI / 180 * sign;
    const rdx = dx * Math.cos(a) - dy * Math.sin(a);
    const rdy = dx * Math.sin(a) + dy * Math.cos(a);
    return { x: tip.x - rdx * headLen, y: tip.y - rdy * headLen };
  };
  return { base: { x: cx, y: cy }, tip, wing1: mkWing(1), wing2: mkWing(-1) };
}
// マウス座標から見た「pos基準で上を0とした時計回り角度」
function angleFromVector(cx, cy, px, py) {
  return normalizeAngle(Math.atan2(px - cx, cy - py) * 180 / Math.PI);
}

// ---------- ピン描画 ----------
function renderPins() {
  const canvas = el("pinCanvas");
  if (!canvas.width) return;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const photosOnPage = getPagePhotos(state.currentPage);
  if (!photosOnPage.length) { drawCalibOverlay(ctx); return; }
  const t = getPageTransform(state.currentPage);
  if (!t.centered) {
    const bb = getBaseBBox(photosOnPage);
    const center0 = { x: (bb.minX + bb.maxX) / 2, y: (bb.minY + bb.maxY) / 2 };
    t.offsetX = canvas.width / 2 - center0.x;
    t.offsetY = canvas.height / 2 - center0.y;
    t.centered = true;
  }

  const viewRotation = getPageView(state.currentPage).rotation || 0;
  drawLayerBoundsOverlay(ctx, photosOnPage, t, canvas, viewRotation);

  const activePhotos = getActivePhotos();
  const pins = state.photos
    .filter((p) => p.pageIndex === state.currentPage && p.hasGps && !p.trashed)
    .map((p) => ({
      photo: p,
      index: activePhotos.indexOf(p),
      pos: transformPoint(p, photosOnPage, t),
      dir: normalizeAngle(p.directionDeg + t.rotationDeg),
    }));

  // ヒットテスト/ドラッグ/PDF・Excel出力等はすべてこのpos(P空間=回転角の影響を受けない
  // 図面本来の座標系)を基準にするため、_screenPos/_screenDirは回転前の値のまま保持する。
  pins.forEach((pin) => { pin.photo._screenPos = pin.pos; pin.photo._screenDir = pin.dir; });

  // 実際の描画位置だけは、pinCanvasの逆回転(applyCanvasTransform)と打ち消し合うよう
  // 回転角ぶん回転させる。これにより位置は図面と一緒に動くが、pinCanvas自体は
  // まっすぐなままなので、写真・ピン・矢印の向きはまっすぐ表示される。
  for (const pin of pins) {
    drawPin(ctx, { ...pin, pos: rotateForView(pin.pos, canvas, viewRotation) });
  }
  drawCalibOverlay(ctx);
}

// 写真レイヤーの範囲を示すガイド枠。四辺すべて赤い実線で表示する。
// プレビュー確認用のみで、PDF/Excel出力(exportCompositePdf/exportExcel)には一切描画しない。
function drawLayerBoundsOverlay(ctx, photosOnPage, t, canvas, viewRotation) {
  if (photosOnPage.length < 2) return;
  // 手動で位置調整した写真があっても枠がそれを反映するよう、
  // manualOffsetを含めた実効bboxを使う(レイヤー変形自体の基点はtransformPoint内で不変)。
  // 描画位置はPDF図面の回転角(viewRotation)ぶんだけ回転させ、図面と一緒に動くようにする
  // (pinCanvas自体は逆回転で相殺されまっすぐなままなので、枠と文字の向きはまっすぐ保たれる)。
  const bb = getEffectiveBaseBBox(photosOnPage);
  const corner = (bx, by) => rotateForView(
    transformPoint({ baseX: bx, baseY: by, manualOffset: null }, photosOnPage, t), canvas, viewRotation);
  const bl = corner(bb.minX, bb.maxY);
  const tl = corner(bb.minX, bb.minY);
  const tr = corner(bb.maxX, bb.minY);
  const br = corner(bb.maxX, bb.maxY);

  ctx.save();
  ctx.strokeStyle = "#dc2626";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(tl.x, tl.y);
  ctx.lineTo(tr.x, tr.y);
  ctx.lineTo(br.x, br.y);
  ctx.lineTo(bl.x, bl.y);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();

  // ラベル。回転(t.rotationDeg)してもキャンバス自体は回転させていないので、
  // 中心位置だけ回転後の座標に合わせれば文字自体は常に水平のまま表示される。
  const centerScreen = corner((bb.minX + bb.maxX) / 2, (bb.minY + bb.maxY) / 2);
  ctx.save();
  ctx.fillStyle = "rgba(30,30,30,0.75)";
  ctx.font = "12px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("写真レイヤー", centerScreen.x, centerScreen.y);
  ctx.restore();
}

function drawPin(ctx, pin) {
  const { pos, photo, index, dir } = pin;
  const r = effPinSize(photo);
  const { w: thumbW, h: thumbH } = thumbBoxSize(photo);
  const leaderLen = effLeaderLength(photo);
  const { x: thumbCx, y: thumbCy } = thumbCenter(pos, r, thumbW, thumbH, leaderLen, photo.thumbOffset);

  // 撮影方向の矢印
  const arrowCol = effArrowColor(photo);
  const arrowLen = effArrowLength(photo);
  const arrow = arrowGeometry(pos.x, pos.y, dir, arrowLen, arrowHeadLength(effArrowWidth(photo), arrowLen));
  ctx.save();
  ctx.strokeStyle = arrowCol;
  ctx.fillStyle = arrowCol;
  ctx.lineWidth = effArrowWidth(photo);
  ctx.beginPath();
  ctx.moveTo(arrow.base.x, arrow.base.y);
  ctx.lineTo(arrow.tip.x, arrow.tip.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(arrow.tip.x, arrow.tip.y);
  ctx.lineTo(arrow.wing1.x, arrow.wing1.y);
  ctx.lineTo(arrow.wing2.x, arrow.wing2.y);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // 引き出し線
  ctx.save();
  ctx.strokeStyle = effLeaderColor(photo);
  ctx.lineWidth = effLeaderWidth(photo);
  ctx.beginPath();
  ctx.moveTo(pos.x, pos.y);
  ctx.lineTo(thumbCx - thumbW / 2 * 0.3, thumbCy + thumbH / 2 * 0.3);
  ctx.stroke();
  ctx.restore();

  // サムネイル（フチ付き。元写真の縦横比のまま表示する）
  const img = pin.photo._imgEl || getCachedImage(photo);
  const borderW = effThumbBorderWidth(photo);
  const inset = borderW / 2;
  ctx.save();
  ctx.fillStyle = "#fff";
  ctx.strokeStyle = effThumbBorderColor(photo);
  ctx.lineWidth = borderW;
  ctx.fillRect(thumbCx - thumbW / 2, thumbCy - thumbH / 2, thumbW, thumbH);
  if (img && img.complete) {
    ctx.drawImage(img, thumbCx - thumbW / 2 + inset, thumbCy - thumbH / 2 + inset, thumbW - inset * 2, thumbH - inset * 2);
  }
  ctx.strokeRect(thumbCx - thumbW / 2, thumbCy - thumbH / 2, thumbW, thumbH);
  ctx.restore();

  // ピン（円+番号）
  const pinColor = photo.pinColor || DEFAULT_PIN_COLOR;
  ctx.save();
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
  ctx.fillStyle = pinColor;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "#fff";
  ctx.stroke();
  ctx.fillStyle = contrastTextColor(pinColor);
  const label = photo.numberLabel != null ? photo.numberLabel : String(index + 1);
  ctx.font = `bold ${Math.max(9, r)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, pos.x, pos.y + 0.5);
  ctx.restore();
}

const imageCache = new Map();
function getCachedImage(photo) {
  if (imageCache.has(photo.id)) return imageCache.get(photo.id);
  const img = new Image();
  img.onload = () => renderPins();
  img.src = photo.thumbDataUrl;
  imageCache.set(photo.id, img);
  return img;
}

function drawCalibOverlay(ctx) {
  if (!state.calibrating) return;
  ctx.save();
  ctx.fillStyle = "#16a34a";
  ctx.strokeStyle = "#fff";
  state.calibPoints.forEach((pt, i) => {
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 6, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#065f46";
    ctx.font = "bold 12px sans-serif";
    ctx.fillText("目標" + (i + 1), pt.x + 8, pt.y - 8);
    ctx.fillStyle = "#16a34a";
  });
  ctx.restore();
}

function updateCalibUi() {
  const hint = el("calibHint");
  el("calibrateBtn").classList.toggle("active", state.calibrating);
  if (!state.calibrating) { hint.hidden = true; hint.classList.remove("active"); renderPins(); return; }
  hint.hidden = false;
  hint.classList.add("active");
  hint.textContent = "位置合わせモード: 図面上の実在位置を2箇所クリックし、右の写真一覧から対応する写真を2枚チェックしてください。";
}

// ---------- マウス操作（ピン移動・レイヤー移動・キャリブレーション） ----------
// canvasStack はCSSの transform:rotate() で回転表示されることがあるため、
// クリック位置は「回転中心からの逆回転」でcanvas内部のピクセル座標に変換する。
function canvasPosFromEvent(e) {
  const canvas = el("pinCanvas");
  const stack = el("canvasStack");
  const rect = stack.getBoundingClientRect(); // 回転後の外接矩形（中心は回転前と同じ）
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const v = getPageView(state.currentPage);
  const rad = -(v.rotation || 0) * Math.PI / 180;
  const dx = e.clientX - cx, dy = e.clientY - cy;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  return {
    x: canvas.width / 2 + (dx * cos - dy * sin),
    y: canvas.height / 2 + (dx * sin + dy * cos),
  };
}

function onCanvasClick(e) {
  if (!state.calibrating) return;
  if (state.calibPoints.length >= 2) state.calibPoints = [];
  state.calibPoints.push(canvasPosFromEvent(e));
  renderPins();
  tryRunCalibration();
}

function onCanvasMouseDown(e) {
  if (state.calibrating) return;
  const pos = canvasPosFromEvent(e);
  const arrowHit = hitTestArrowTip(pos);
  if (arrowHit) {
    state.draggingArrow = arrowHit.id;
    return;
  }
  const hit = hitTestPin(pos);
  if (hit) {
    state.draggingPin = hit.id;
    state.dragLast = pos;
    return;
  }
  // 同じ地点で撮った写真同士でサムネイルが重なる場合に、ピンとは別に
  // 写真だけをつまんでずらせるようにする(ピン自体の位置には影響しない)。
  const thumbHit = hitTestThumbnail(pos);
  if (thumbHit) {
    state.draggingThumb = thumbHit.id;
    state.dragLast = pos;
    return;
  }
  // 「✋ レイヤー移動」モード中はキャンバスのどこでもドラッグでレイヤー移動できるが、
  // それ以外でも写真レイヤーの枠(基準線)を直接つまんでドラッグすれば移動できるようにする。
  if (state.layerPanMode || hitTestLayerBounds(pos)) {
    state.draggingLayer = true;
    state.dragLast = pos;
  }
}
// 現在のページの写真レイヤーの範囲(drawLayerBoundsOverlayと同じ四角形)内に
// 画面座標posが含まれるかどうかを判定する。回転していても正しく判定できるよう、
// 変換後の4隅を結ぶ凸四角形に対する内外判定を行う。
function hitTestLayerBounds(pos) {
  const photosOnPage = getPagePhotos(state.currentPage);
  if (photosOnPage.length < 2) return false;
  const t = getPageTransform(state.currentPage);
  const bb = getEffectiveBaseBBox(photosOnPage);
  const corner = (bx, by) => transformPoint({ baseX: bx, baseY: by, manualOffset: null }, photosOnPage, t);
  const quad = [corner(bb.minX, bb.minY), corner(bb.maxX, bb.minY), corner(bb.maxX, bb.maxY), corner(bb.minX, bb.maxY)];
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i], b = quad[(i + 1) % 4];
    const cross = (b.x - a.x) * (pos.y - a.y) - (b.y - a.y) * (pos.x - a.x);
    if (cross === 0) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}
function hitTestPin(pos) {
  const photosOnPage = getPagePhotos(state.currentPage);
  for (let i = photosOnPage.length - 1; i >= 0; i--) {
    const p = photosOnPage[i];
    const sp = p._screenPos;
    if (!sp) continue;
    const d = Math.hypot(pos.x - sp.x, pos.y - sp.y);
    if (d <= effPinSize(p) + 3) return p;
  }
  return null;
}
// サムネイル画像の四角部分内をクリックしたか判定(右クリックメニューをピン本体だけでなく
// サムネイル画像からも開けるようにするため)
function hitTestThumbnail(pos) {
  const photosOnPage = getPagePhotos(state.currentPage);
  for (let i = photosOnPage.length - 1; i >= 0; i--) {
    const p = photosOnPage[i];
    const sp = p._screenPos;
    if (!sp) continue;
    const r = effPinSize(p);
    const { w: thumbW, h: thumbH } = thumbBoxSize(p);
    const leaderLen = effLeaderLength(p);
    const { x: thumbCx, y: thumbCy } = thumbCenter(sp, r, thumbW, thumbH, leaderLen, p.thumbOffset);
    if (pos.x >= thumbCx - thumbW / 2 && pos.x <= thumbCx + thumbW / 2
      && pos.y >= thumbCy - thumbH / 2 && pos.y <= thumbCy + thumbH / 2) {
      return p;
    }
  }
  return null;
}
function hitTestArrowTip(pos) {
  const photosOnPage = getPagePhotos(state.currentPage);
  for (let i = photosOnPage.length - 1; i >= 0; i--) {
    const p = photosOnPage[i];
    const sp = p._screenPos;
    if (!sp || p._screenDir == null) continue;
    const tip = arrowGeometry(sp.x, sp.y, p._screenDir, effArrowLength(p)).tip;
    const d = Math.hypot(pos.x - tip.x, pos.y - tip.y);
    if (d <= 9) return p;
  }
  return null;
}
function onCanvasMouseMove(e) {
  if (!state.draggingPin && !state.draggingLayer && !state.draggingArrow && !state.draggingThumb) return;
  const pos = canvasPosFromEvent(e);
  if (state.draggingArrow) {
    const photo = state.photos.find((p) => p.id === state.draggingArrow);
    const sp = photo._screenPos;
    const t = getPageTransform(photo.pageIndex);
    const screenAngle = angleFromVector(sp.x, sp.y, pos.x, pos.y);
    photo.directionDeg = normalizeAngle(screenAngle - t.rotationDeg);
    renderPins();
    return;
  }
  const dx = pos.x - state.dragLast.x, dy = pos.y - state.dragLast.y;
  state.dragLast = pos;
  if (state.draggingPin) {
    const photo = state.photos.find((p) => p.id === state.draggingPin);
    const t = getPageTransform(photo.pageIndex);
    // 画面(ピクセル)上のドラッグ量を、レイヤー変換前の基準(base)座標系での
    // 移動量に変換して積み上げる。こうすることで、後からレイヤーの拡大縮小・
    // 回転・移動を行っても、この写真だけ取り残されずに一緒に動く。
    const rad = t.rotationDeg * Math.PI / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const s = t.scale || 1;
    const baseDx = (dx * cos + dy * sin) / s;
    const baseDy = (-dx * sin + dy * cos) / s;
    const prev = photo.manualOffset || { x: 0, y: 0 };
    photo.manualOffset = { x: prev.x + baseDx, y: prev.y + baseDy };
    renderPins();
  } else if (state.draggingThumb) {
    const photo = state.photos.find((p) => p.id === state.draggingThumb);
    // サムネイルは画面ピクセル単位の固定オフセットで配置しているため(ピンサイズ・
    // サムネサイズと同様にPDFの拡大率に対して不変)、ドラッグ量もそのまま加算する。
    const prev = photo.thumbOffset || { x: 0, y: 0 };
    photo.thumbOffset = { x: prev.x + dx, y: prev.y + dy };
    renderPins();
  } else if (state.draggingLayer) {
    const t = getPageTransform(state.currentPage);
    t.offsetX += dx; t.offsetY += dy;
    renderPins();
  }
}
function onCanvasMouseUp() {
  state.draggingPin = null;
  state.draggingArrow = null;
  state.draggingThumb = null;
  state.draggingLayer = false;
  state.dragLast = null;
}

function onCanvasDblClick(e) {
  if (state.calibrating) return;
  const pos = canvasPosFromEvent(e);
  const hit = hitTestPin(pos);
  if (!hit) return;
  promptEditPinNumber(hit);
}

function promptEditPinNumber(photo) {
  const current = photo.numberLabel != null ? photo.numberLabel : String(getActivePhotos().indexOf(photo) + 1);
  const val = prompt("ピン番号を入力してください", current);
  if (val === null) return;
  const trimmed = val.trim();
  photo.numberLabel = trimmed === "" ? null : trimmed;
  renderPins();
  renderPhotoList();
}

function promptEditPinColor(photos) {
  const targets = photos.filter((p) => p.hasGps);
  if (!targets.length) return;
  const input = document.createElement("input");
  input.type = "color";
  input.value = targets[0].pinColor || DEFAULT_PIN_COLOR;
  input.style.position = "fixed";
  input.style.left = "-9999px";
  document.body.appendChild(input);
  let removed = false;
  const cleanup = () => {
    if (removed) return;
    removed = true;
    if (input.parentNode) document.body.removeChild(input);
  };
  input.addEventListener("input", () => {
    targets.forEach((p) => { p.pinColor = input.value; });
    renderPins();
    renderPhotoList();
  });
  input.addEventListener("change", cleanup);
  input.addEventListener("blur", cleanup);
  input.click();
}

function onCanvasContextMenu(e) {
  e.preventDefault();
  if (state.calibrating) return;
  const pos = canvasPosFromEvent(e);
  const hit = hitTestPin(pos) || hitTestThumbnail(pos);
  if (hit) showPageContextMenu(e.clientX, e.clientY, [hit]);
}

// ---------- 右クリックメニュー（ページ移動・複数選択時は一括操作） ----------
function showPageContextMenu(clientX, clientY, photos) {
  const menu = el("ctxMenu");
  menu.innerHTML = "";
  const multi = photos.length > 1;
  const countLabel = multi ? `${photos.length}枚を` : "";

  visiblePages().forEach((pg, i) => {
    const pageIndex = pg.srcIndex;
    const allOnThisPage = photos.every((p) => p.pageIndex === pageIndex);
    const item = document.createElement("div");
    item.className = "ctxItem" + (allOnThisPage ? " current" : "");
    item.textContent = `${countLabel}ページ ${i + 1} へ移動` + (allOnThisPage ? "（現在のページ）" : "");
    if (!allOnThisPage) {
      item.addEventListener("click", () => {
        photos.forEach((p) => { p.pageIndex = pageIndex; });
        hideContextMenu();
        renderPhotoList();
        buildPageList();
        renderPins();
      });
    }
    menu.appendChild(item);
  });
  const sep = document.createElement("div");
  sep.className = "ctxSep";
  menu.appendChild(sep);

  if (!multi && photos[0].hasGps) {
    const numItem = document.createElement("div");
    numItem.className = "ctxItem";
    numItem.textContent = "🔢 ピン番号を変更";
    numItem.addEventListener("click", () => {
      hideContextMenu();
      promptEditPinNumber(photos[0]);
    });
    menu.appendChild(numItem);
  }

  if (photos.some((p) => p.hasGps)) {
    const colorItem = document.createElement("div");
    colorItem.className = "ctxItem";
    colorItem.textContent = multi ? "🎨 ピンの色を変更（選択分すべて）" : "🎨 ピンの色を変更";
    colorItem.addEventListener("click", () => {
      hideContextMenu();
      promptEditPinColor(photos);
    });
    menu.appendChild(colorItem);
  }

  if (!multi && photos[0].hasGps) {
    const detailItem = document.createElement("div");
    detailItem.className = "ctxItem";
    detailItem.textContent = "🔧 このピンだけ個別設定";
    detailItem.addEventListener("click", (e) => {
      e.stopPropagation(); // このクリックがwindowまで伝播してパネルを即閉じしないようにする
      hideContextMenu();
      openPinDetailPanel(clientX, clientY, photos[0]);
    });
    menu.appendChild(detailItem);
  }

  const delItem = document.createElement("div");
  delItem.className = "ctxItem ctxDanger";
  delItem.textContent = `🗑 ${countLabel}ゴミ箱へ移動`;
  delItem.addEventListener("click", () => {
    photos.forEach((p) => { p.trashed = true; });
    state.selectedPhotoIds = [];
    hideContextMenu();
    renderPhotoList();
    buildPageList();
    renderPins();
  });
  menu.appendChild(delItem);

  menu.style.left = clientX + "px";
  menu.style.top = clientY + "px";
  menu.hidden = false;
}
function hideContextMenu() {
  el("ctxMenu").hidden = true;
}

// ---------- ピンの個別設定パネル ----------
let pinDetailTarget = null;
function openPinDetailPanel(clientX, clientY, photo) {
  pinDetailTarget = photo;
  refreshPinDetailInputs();
  const panel = el("pinDetailPanel");
  panel.style.left = clientX + "px";
  panel.style.top = clientY + "px";
  panel.hidden = false;
}
function closePinDetailPanel() {
  el("pinDetailPanel").hidden = true;
  pinDetailTarget = null;
}
function refreshPinDetailInputs() {
  if (!pinDetailTarget) return;
  el("pdPinSize").value = effPinSize(pinDetailTarget);
  el("pdLeaderWidth").value = effLeaderWidth(pinDetailTarget);
  el("pdLeaderLength").value = effLeaderLength(pinDetailTarget);
  el("pdLeaderColor").value = effLeaderColor(pinDetailTarget);
  el("pdArrowWidth").value = effArrowWidth(pinDetailTarget);
  el("pdArrowLength").value = effArrowLength(pinDetailTarget);
  el("pdArrowColor").value = effArrowColor(pinDetailTarget);
  el("pdThumbBorderWidth").value = effThumbBorderWidth(pinDetailTarget);
  el("pdThumbBorderColor").value = effThumbBorderColor(pinDetailTarget);
}
function initPinDetailPanel() {
  el("pdPinSize").addEventListener("input", (e) => {
    if (!pinDetailTarget) return;
    pinDetailTarget.pinSizeOverride = Number(e.target.value);
    renderPins();
  });
  el("pdLeaderWidth").addEventListener("input", (e) => {
    if (!pinDetailTarget) return;
    pinDetailTarget.leaderWidthOverride = Number(e.target.value);
    renderPins();
  });
  el("pdLeaderLength").addEventListener("input", (e) => {
    if (!pinDetailTarget) return;
    pinDetailTarget.leaderLengthOverride = Number(e.target.value);
    renderPins();
  });
  el("pdLeaderColor").addEventListener("input", (e) => {
    if (!pinDetailTarget) return;
    pinDetailTarget.leaderColorOverride = e.target.value;
    renderPins();
  });
  el("pdArrowWidth").addEventListener("input", (e) => {
    if (!pinDetailTarget) return;
    pinDetailTarget.arrowWidthOverride = Number(e.target.value);
    renderPins();
  });
  el("pdArrowLength").addEventListener("input", (e) => {
    if (!pinDetailTarget) return;
    pinDetailTarget.arrowLengthOverride = Number(e.target.value);
    renderPins();
  });
  el("pdArrowColor").addEventListener("input", (e) => {
    if (!pinDetailTarget) return;
    pinDetailTarget.arrowColorOverride = e.target.value;
    renderPins();
  });
  el("pdThumbBorderWidth").addEventListener("input", (e) => {
    if (!pinDetailTarget) return;
    pinDetailTarget.thumbBorderWidthOverride = Number(e.target.value);
    renderPins();
  });
  el("pdThumbBorderColor").addEventListener("input", (e) => {
    if (!pinDetailTarget) return;
    pinDetailTarget.thumbBorderColorOverride = e.target.value;
    renderPins();
  });
  el("pinDetailPanel").querySelectorAll("button[data-reset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!pinDetailTarget) return;
      pinDetailTarget[btn.dataset.reset] = null;
      refreshPinDetailInputs();
      renderPins();
    });
  });
  el("pdCloseBtn").addEventListener("click", closePinDetailPanel);
  window.addEventListener("click", (e) => {
    const panel = el("pinDetailPanel");
    if (!panel.hidden && !panel.contains(e.target)) closePinDetailPanel();
  });
}

// ---------- 2点キャリブレーション ----------
function tryRunCalibration() {
  if (state.calibPoints.length !== 2 || state.calibSelectedIds.length !== 2) return;
  const [id1, id2] = state.calibSelectedIds;
  const p1 = state.photos.find((p) => p.id === id1);
  const p2 = state.photos.find((p) => p.id === id2);
  if (!p1 || !p2 || !p1.hasGps || !p2.hasGps) { alert("GPS情報のある写真を選択してください。"); return; }
  const [t1, t2] = state.calibPoints;

  const vb = { x: p2.baseX - p1.baseX, y: p2.baseY - p1.baseY };
  const vt = { x: t2.x - t1.x, y: t2.y - t1.y };
  const lenB = Math.hypot(vb.x, vb.y);
  const lenT = Math.hypot(vt.x, vt.y);
  if (lenB < 1e-6) { alert("選んだ2枚の写真のGPS位置が近すぎます。"); return; }

  const s = lenT / lenB;
  const angleB = Math.atan2(vb.y, vb.x);
  const angleT = Math.atan2(vt.y, vt.x);
  const theta = angleT - angleB;

  const photosOnPage = getPagePhotos(p1.pageIndex);
  const bb = getBaseBBox(photosOnPage);
  const anchor = { x: bb.minX, y: bb.maxY };
  const center0 = { x: (bb.minX + bb.maxX) / 2, y: (bb.minY + bb.maxY) / 2 };
  const cos = Math.cos(theta), sin = Math.sin(theta);
  const rot = (v) => ({ x: v.x * cos - v.y * sin, y: v.x * sin + v.y * cos });

  // p1.base を s*R(theta)*p + T = t1 が成り立つ T を求める: T = t1 - s*R(theta)*p1.base
  const rBase1 = rot({ x: p1.baseX, y: p1.baseY });
  const T_total = { x: t1.x - s * rBase1.x, y: t1.y - s * rBase1.y };

  // レイヤー内部表現 (scale=s, rotationDeg=theta, offsetX/Y) の offset を逆算
  const centerScaled = { x: anchor.x + (center0.x - anchor.x) * s, y: anchor.y + (center0.y - anchor.y) * s };
  const rCenter0 = rot(center0);
  const offset = { x: T_total.x - centerScaled.x + s * rCenter0.x, y: T_total.y - centerScaled.y + s * rCenter0.y };

  const t = getPageTransform(p1.pageIndex);
  t.scale = s;
  t.rotationDeg = theta * 180 / Math.PI;
  t.offsetX = offset.x;
  t.offsetY = offset.y;
  // 手動で微調整したピン(manualOffset)は基準座標系の値なので、
  // ここでレイヤーを再計算してもリセットする必要はなく、そのまま一緒に動く。

  syncLayerControlsToCurrentPage();
  renderPins();

  state.calibrating = false;
  state.calibPoints = [];
  state.calibSelectedIds = [];
  updateCalibUi();
  renderPhotoList();
}

// ---------- プロジェクトの保存/読込み ----------
// ブラウザは「htmlが置かれているフォルダ」をスクリプトへ自動的には教えてくれないため、
// 一度保存/読込みで使ったフォルダ(ハンドル)をIndexedDBに覚えておき、次回以降の
// ファイル選択ダイアログの初期フォルダ(startIn)として使う。初回はOS既定(ドキュメント等)
// になるが、一度htmlのフォルダで保存/読込みすれば、以後は自動的にそこが初期表示になる。
const IDB_NAME = "photoPdfProjectTool";
const IDB_STORE = "handles";
const IDB_KEY_LAST_DIR = "lastDir";
function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet(key) {
  let db;
  try {
    db = await idbOpen();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (e) { return null; }
  finally { if (db) db.close(); }
}
async function idbSet(key, value) {
  let db;
  try {
    db = await idbOpen();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) { /* 保存できなくても致命的ではないので無視 */ }
  finally { if (db) db.close(); }
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
function base64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
function dataUrlToFile(dataUrl, filename) {
  return new File([dataUrlToUint8Array(dataUrl)], filename, { type: "image/jpeg" });
}

function buildProjectManifest() {
  return {
    formatVersion: 1,
    savedAt: new Date().toISOString(),
    pdfName: state.pdfName,
    pdfBase64: arrayBufferToBase64(state.pdfBytesForExport),
    currentPage: state.currentPage,
    pages: state.pages,
    pdfSources: state.pdfSources,
    dayCompareThreshold: state.dayCompareThreshold,
    dayCompareGapHours: state.dayCompareGapHours,
    dayCompareRows: state.dayCompareRows,
    dayCompareRoundLabels: state.dayCompareRoundLabels,
    thumbSize: state.thumbSize,
    pinSize: state.pinSize,
    leaderLineWidth: state.leaderLineWidth,
    leaderLineLength: state.leaderLineLength,
    leaderLineColor: state.leaderLineColor,
    arrowWidth: state.arrowWidth,
    arrowLength: state.arrowLength,
    arrowColor: state.arrowColor,
    thumbBorderWidth: state.thumbBorderWidth,
    thumbBorderColor: state.thumbBorderColor,
    nextPhotoId: state.nextPhotoId,
    pageView: Object.fromEntries(state.pageView),
    pageTransform: Object.fromEntries(state.pageTransform),
    photos: state.photos.map((p) => ({
      id: p.id,
      name: p.name,
      thumbDataUrl: p.thumbDataUrl,
      aspectRatio: p.aspectRatio,
      lat: p.lat,
      lon: p.lon,
      hasGps: p.hasGps,
      capturedAt: p.capturedAt ? p.capturedAt.toISOString() : null,
      pageIndex: p.pageIndex,
      baseX: p.baseX,
      baseY: p.baseY,
      manualOffset: p.manualOffset,
      thumbOffset: p.thumbOffset,
      numberLabel: p.numberLabel,
      directionDeg: p.directionDeg,
      trashed: p.trashed,
      pinColor: p.pinColor,
      pinSizeOverride: p.pinSizeOverride,
      leaderWidthOverride: p.leaderWidthOverride,
      leaderLengthOverride: p.leaderLengthOverride,
      leaderColorOverride: p.leaderColorOverride,
      arrowWidthOverride: p.arrowWidthOverride,
      arrowLengthOverride: p.arrowLengthOverride,
      arrowColorOverride: p.arrowColorOverride,
      thumbBorderWidthOverride: p.thumbBorderWidthOverride,
      thumbBorderColorOverride: p.thumbBorderColorOverride,
    })),
  };
}

async function writeFile(dirHandle, name, contents) {
  const fh = await dirHandle.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(contents);
  await w.close();
}

// プロジェクトフォルダ(drawing.pdf・photos/・project.json)へ書き込む共通処理。
// 「保存(名前を付けて)」「保存(上書)」の両方から呼ばれる。
async function writeProjectFiles(projectDir, projectName) {
  el("projectStatus").textContent = "保存中...";
  await writeFile(projectDir, "drawing.pdf", state.pdfBytesForExport);

  const photosDir = await projectDir.getDirectoryHandle("photos", { create: true });
  for (const p of state.photos) {
    const bytes = p.file ? await p.file.arrayBuffer() : dataUrlToUint8Array(p.thumbDataUrl);
    await writeFile(photosDir, p.name, bytes);
  }

  const manifest = buildProjectManifest();
  await writeFile(projectDir, "project.json", JSON.stringify(manifest));

  state.currentProjectDirHandle = projectDir;
  state.currentProjectName = projectName;
  el("projectStatus").textContent = `プロジェクト「${projectName}」を保存しました（PDF・写真・project.json）。`;
}

// 名前を付けて保存：常に保存先フォルダとプロジェクト名を新しく尋ねる
async function saveProjectAs() {
  if (!state.pdfDoc) { alert("先にPDFを読み込んでください。"); return; }
  const defaultName = baseNameNoExt(state.pdfName || "project") + "_project";

  if (!window.showDirectoryPicker) {
    // File System Access API 非対応ブラウザ向けフォールバック：project.jsonのみダウンロード
    const manifest = buildProjectManifest();
    downloadBlob(new Blob([JSON.stringify(manifest)], { type: "application/json" }), defaultName + ".json");
    el("projectStatus").textContent = "このブラウザはフォルダへの直接保存に対応していないため、project.json のみダウンロードしました。";
    return;
  }

  // showDirectoryPicker() はユーザー操作(クリック)から間を置かずに呼び出す必要があるため、
  // フォルダ名を尋ねる prompt() より先に実行する(間にprompt/alert等を挟むと
  // 「Must be handling a user gesture」エラーになる)。
  // 前回保存/読込みに使ったフォルダをIndexedDBから取得し、ダイアログの初期フォルダにする
  // (無効なハンドルが渡された場合、ブラウザ側で既定の場所に自動的にフォールバックする)。
  const lastDir = await idbGet(IDB_KEY_LAST_DIR);
  let parentHandle;
  try {
    parentHandle = await window.showDirectoryPicker(lastDir ? { mode: "readwrite", startIn: lastDir } : { mode: "readwrite" });
  } catch (err) {
    if (err && err.name === "AbortError") { el("projectStatus").textContent = ""; return; }
    console.error(err);
    alert("保存先フォルダの選択に失敗しました: " + err.message);
    return;
  }
  idbSet(IDB_KEY_LAST_DIR, parentHandle);

  const projectName = prompt("保存するプロジェクトのフォルダ名を入力してください", defaultName);
  if (!projectName) return;

  try {
    const projectDir = await parentHandle.getDirectoryHandle(projectName, { create: true });
    await writeProjectFiles(projectDir, projectName);
  } catch (err) {
    if (err && err.name === "AbortError") { el("projectStatus").textContent = ""; return; }
    console.error(err);
    alert("プロジェクトの保存に失敗しました: " + err.message);
  }
}

// 上書き保存：直前に読込み/保存したフォルダへ、フォルダ選択やプロジェクト名の入力なしでそのまま保存する。
// まだ読込み/保存していない場合は保存先が無いため「名前を付けて保存」にフォールバックする。
async function saveProjectOverwrite() {
  if (!state.pdfDoc) { alert("先にPDFを読み込んでください。"); return; }
  if (!state.currentProjectDirHandle) {
    await saveProjectAs();
    return;
  }
  try {
    if (state.currentProjectDirHandle.requestPermission) {
      const perm = await state.currentProjectDirHandle.requestPermission({ mode: "readwrite" });
      if (perm !== "granted") {
        alert("保存先フォルダへの書き込み権限がありません。「名前を付けて保存」をやり直してください。");
        return;
      }
    }
    await writeProjectFiles(state.currentProjectDirHandle, state.currentProjectName);
  } catch (err) {
    console.error(err);
    alert("プロジェクトの上書き保存に失敗しました: " + err.message);
  }
}

async function restoreFromManifest(manifest) {
  const pdfBytes = base64ToArrayBuffer(manifest.pdfBase64);
  state.pdfBytesForExport = pdfBytes.slice(0);
  state.pdfName = manifest.pdfName || "drawing.pdf";

  const loadingTask = pdfjsLib.getDocument({ data: pdfBytes.slice(0) });
  state.pdfDoc = await loadingTask.promise;
  state.numPages = state.pdfDoc.numPages;

  // pages/pdfSourcesが無い(この機能追加前に保存された)project.jsonでも読み込めるよう、
  // その場合はゴミ箱・並び替えなしの初期状態として組み立て直す。
  state.pages = Array.isArray(manifest.pages) && manifest.pages.length
    ? manifest.pages.map((pg) => ({ srcIndex: pg.srcIndex, trashed: !!pg.trashed }))
    : Array.from({ length: state.numPages }, (_, i) => ({ srcIndex: i, trashed: false }));
  state.pdfSources = Array.isArray(manifest.pdfSources) && manifest.pdfSources.length
    ? manifest.pdfSources
    : [{ name: state.pdfName, pageCount: state.numPages }];
  state.dayCompareThreshold = manifest.dayCompareThreshold != null ? manifest.dayCompareThreshold : state.dayCompareThreshold;
  state.dayCompareGapHours = manifest.dayCompareGapHours != null ? manifest.dayCompareGapHours : state.dayCompareGapHours;
  // roundCandidates形式(この機能拡張後)以外の古い形式は互換性が無いため破棄し、再照合を促す。
  state.dayCompareRows = Array.isArray(manifest.dayCompareRows) && manifest.dayCompareRows.every((r) => Array.isArray(r.roundCandidates))
    ? manifest.dayCompareRows
    : [];
  state.dayCompareRoundLabels = Array.isArray(manifest.dayCompareRoundLabels) ? manifest.dayCompareRoundLabels : [];
  el("dayCompareGapHours").value = state.dayCompareGapHours;
  el("dayCompareThreshold").value = state.dayCompareThreshold;

  state.pageView = new Map(Object.entries(manifest.pageView || {}).map(([k, v]) => [Number(k), v]));
  state.pageTransform = new Map(Object.entries(manifest.pageTransform || {}).map(([k, v]) => [Number(k), v]));

  state.thumbSize = manifest.thumbSize || state.thumbSize;
  state.pinSize = manifest.pinSize || state.pinSize;
  state.leaderLineWidth = manifest.leaderLineWidth || state.leaderLineWidth;
  state.leaderLineLength = manifest.leaderLineLength != null ? manifest.leaderLineLength : state.leaderLineLength;
  state.leaderLineColor = manifest.leaderLineColor || state.leaderLineColor;
  state.arrowWidth = manifest.arrowWidth || state.arrowWidth;
  state.arrowLength = manifest.arrowLength || state.arrowLength;
  state.arrowColor = manifest.arrowColor || state.arrowColor;
  state.thumbBorderWidth = manifest.thumbBorderWidth != null ? manifest.thumbBorderWidth : state.thumbBorderWidth;
  state.thumbBorderColor = manifest.thumbBorderColor || state.thumbBorderColor;
  el("thumbSize").value = state.thumbSize;
  el("thumbSizeVal").value = state.thumbSize;
  el("thumbBorderWidth").value = state.thumbBorderWidth;
  el("thumbBorderWidthVal").value = state.thumbBorderWidth;
  el("thumbBorderColor").value = state.thumbBorderColor;
  el("pinSize").value = state.pinSize;
  el("pinSizeVal").value = state.pinSize;
  el("leaderWidth").value = state.leaderLineWidth;
  el("leaderWidthVal").value = state.leaderLineWidth;
  el("leaderLength").value = state.leaderLineLength;
  el("leaderLengthVal").value = state.leaderLineLength;
  el("leaderColor").value = state.leaderLineColor;
  el("arrowWidth").value = state.arrowWidth;
  el("arrowWidthVal").value = state.arrowWidth;
  el("arrowLength").value = state.arrowLength;
  el("arrowLengthVal").value = state.arrowLength;
  el("arrowColor").value = state.arrowColor;

  state.photos = (manifest.photos || []).map((p) => ({
    id: p.id,
    file: dataUrlToFile(p.thumbDataUrl, p.name),
    name: p.name,
    thumbDataUrl: p.thumbDataUrl,
    aspectRatio: p.aspectRatio || 1, // この機能追加前に保存されたproject.jsonは無いため正方形扱いにフォールバック
    lat: p.lat,
    lon: p.lon,
    hasGps: p.hasGps,
    capturedAt: p.capturedAt ? new Date(p.capturedAt) : null,
    pageIndex: p.pageIndex,
    baseX: p.baseX,
    baseY: p.baseY,
    manualOffset: p.manualOffset || null,
    thumbOffset: p.thumbOffset || null,
    numberLabel: p.numberLabel,
    directionDeg: p.directionDeg || 0,
    trashed: !!p.trashed,
    pinColor: p.pinColor || DEFAULT_PIN_COLOR,
    pinSizeOverride: p.pinSizeOverride != null ? p.pinSizeOverride : null,
    leaderWidthOverride: p.leaderWidthOverride != null ? p.leaderWidthOverride : null,
    leaderLengthOverride: p.leaderLengthOverride != null ? p.leaderLengthOverride : null,
    leaderColorOverride: p.leaderColorOverride != null ? p.leaderColorOverride : null,
    arrowWidthOverride: p.arrowWidthOverride != null ? p.arrowWidthOverride : null,
    arrowLengthOverride: p.arrowLengthOverride != null ? p.arrowLengthOverride : null,
    arrowColorOverride: p.arrowColorOverride != null ? p.arrowColorOverride : null,
    thumbBorderWidthOverride: p.thumbBorderWidthOverride != null ? p.thumbBorderWidthOverride : null,
    thumbBorderColorOverride: p.thumbBorderColorOverride != null ? p.thumbBorderColorOverride : null,
  }));
  state.nextPhotoId = manifest.nextPhotoId || (Math.max(0, ...state.photos.map((p) => p.id)) + 1);
  imageCache.clear();

  el("pdfMeta").textContent = state.pdfSources.length > 1
    ? `${state.pdfSources.map((s) => s.name).join("、")}\n合計 ${state.numPages} ページ（${state.pdfSources.length}個のPDF）`
    : `${state.pdfName}\n${state.numPages} ページ`;
  el("pageListBlock").hidden = false;
  el("viewerHint").hidden = true;
  el("photoMeta").textContent = `${state.photos.length} 枚（GPSなし: ${state.photos.filter((p) => !p.hasGps).length}枚）`;

  buildPageList();
  updateDayCompareStatus();
  if (manifest.currentPage === "compare") {
    gotoComparePage();
  } else {
    const visible = visiblePages();
    const savedPageValid = visible.some((pg) => pg.srcIndex === manifest.currentPage);
    await gotoPage(savedPageValid ? manifest.currentPage : (visible[0] ? visible[0].srcIndex : 0));
  }
}

async function startLoadProject() {
  if (window.showDirectoryPicker) {
    // プロジェクトの「フォルダ」自体を選んでもらう(project.jsonファイル単体ではなく)。
    // こうしてフォルダのハンドルを保持しておくことで、後から「保存(上書)」で
    // フォルダ選択やファイル名の入力なしに同じ場所へ書き戻せるようにする。
    try {
      const lastDir = await idbGet(IDB_KEY_LAST_DIR);
      const projectDir = await window.showDirectoryPicker(lastDir ? { mode: "readwrite", startIn: lastDir } : { mode: "readwrite" });
      idbSet(IDB_KEY_LAST_DIR, projectDir);
      let fileHandle;
      try {
        fileHandle = await projectDir.getFileHandle("project.json");
      } catch (err) {
        alert("選択したフォルダに project.json が見つかりませんでした。プロジェクトのフォルダを選択してください。");
        return;
      }
      const file = await fileHandle.getFile();
      await onProjectFileSelected(file, projectDir);
    } catch (err) {
      if (err && err.name === "AbortError") return;
      console.error(err);
      alert("プロジェクトの読み込みに失敗しました: " + err.message);
    }
    return;
  }
  el("projectInput").click();
}

async function onProjectFileSelected(file, projectDir) {
  try {
    el("projectStatus").textContent = "プロジェクトを読み込み中...";
    const text = await file.text();
    const manifest = JSON.parse(text);
    await restoreFromManifest(manifest);
    state.currentProjectDirHandle = projectDir || null;
    state.currentProjectName = projectDir ? projectDir.name : null;
    el("projectStatus").textContent = `プロジェクトを読み込みました（${state.pdfName}）。`;
  } catch (err) {
    console.error(err);
    alert("プロジェクトの読み込みに失敗しました: " + err.message);
    el("projectStatus").textContent = "";
  }
}

// ---------- 出力: 合成PDF ----------
async function exportCompositePdf() {
  if (!state.pdfBytesForExport) { alert("先にPDFを読み込んでください。"); return; }
  el("exportStatus").textContent = "PDF出力を作成中...";
  try {
    const { PDFDocument, rgb, StandardFonts } = PDFLib;
    const outDoc = await PDFDocument.load(state.pdfBytesForExport);
    const font = await outDoc.embedFont(StandardFonts.HelveticaBold);

    const activePhotos = getActivePhotos();
    for (const pg of visiblePages()) {
      const pageIndex = pg.srcIndex;
      const photosOnPage = getPagePhotos(pageIndex);
      if (!photosOnPage.length) continue;

      const page = outDoc.getPage(pageIndex);
      const view = getPageView(pageIndex);
      const srcPage = await state.pdfDoc.getPage(pageIndex + 1);
      // ピン座標は実際に描画したcanvas(回転角=CSSのみで見た目上回転、pdf.js自体はrotation:0で描画)
      // と同じ座標系なので、ここでも rotation は渡さず convertToPdfPoint で
      // 画面(左上原点,Y下向き)の座標を PDFページ座標(左下原点,Y上向き)へ変換する。
      const viewport = srcPage.getViewport({ scale: view.zoom / 100 });
      const pdfPoint = (x, y) => { const [px, py] = viewport.convertToPdfPoint(x, y); return { x: px, y: py }; };
      const pdfRect = (x0, y0, x1, y1) => {
        const c = [pdfPoint(x0, y0), pdfPoint(x1, y0), pdfPoint(x1, y1), pdfPoint(x0, y1)];
        const xs = c.map((p) => p.x), ys = c.map((p) => p.y);
        return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
      };
      const t = getPageTransform(pageIndex);
      const pins = photosOnPage.map((p) => ({
        photo: p,
        index: activePhotos.indexOf(p),
        pos: transformPoint(p, photosOnPage, t),
        dir: normalizeAngle(p.directionDeg + t.rotationDeg),
      }));

      for (const pin of pins) {
        const pinSizePx = effPinSize(pin.photo);
        const r = pinSizePx / viewport.scale;
        const screenX = pin.pos.x, screenY = pin.pos.y;
        const leaderLen = effLeaderLength(pin.photo);
        const { w: thumbW, h: thumbH } = thumbBoxSize(pin.photo);
        const { x: thumbCx, y: thumbCy } = thumbCenter(pin.pos, pinSizePx, thumbW, thumbH, leaderLen, pin.photo.thumbOffset);

        const center = pdfPoint(screenX, screenY);
        const leaderEnd = pdfPoint(thumbCx - thumbW * 0.15, thumbCy + thumbH * 0.15);
        const rect = pdfRect(thumbCx - thumbW / 2, thumbCy - thumbH / 2, thumbCx + thumbW / 2, thumbCy + thumbH / 2);

        // 引き出し線
        const [lcR, lcG, lcB] = hexToRgbTriple(effLeaderColor(pin.photo));
        page.drawLine({
          start: center, end: leaderEnd,
          thickness: effLeaderWidth(pin.photo), color: rgb(lcR, lcG, lcB),
        });

        // サムネイル画像（フチ付き）
        const jpgBytes = dataUrlToUint8Array(pin.photo.thumbDataUrl);
        const embedded = await outDoc.embedJpg(jpgBytes);
        const [bR, bG, bB] = hexToRgbTriple(effThumbBorderColor(pin.photo));
        const borderWpx = effThumbBorderWidth(pin.photo);
        page.drawRectangle({
          x: rect.x, y: rect.y, width: rect.width, height: rect.height,
          color: rgb(1, 1, 1), borderColor: rgb(bR, bG, bB), borderWidth: borderWpx,
        });
        const inset = (borderWpx / 2) / viewport.scale;
        page.drawImage(embedded, {
          x: rect.x + inset, y: rect.y + inset, width: rect.width - inset * 2, height: rect.height - inset * 2,
        });

        // 撮影方向の矢印
        const pinArrowLen = effArrowLength(pin.photo);
        const arrow = arrowGeometry(screenX, screenY, pin.dir, pinArrowLen, arrowHeadLength(effArrowWidth(pin.photo), pinArrowLen));
        const aBase = pdfPoint(arrow.base.x, arrow.base.y);
        const aTip = pdfPoint(arrow.tip.x, arrow.tip.y);
        const aWing1 = pdfPoint(arrow.wing1.x, arrow.wing1.y);
        const aWing2 = pdfPoint(arrow.wing2.x, arrow.wing2.y);
        const [aColR, aColG, aColB] = hexToRgbTriple(effArrowColor(pin.photo));
        const arrowColor = rgb(aColR, aColG, aColB);
        const arrowW = effArrowWidth(pin.photo);
        page.drawLine({ start: aBase, end: aTip, thickness: arrowW, color: arrowColor });
        page.drawLine({ start: aTip, end: aWing1, thickness: arrowW, color: arrowColor });
        page.drawLine({ start: aTip, end: aWing2, thickness: arrowW, color: arrowColor });

        // ピン
        const pinColorHex = pin.photo.pinColor || DEFAULT_PIN_COLOR;
        const [pr, pg, pb] = hexToRgbTriple(pinColorHex);
        const textHex = contrastTextColor(pinColorHex);
        const [tr, tg, tb] = hexToRgbTriple(textHex);
        page.drawCircle({ x: center.x, y: center.y, size: r, color: rgb(pr, pg, pb), borderColor: rgb(1, 1, 1), borderWidth: 1.2 });
        const label = pin.photo.numberLabel != null ? pin.photo.numberLabel : String(pin.index + 1);
        const fontSize = Math.max(7, r);
        page.drawText(label, {
          x: center.x - font.widthOfTextAtSize(label, fontSize) / 2,
          y: center.y - fontSize * 0.35, size: fontSize, font, color: rgb(tr, tg, tb),
        });
      }
    }

    // ゴミ箱に入れたページは出力しない。indexがずれないよう大きい番号から削除する。
    const trashedSrcIndices = state.pages.filter((pg) => pg.trashed).map((pg) => pg.srcIndex).sort((a, b) => b - a);
    for (const idx of trashedSrcIndices) outDoc.removePage(idx);

    // 末尾に日付比較ページを追加(1回目の写真が無ければ何もしない)
    const compareLayout = buildCompareLayoutRows();
    if (compareLayout.roundLabels.length) await appendDayComparePagesToPdf(outDoc, compareLayout);

    const bytes = await outDoc.save();
    downloadBlob(new Blob([bytes], { type: "application/pdf" }), baseNameNoExt(state.pdfName) + "_写真配置.pdf");
    el("exportStatus").textContent = "PDF出力が完了しました。";
  } catch (err) {
    console.error(err);
    el("exportStatus").textContent = "PDF出力に失敗しました: " + err.message;
  }
}
// pdf-lib標準フォント(Helvetica系)は日本語を含められないため、日本語ラベルは
// キャンバスで描画してPNG画像として埋め込む(数字だけのピン番号はbuildCompareCardImage側で
// 同様にラスタライズ済みなので、ここでは見出し等の日本語文言のみを対象にする)。
async function embedTextImage(outDoc, text, px, color) {
  const measureCanvas = document.createElement("canvas");
  const fontSpec = `${px}px sans-serif`;
  const mctx = measureCanvas.getContext("2d");
  mctx.font = fontSpec;
  const w = Math.ceil(mctx.measureText(text).width) + 6;
  const h = Math.ceil(px * 1.5);
  measureCanvas.width = w; measureCanvas.height = h;
  const ctx = measureCanvas.getContext("2d");
  ctx.font = fontSpec;
  ctx.fillStyle = color;
  ctx.textBaseline = "top";
  ctx.fillText(text, 3, 2);
  const png = await outDoc.embedPng(measureCanvas.toDataURL("image/png"));
  return { png, width: w, height: h };
}

// 日付比較の内容(列=回、行=地点)を、必要なだけ新しいページに追記する。列数(回数)ぶんページを
// 横に広げる。カードは1枚ずつPNG化して貼り付けるだけなので、既存ページの図面には一切影響しない。
async function appendDayComparePagesToPdf(outDoc, layout) {
  const margin = 24, cardW = 110, cardH = 100, gap = 8;
  const numCols = layout.roundLabels.length;
  const pageW = Math.max(842, margin * 2 + numCols * (cardW + gap) - gap);
  const pageH = 595;

  let page = outDoc.addPage([pageW, pageH]);
  let y = pageH - margin;
  const titleText = `日付比較（${layout.roundLabels.map((l, i) => `${i + 1}回目:${l}`).join(" / ")}）`;
  const titleImg = await embedTextImage(outDoc, titleText, 14, "#1a1a1a");
  page.drawImage(titleImg.png, { x: margin, y: y - titleImg.height, width: titleImg.width, height: titleImg.height });
  y -= titleImg.height + 12;

  for (let c = 0; c < numCols; c++) {
    const headImg = await embedTextImage(outDoc, `${c + 1}回目`, 12, "#444444");
    page.drawImage(headImg.png, { x: margin + c * (cardW + gap), y: y - headImg.height, width: headImg.width, height: headImg.height });
  }
  y -= 22;

  const ensureSpace = (neededH) => {
    if (y - neededH < margin) {
      page = outDoc.addPage([pageW, pageH]);
      y = pageH - margin;
    }
  };
  const placeCard = async (dataUrl, x, topY) => {
    const png = await outDoc.embedPng(dataUrl);
    page.drawImage(png, { x, y: topY - cardH, width: cardW, height: cardH });
  };

  for (const row of layout.rows) {
    const lines = Math.max(1, ...row.byRound.map((photos) => photos.length || 1));
    const rowH = lines * (cardH + gap) - gap;
    ensureSpace(rowH);

    const topY = y;
    for (let c = 0; c < numCols; c++) {
      const x = margin + c * (cardW + gap);
      const photos = row.byRound[c];
      for (let line = 0; line < photos.length; line++) {
        const photo = photos[line];
        const label = c === 0 ? row.label : photo.numberLabel;
        await placeCard(await buildCompareCardImage(photo, label, cardW, cardH), x, topY - line * (cardH + gap));
      }
    }
    y = topY - rowH - gap;
  }
}
function dataUrlToUint8Array(dataUrl) {
  const base64 = dataUrl.split(",")[1];
  const bin = atob(base64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
function baseNameNoExt(name) { return name.replace(/\.[^.]+$/, "") || "output"; }
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------- 出力: Excel（PDF図面・写真・配置情報をバラバラに） ----------
async function exportExcel() {
  if (!state.pdfDoc) { alert("先にPDFを読み込んでください。"); return; }
  el("exportStatus").textContent = "Excel出力を作成中...";
  try {
    const wb = new ExcelJS.Workbook();
    wb.creator = "写真PDF配置ツール";

    // シート1: PDF図面（ページ画像）
    const sheetPdf = wb.addWorksheet("PDF図面");
    let rowCursor = 1;
    for (const [i, pg] of visiblePages().entries()) {
      const pageIndex = pg.srcIndex;
      const page = await state.pdfDoc.getPage(pageIndex + 1);
      const viewport = page.getViewport({ scale: 1.5 });
      const c = document.createElement("canvas");
      c.width = viewport.width; c.height = viewport.height;
      await page.render({ canvasContext: c.getContext("2d"), viewport }).promise;
      const dataUrl = c.toDataURL("image/png");
      const imgId = wb.addImage({ base64: dataUrl, extension: "png" });

      sheetPdf.getCell(rowCursor, 1).value = `ページ ${i + 1}`;
      const wPx = viewport.width, hPx = viewport.height;
      const maxW = 900;
      const dispW = Math.min(maxW, wPx), dispH = hPx * (dispW / wPx);
      sheetPdf.addImage(imgId, { tl: { col: 0, row: rowCursor }, ext: { width: dispW, height: dispH } });
      rowCursor += Math.ceil(dispH / 18) + 3;
    }
    sheetPdf.getColumn(1).width = 14;

    // シート2: 写真一覧（サムネ + 位置情報。図面とは分離）
    const sheetPhotos = wb.addWorksheet("写真一覧");
    sheetPhotos.columns = [
      { header: "番号", key: "no", width: 6 },
      { header: "サムネイル", key: "thumb", width: 16 },
      { header: "ファイル名", key: "name", width: 28 },
      { header: "配置ページ", key: "page", width: 10 },
      { header: "緯度", key: "lat", width: 14 },
      { header: "経度", key: "lon", width: 14 },
      { header: "GPS有無", key: "gps", width: 10 },
    ];
    const activePhotos = getActivePhotos();
    activePhotos.forEach((p, idx) => {
      const r = sheetPhotos.addRow({
        no: p.numberLabel != null ? p.numberLabel : idx + 1,
        name: p.name,
        page: p.hasGps ? (displayPageNumber(p.pageIndex) || "(ページはゴミ箱内)") : "-",
        lat: p.hasGps ? p.lat : "",
        lon: p.hasGps ? p.lon : "",
        gps: p.hasGps ? "あり" : "なし",
      });
      r.height = 60;
      const imgId = wb.addImage({ base64: p.thumbDataUrl, extension: "jpeg" });
      sheetPhotos.addImage(imgId, { tl: { col: 1, row: r.number - 1 }, ext: { width: 70, height: 70 } });
    });

    // シート3: ピン配置情報（座標データのみ。図面・写真とは分離）
    const sheetPins = wb.addWorksheet("ピン配置座標");
    sheetPins.columns = [
      { header: "番号", key: "no", width: 6 },
      { header: "ファイル名", key: "name", width: 28 },
      { header: "ページ", key: "page", width: 8 },
      { header: "図面上X(px)", key: "x", width: 12 },
      { header: "図面上Y(px)", key: "y", width: 12 },
      { header: "撮影方向(度・上=0/時計回り)", key: "dir", width: 22 },
    ];
    for (const [i, pg] of visiblePages().entries()) {
      const pageIndex = pg.srcIndex;
      const photosOnPage = getPagePhotos(pageIndex);
      if (!photosOnPage.length) continue;
      const t = getPageTransform(pageIndex);
      photosOnPage.forEach((p) => {
        const pos = transformPoint(p, photosOnPage, t);
        const dir = normalizeAngle(p.directionDeg + t.rotationDeg);
        sheetPins.addRow({
          no: p.numberLabel != null ? p.numberLabel : activePhotos.indexOf(p) + 1,
          name: p.name, page: i + 1,
          x: Math.round(pos.x), y: Math.round(pos.y), dir: Math.round(dir),
        });
      });
    }

    // シート4以降: ページごとに、プレビュー画面と同じ見た目(図面+写真+ピン+矢印)を再現。
    // 後で手作業で微調整することを想定し、画像は1枚に合成せず、図面・引き出し線・矢印・
    // サムネイルの縁・サムネイル本体・ピンをそれぞれ独立した画像として重ねる(一切グループ化しない)。
    const EMU_PER_PX = 9525;
    const absAnchor = (xPx, yPx) => ({
      nativeCol: 0, nativeColOff: Math.round(xPx * EMU_PER_PX),
      nativeRow: 0, nativeRowOff: Math.round(yPx * EMU_PER_PX),
    });
    const miniPng = (w, h, draw) => {
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.ceil(w));
      c.height = Math.max(1, Math.ceil(h));
      draw(c.getContext("2d"));
      return c.toDataURL("image/png");
    };
    const addPng = (sheet, dataUrl, x, y, w, h) => {
      const id = wb.addImage({ base64: dataUrl, extension: "png" });
      sheet.addImage(id, { tl: absAnchor(x, y), ext: { width: w, height: h } });
    };

    for (const [i, pg] of visiblePages().entries()) {
      const pageIndex = pg.srcIndex;
      const photosOnPage = getPagePhotos(pageIndex);
      if (!photosOnPage.length) continue;

      const view = getPageView(pageIndex);
      const srcPage = await state.pdfDoc.getPage(pageIndex + 1);
      const viewport = srcPage.getViewport({ scale: view.zoom / 100 });

      const sheet = wb.addWorksheet(`ページ${i + 1}配置`);
      // 画像は絶対座標(nativeColOff/nativeRowOff)で配置するため列幅・行高自体は
      // 位置計算に使われないが、余裕を持って広げておきExcel側の警告を避ける。
      sheet.getColumn(1).width = Math.ceil((viewport.width + 400) / 6);
      sheet.getRow(1).height = (viewport.height + 400) * 0.75;

      // 背景: PDF図面(プレビューと同じ倍率で描画)
      const bgCanvas = document.createElement("canvas");
      bgCanvas.width = Math.ceil(viewport.width);
      bgCanvas.height = Math.ceil(viewport.height);
      await srcPage.render({ canvasContext: bgCanvas.getContext("2d"), viewport }).promise;
      addPng(sheet, bgCanvas.toDataURL("image/png"), 0, 0, viewport.width, viewport.height);

      const t = getPageTransform(pageIndex);
      const pins = photosOnPage.map((p) => ({
        photo: p,
        index: activePhotos.indexOf(p),
        pos: transformPoint(p, photosOnPage, t),
        dir: normalizeAngle(p.directionDeg + t.rotationDeg),
      }));

      for (const pin of pins) {
        const r = effPinSize(pin.photo);
        const { w: thumbW, h: thumbH } = thumbBoxSize(pin.photo);
        const leaderLen = effLeaderLength(pin.photo);
        const { x: thumbCx, y: thumbCy } = thumbCenter(pin.pos, r, thumbW, thumbH, leaderLen, pin.photo.thumbOffset);

        // 撮影方向の矢印
        {
          const xlArrowLen = effArrowLength(pin.photo);
          const arrow = arrowGeometry(pin.pos.x, pin.pos.y, pin.dir, xlArrowLen, arrowHeadLength(effArrowWidth(pin.photo), xlArrowLen));
          const w0 = effArrowWidth(pin.photo);
          const pts = [arrow.base, arrow.tip, arrow.wing1, arrow.wing2];
          const pad = Math.ceil(w0) + 3;
          const minX = Math.min(...pts.map((p) => p.x)) - pad;
          const minY = Math.min(...pts.map((p) => p.y)) - pad;
          const w = Math.max(...pts.map((p) => p.x)) + pad - minX;
          const h = Math.max(...pts.map((p) => p.y)) + pad - minY;
          const col = effArrowColor(pin.photo);
          const dataUrl = miniPng(w, h, (ctx) => {
            const off = (p) => ({ x: p.x - minX, y: p.y - minY });
            const b = off(arrow.base), tp = off(arrow.tip), w1 = off(arrow.wing1), w2 = off(arrow.wing2);
            ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = w0;
            ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(tp.x, tp.y); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(tp.x, tp.y); ctx.lineTo(w1.x, w1.y); ctx.lineTo(w2.x, w2.y); ctx.closePath(); ctx.fill();
          });
          addPng(sheet, dataUrl, minX, minY, w, h);
        }

        // 引き出し線
        {
          const lw = effLeaderWidth(pin.photo);
          const x1 = pin.pos.x, y1 = pin.pos.y;
          const x2 = thumbCx - thumbW / 2 * 0.3, y2 = thumbCy + thumbH / 2 * 0.3;
          const lc = effLeaderColor(pin.photo);
          const pad = Math.ceil(lw) + 2;
          const minX = Math.min(x1, x2) - pad, minY = Math.min(y1, y2) - pad;
          const w = Math.abs(x2 - x1) + pad * 2, h = Math.abs(y2 - y1) + pad * 2;
          const dataUrl = miniPng(w, h, (ctx) => {
            ctx.strokeStyle = lc;
            ctx.lineWidth = lw;
            ctx.beginPath();
            ctx.moveTo(x1 - minX, y1 - minY);
            ctx.lineTo(x2 - minX, y2 - minY);
            ctx.stroke();
          });
          addPng(sheet, dataUrl, minX, minY, w, h);
        }

        // サムネイルの縁(背景+枠線)
        {
          const borderW = effThumbBorderWidth(pin.photo);
          const pad = Math.ceil(borderW / 2) + 1;
          const dataUrl = miniPng(thumbW + pad * 2, thumbH + pad * 2, (ctx) => {
            ctx.fillStyle = "#fff";
            ctx.fillRect(pad, pad, thumbW, thumbH);
            if (borderW > 0) {
              ctx.lineWidth = borderW;
              ctx.strokeStyle = effThumbBorderColor(pin.photo);
              ctx.strokeRect(pad, pad, thumbW, thumbH);
            }
          });
          addPng(sheet, dataUrl, thumbCx - thumbW / 2 - pad, thumbCy - thumbH / 2 - pad, thumbW + pad * 2, thumbH + pad * 2);
        }

        // サムネイル写真本体
        {
          const inset = effThumbBorderWidth(pin.photo) / 2;
          const imgId = wb.addImage({ base64: pin.photo.thumbDataUrl, extension: "jpeg" });
          sheet.addImage(imgId, {
            tl: absAnchor(thumbCx - thumbW / 2 + inset, thumbCy - thumbH / 2 + inset),
            ext: { width: thumbW - inset * 2, height: thumbH - inset * 2 },
          });
        }

        // ピン(円+番号)
        {
          const pad = 3;
          const size = (r + pad) * 2;
          const pinColor = pin.photo.pinColor || DEFAULT_PIN_COLOR;
          const label = pin.photo.numberLabel != null ? pin.photo.numberLabel : String(pin.index + 1);
          const dataUrl = miniPng(size, size, (ctx) => {
            const cx = size / 2, cy = size / 2;
            ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.fillStyle = pinColor; ctx.fill();
            ctx.lineWidth = 1.5; ctx.strokeStyle = "#fff"; ctx.stroke();
            ctx.fillStyle = contrastTextColor(pinColor);
            ctx.font = `bold ${Math.max(9, r)}px sans-serif`;
            ctx.textAlign = "center"; ctx.textBaseline = "middle";
            ctx.fillText(label, cx, cy + 0.5);
          });
          addPng(sheet, dataUrl, pin.pos.x - size / 2, pin.pos.y - size / 2, size, size);
        }
      }
    }

    // シート: 日付比較。A列=番号、B列以降=1回目・2回目…という実際のExcelの列・行に
    // 沿った表にする(選択・並べ替えなどが自然にできるよう、単なる絶対座標の画像羅列にしない)。
    // 写真は圧縮・リサイズせず原本のバイト列のまま埋め込み、表示上の幅だけ指定cmに収める。
    const compareLayout = buildCompareLayoutRows();
    if (compareLayout.roundLabels.length) {
      const sheet = wb.addWorksheet("日付比較");
      const displayWidthCm = 10, gap = 8, cellPad = 4;
      const displayWidthPx = (displayWidthCm * 360000) / EMU_PER_PX;
      const numCols = compareLayout.roundLabels.length;

      sheet.getColumn(1).width = 8;
      for (let c = 0; c < numCols; c++) sheet.getColumn(2 + c).width = Math.ceil((displayWidthPx + 20) / 7);

      const headerRow = sheet.getRow(1);
      headerRow.getCell(1).value = "番号";
      compareLayout.roundLabels.forEach((label, i) => { headerRow.getCell(2 + i).value = `${i + 1}回目`; });
      headerRow.font = { bold: true };
      headerRow.height = 18;

      let excelRowNum = 2; // 1行目はヘッダーなので2行目から
      for (const row of compareLayout.rows) {
        // 表示幅は全写真共通(displayWidthCm)なので、縦横比だけから高さを先に計算できる
        const heightsByCol = row.byRound.map((photos) => photos.map((p) => displayWidthPx / (p.aspectRatio || 1)));
        const colTotalHeights = heightsByCol.map((hs) => hs.reduce((s, h) => s + h + gap, 0));
        const rowHeightPx = Math.max(20, ...colTotalHeights) + cellPad * 2;

        const excelRow = sheet.getRow(excelRowNum);
        excelRow.getCell(1).value = row.label;
        excelRow.height = rowHeightPx * 0.75; // px -> pt

        for (let c = 0; c < numCols; c++) {
          let yOffset = cellPad;
          for (const photo of row.byRound[c]) {
            // nativeCol/nativeRowで実際のセル(番号列の右隣から)を指定しつつ、セル内の
            // オフセット(nativeColOff/nativeRowOff)で複数候補を上下に重ならず並べる。
            const { heightPx } = await addOriginalPhotoImage(
              wb, sheet, photo, displayWidthCm, 1 + c, cellPad, excelRowNum - 1, yOffset);
            yOffset += heightPx + gap;
          }
        }
        excelRowNum++;
      }

      // 表らしく見えるよう罫線を付ける
      const thin = { style: "thin", color: { argb: "FFB9C0CC" } };
      for (let r = 1; r < excelRowNum; r++) {
        for (let c = 1; c <= numCols + 1; c++) {
          sheet.getCell(r, c).border = { top: thin, left: thin, bottom: thin, right: thin };
        }
      }
    }

    const buf = await wb.xlsx.writeBuffer();
    downloadBlob(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), baseNameNoExt(state.pdfName || "写真配置") + "_出力.xlsx");
    el("exportStatus").textContent = "Excel出力が完了しました。";
  } catch (err) {
    console.error(err);
    el("exportStatus").textContent = "Excel出力に失敗しました: " + err.message;
  }
}

init();
