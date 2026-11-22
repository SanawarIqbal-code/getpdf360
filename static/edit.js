// GetPDF360 Edit PDF: add text, white-out, drawings and images on top of PDF pages.
// Everything runs in the browser; the file is never uploaded.
import * as pdfjsLib from "/static/vendor/pdf.min.js";
pdfjsLib.GlobalWorkerOptions.workerSrc = "/static/vendor/pdf.worker.min.js";

(function () {
  var box = document.querySelector("[data-editor]");
  if (!box || !window.PDFLib) return;

  var MAX_MB = 100, MAX_PAGES = 100;
  var q = function (s) { return box.querySelector(s); };
  var input = q("input[type=file]"), drop = q(".drop"), statusBox = q(".status");
  var pagesEl = q("[data-pages]"), toolbar = q("[data-toolbar]");
  var imageInput = q("[data-image-input]");
  var link = q("a.download"), linkText = q("[data-download-text]");
  var views = { pick: q("[data-view=pick]"), edit: q("[data-view=edit]"), working: q("[data-view=working]"), done: q("[data-view=done]") };
  var grid = box.closest(".tool-grid");

  var file = null, bytes = null, pdf = null, task = null, blobUrl = null;
  var pages = [];      // { num, viewport, wrap, layer, svg }
  var objects = [];    // { type, page, el, ...data }
  var tool = "text", colour = "#111111", textSize = 14, penWidth = 3;
  var selected = null;

  // ---------- small helpers ----------
  function show(name) {
    Object.keys(views).forEach(function (k) { views[k].hidden = k !== name; });
    if (grid) grid.classList.toggle("editing", name === "edit");
  }
  function setStatus(text, isError) { statusBox.textContent = text || ""; statusBox.className = isError ? "status error" : "status"; }
  function size(b) { return b < 1048576 ? Math.max(1, Math.round(b / 1024)) + " KB" : (b / 1048576).toFixed(1) + " MB"; }
  function clock(d) { return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
  function hexToRgb(hex) {
    var n = parseInt(hex.slice(1), 16);
    return PDFLib.rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  }
  function localPoint(page, e) {
    var r = page.layer.getBoundingClientRect();
    var k = page.viewport.width / r.width;   // screen px -> viewport px
    return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k };
  }
  function scaleOf(page) { return page.layer.getBoundingClientRect().width / page.viewport.width; }

  // Objects are positioned in viewport pixels, shown as % so they stay put when the page resizes
  function place(obj) {
    var vp = obj.page.viewport, el = obj.el;
    el.style.left = (obj.x / vp.width * 100) + "%";
    el.style.top = (obj.y / vp.height * 100) + "%";
    if (obj.w != null) el.style.width = (obj.w / vp.width * 100) + "%";
    if (obj.h != null) el.style.height = (obj.h / vp.height * 100) + "%";
    if (obj.type === "text") el.style.fontSize = "calc(" + (obj.size * vp.scale / vp.width * 100) + "cqw)";
  }

  // ---------- toolbar ----------
  function setTool(name) {
    tool = name;
    toolbar.querySelectorAll("[data-tool]").forEach(function (b) { b.setAttribute("aria-pressed", b.dataset.tool === name ? "true" : "false"); });
    box.dataset.tool = name;
    q("[data-text-size-wrap]").hidden = name !== "text";
    q("[data-pen-wrap]").hidden = name !== "draw";
    q("[data-colour-wrap]").hidden = name === "whiteout" || name === "image" || name === "move";
    q("[data-hint]").textContent = HINTS[name];
    if (name === "image") imageInput.click();
  }
  var HINTS = {
    text: "Click on a page to add text. Use White-out to hide words, then type over them.",
    whiteout: "Drag over the words you want to hide. Tap once for a small box.",
    draw: "Draw or sign with your mouse or finger.",
    image: "Choose a photo, logo or signature image. Then drag it into place and resize it from the corner.",
    move: "Drag text, boxes and images to move them. Select one and press ✕ to delete it."
  };
  toolbar.querySelectorAll("[data-tool]").forEach(function (b) {
    b.addEventListener("click", function () { setTool(b.dataset.tool); });
  });
  toolbar.querySelectorAll("[data-colour]").forEach(function (b) {
    b.addEventListener("click", function () {
      colour = b.dataset.colour;
      toolbar.querySelectorAll("[data-colour]").forEach(function (x) { x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
      if (selected && (selected.type === "text" || selected.type === "draw")) {
        selected.colour = colour;
        if (selected.type === "text") selected.el.style.color = colour;
        else selected.path.setAttribute("stroke", colour);
      }
    });
  });
  q("[data-text-size]").addEventListener("change", function (e) {
    textSize = parseInt(e.target.value, 10);
    if (selected && selected.type === "text") { selected.size = textSize; place(selected); }
  });
  q("[data-pen]").addEventListener("change", function (e) { penWidth = parseFloat(e.target.value); });
  q("[data-undo]").addEventListener("click", function () { if (objects.length) remove(objects[objects.length - 1]); });

  // ---------- selecting, moving, resizing, deleting ----------
  function select(obj) {
    if (selected && selected.el) selected.el.classList.remove("sel");
    selected = obj;
    if (obj && obj.el) obj.el.classList.add("sel");
  }
  function remove(obj) {
    if (obj.el) obj.el.remove();
    if (obj.path) obj.path.remove();
    objects = objects.filter(function (o) { return o !== obj; });
    if (selected === obj) selected = null;
  }
  document.addEventListener("keydown", function (e) {
    if (!selected || views.edit.hidden) return;
    if ((e.key === "Delete" || e.key === "Backspace") && document.activeElement !== selected.text) {
      e.preventDefault(); remove(selected);
    }
  });

  function addHandles(obj, resizable) {
    var del = document.createElement("button");
    del.type = "button"; del.className = "ed-del"; del.setAttribute("aria-label", "Delete"); del.textContent = "✕";
    del.addEventListener("pointerdown", function (e) { e.stopPropagation(); });
    del.addEventListener("click", function (e) { e.stopPropagation(); remove(obj); });
    obj.el.appendChild(del);
    var grip = document.createElement("span");
    grip.className = "ed-grip"; grip.title = "Drag to move"; grip.textContent = "⠿";
    obj.el.appendChild(grip);
    dragger(obj, obj.type === "text" ? grip : obj.el, "move");
    if (resizable) {
      var rs = document.createElement("span");
      rs.className = "ed-resize"; rs.title = "Drag to resize";
      obj.el.appendChild(rs);
      dragger(obj, rs, "resize");
    }
  }

  function dragger(obj, handle, mode) {
    handle.addEventListener("pointerdown", function (e) {
      if (tool === "draw") return;
      if (mode === "move" && obj.type === "text" && handle !== e.target) return;
      e.preventDefault(); e.stopPropagation();
      select(obj);
      var start = localPoint(obj.page, e), ox = obj.x, oy = obj.y, ow = obj.w, oh = obj.h;
      var ratio = obj.type === "image" ? obj.h / obj.w : null;
      handle.setPointerCapture(e.pointerId);
      function moveTo(ev) {
        var p = localPoint(obj.page, ev), dx = p.x - start.x, dy = p.y - start.y;
        var vp = obj.page.viewport;
        if (mode === "move") {
          obj.x = Math.max(0, Math.min(vp.width - 10, ox + dx));
          obj.y = Math.max(0, Math.min(vp.height - 10, oy + dy));
        } else {
          obj.w = Math.max(12, ow + dx);
          obj.h = ratio ? obj.w * ratio : Math.max(8, oh + dy);
        }
        place(obj);
      }
      function up() {
        handle.removeEventListener("pointermove", moveTo);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
      }
      handle.addEventListener("pointermove", moveTo);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
  }

  // ---------- creating objects ----------
  function addText(page, x, y) {
    var obj = { type: "text", page: page, x: x, y: y, size: textSize, colour: colour };
    var el = document.createElement("div");
    el.className = "ed-obj ed-text";
    var t = document.createElement("div");
    t.className = "ed-text-in"; t.contentEditable = "true"; t.spellcheck = true;
    t.setAttribute("role", "textbox"); t.setAttribute("aria-label", "Text on page " + page.num);
    t.style.color = colour;
    el.style.color = colour;
    el.appendChild(t);
    obj.el = el; obj.text = t;
    page.layer.appendChild(el);
    addHandles(obj, false);
    place(obj);
    t.addEventListener("focus", function () { select(obj); });
    t.addEventListener("blur", function () { if (!t.innerText.trim()) remove(obj); });
    t.addEventListener("pointerdown", function (e) { e.stopPropagation(); });
    t.addEventListener("paste", function (e) {   // paste as plain text only
      e.preventDefault();
      var text = (e.clipboardData || window.clipboardData).getData("text");
      document.execCommand("insertText", false, text);
    });
    objects.push(obj);
    select(obj);
    t.focus();
    return obj;
  }

  function addBox(page, x, y, w, h) {
    var obj = { type: "whiteout", page: page, x: x, y: y, w: w, h: h };
    obj.el = document.createElement("div");
    obj.el.className = "ed-obj ed-white";
    page.layer.appendChild(obj.el);
    addHandles(obj, true);
    place(obj);
    objects.push(obj);
    select(obj);
    return obj;
  }

  function addImage(page, img, dataUrl) {
    var vp = page.viewport;
    var w = Math.min(vp.width * 0.4, img.naturalWidth), h = w * img.naturalHeight / img.naturalWidth;
    var obj = { type: "image", page: page, x: (vp.width - w) / 2, y: (vp.height - h) / 2, w: w, h: h, img: img, src: dataUrl };
    obj.el = document.createElement("div");
    obj.el.className = "ed-obj ed-img";
    var im = document.createElement("img"); im.src = dataUrl; im.alt = ""; im.draggable = false;
    obj.el.appendChild(im);
    page.layer.appendChild(obj.el);
    addHandles(obj, true);
    place(obj);
    objects.push(obj);
    select(obj);
  }

  imageInput.addEventListener("change", function () {
    var f = imageInput.files[0];
    imageInput.value = "";
    if (!f) { setTool("move"); return; }
    if (!/^image\//.test(f.type)) { setStatus("Please choose a JPG or PNG image.", true); return; }
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () { addImage(visiblePage(), img, reader.result); setTool("move"); };
      img.onerror = function () { setStatus("That image couldn't be opened. Try a JPG or PNG.", true); };
      img.src = reader.result;
    };
    reader.readAsDataURL(f);
  });

  function visiblePage() {
    var best = pages[0], bestDist = Infinity, mid = window.innerHeight / 2;
    pages.forEach(function (p) {
      var r = p.wrap.getBoundingClientRect();
      var d = Math.abs((r.top + r.bottom) / 2 - mid);
      if (d < bestDist) { bestDist = d; best = p; }
    });
    return best;
  }

  // ---------- page events: click for text, drag for white-out and drawing ----------
  function wirePage(page) {
    page.layer.addEventListener("pointerdown", function (e) {
      if (e.target !== page.layer && e.target !== page.svg) return;
      select(null);
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      var p = localPoint(page, e);
      if (tool === "text") {
        e.preventDefault();
        addText(page, p.x, Math.max(0, p.y - textSize * page.viewport.scale * 0.6));
      } else if (tool === "whiteout") {
        e.preventDefault();
        var obj = addBox(page, p.x, p.y, 1, 1), start = p, moved = false;
        page.layer.setPointerCapture(e.pointerId);
        var mv = function (ev) {
          var c = localPoint(page, ev); moved = true;
          obj.x = Math.min(start.x, c.x); obj.y = Math.min(start.y, c.y);
          obj.w = Math.abs(c.x - start.x); obj.h = Math.abs(c.y - start.y);
          place(obj);
        };
        var up = function () {
          page.layer.removeEventListener("pointermove", mv);
          page.layer.removeEventListener("pointerup", up);
          if (!moved || obj.w < 6 || obj.h < 4) {   // a tap makes a word-sized box
            var s = page.viewport.scale;
            obj.w = 120 * s; obj.h = 22 * s; obj.x = start.x - obj.w / 2; obj.y = start.y - obj.h / 2;
            place(obj);
          }
        };
        page.layer.addEventListener("pointermove", mv);
        page.layer.addEventListener("pointerup", up);
      } else if (tool === "draw") {
        e.preventDefault();
        var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        var width = penWidth * page.viewport.scale;
        path.setAttribute("stroke", colour); path.setAttribute("stroke-width", width);
        path.setAttribute("fill", "none"); path.setAttribute("stroke-linecap", "round"); path.setAttribute("stroke-linejoin", "round");
        page.svg.appendChild(path);
        var stroke = { type: "draw", page: page, points: [p], colour: colour, width: penWidth, path: path };
        objects.push(stroke);
        var redraw = function () {
          path.setAttribute("d", stroke.points.map(function (pt, i) { return (i ? "L" : "M") + pt.x.toFixed(1) + " " + pt.y.toFixed(1); }).join(" ") + (stroke.points.length === 1 ? " l0.1 0" : ""));
        };
        redraw();
        page.layer.setPointerCapture(e.pointerId);
        var mv2 = function (ev) { stroke.points.push(localPoint(page, ev)); redraw(); };
        var up2 = function () { page.layer.removeEventListener("pointermove", mv2); page.layer.removeEventListener("pointerup", up2); };
        page.layer.addEventListener("pointermove", mv2);
        page.layer.addEventListener("pointerup", up2);
      }
    });
  }

  // ---------- loading the PDF ----------
  function load(f) {
    if (!f) return;
    setStatus("");
    if (!f.name.toLowerCase().endsWith(".pdf")) { setStatus("Please choose a PDF file.", true); return; }
    if (f.size > MAX_MB * 1048576) { setStatus("This file is " + size(f.size) + ". The limit is " + MAX_MB + " MB.", true); return; }
    f.arrayBuffer().then(function (buf) {
      return PDFLib.PDFDocument.load(buf).then(function () { return buf; });
    }).then(function (buf) {
      file = f; bytes = buf;
      if (task) task.destroy();
      task = pdfjsLib.getDocument({ data: new Uint8Array(buf.slice(0)) });
      return task.promise;
    }).then(function (doc) {
      pdf = doc;
      if (doc.numPages > MAX_PAGES) throw { friendly: "This PDF has " + doc.numPages + " pages. The editor works on up to " + MAX_PAGES + " pages. Use Split PDF first." };
      objects = []; pages = []; selected = null;
      pagesEl.innerHTML = "";
      q("[data-file-name]").textContent = f.name;
      q("[data-file-meta]").textContent = doc.numPages + (doc.numPages === 1 ? " page" : " pages") + " · " + size(f.size);
      show("edit");
      setTool("text");
      var chain = Promise.resolve();
      for (var n = 1; n <= doc.numPages; n++) chain = chain.then(renderPage.bind(null, n));
      return chain;
    }).catch(function (err) {
      show("pick");
      if (err && err.friendly) return setStatus(err.friendly, true);
      var locked = err && /encrypt|password/i.test(err.message || err.name || "");
      setStatus(locked ? "This PDF is password-protected. Remove the password first." : "This PDF couldn't be opened. It may be damaged.", true);
    });
  }

  function renderPage(n) {
    return pdf.getPage(n).then(function (pg) {
      var cssWidth = Math.min(pagesEl.clientWidth || 800, 1000);
      var base = pg.getViewport({ scale: 1 });
      var viewport = pg.getViewport({ scale: cssWidth / base.width });
      var ratio = Math.min(window.devicePixelRatio || 1, 2);
      var wrap = document.createElement("div");
      wrap.className = "ed-page";
      wrap.style.aspectRatio = viewport.width + " / " + viewport.height;
      var label = document.createElement("span");
      label.className = "ed-page-num"; label.textContent = "Page " + n;
      var canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width * ratio); canvas.height = Math.floor(viewport.height * ratio);
      var layer = document.createElement("div");
      layer.className = "ed-layer";
      var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 " + viewport.width + " " + viewport.height);
      svg.setAttribute("class", "ed-svg");
      layer.appendChild(svg);
      wrap.appendChild(canvas); wrap.appendChild(layer); wrap.appendChild(label);
      pagesEl.appendChild(wrap);
      var page = { num: n, viewport: viewport, wrap: wrap, layer: layer, svg: svg, rotation: viewport.rotation };
      pages.push(page);
      wirePage(page);
      var ctx = canvas.getContext("2d");
      ctx.fillStyle = "#FFFFFF"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      return pg.render({ canvas: canvas, canvasContext: ctx, viewport: pg.getViewport({ scale: viewport.scale * ratio }) }).promise
        .then(function () { pg.cleanup(); });
    });
  }

  // ---------- saving: draw everything into the real PDF with pdf-lib ----------
  function toPdf(page, x, y) { return page.viewport.convertToPdfPoint(x, y); }
  function rectToPdf(page, x, y, w, h) {
    var a = toPdf(page, x, y), b = toPdf(page, x + w, y + h);
    return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) };
  }

  function save() {
    if (!objects.length) { setStatus("Add some text, a white-out box, a drawing or an image first.", true); return; }
    setStatus("");
    // Read typed text while it is still on screen (hidden elements lose their line breaks)
    objects.forEach(function (o) { if (o.type === "text") o.value = o.text.innerText; });
    var started = new Date();
    q("[data-working-text]").textContent = "Saving your PDF on your device…";
    show("working");
    var problems = [];
    PDFLib.PDFDocument.load(bytes).then(function (doc) {
      return doc.embedFont(PDFLib.StandardFonts.Helvetica).then(function (font) {
        var docPages = doc.getPages();
        // White-out first, so text and drawings can go on top of it
        var order = { whiteout: 0, image: 1, draw: 2, text: 3 };
        var list = objects.slice().sort(function (a, b) { return order[a.type] - order[b.type]; });
        return list.reduce(function (chain, obj) {
          return chain.then(function () {
            var target = docPages[obj.page.num - 1];
            if (obj.type === "whiteout") {
              var r = rectToPdf(obj.page, obj.x, obj.y, obj.w, obj.h);
              target.drawRectangle({ x: r.x, y: r.y, width: r.w, height: r.h, color: PDFLib.rgb(1, 1, 1) });
            } else if (obj.type === "text") {
              var text = obj.value.replace(/ /g, " ").replace(/\n$/, "");
              if (!text.trim()) return;
              var lines = text.split("\n");
              var px = obj.size * obj.page.viewport.scale;
              // Turn characters Helvetica can't show into "?" and remember to warn the user
              var safe = lines.map(function (line) {
                return Array.from(line).map(function (ch) {
                  try { font.encodeText(ch); return ch; } catch (e) { problems.push(ch); return "?"; }
                }).join("");
              });
              var origin = toPdf(obj.page, obj.x, obj.y + px * 0.945);
              target.drawText(safe.join("\n"), { x: origin[0], y: origin[1], size: obj.size, font: font,
                color: hexToRgb(obj.colour), lineHeight: obj.size * 1.2, rotate: PDFLib.degrees(-obj.page.rotation) });
            } else if (obj.type === "draw") {
              var d = obj.points.map(function (pt, i) {
                var c = toPdf(obj.page, pt.x, pt.y);
                return (i ? "L" : "M") + c[0].toFixed(2) + " " + (-c[1]).toFixed(2);
              }).join(" ") + (obj.points.length === 1 ? " l0.1 0" : "");
              target.drawSvgPath(d, { x: 0, y: 0, borderColor: hexToRgb(obj.colour), borderWidth: obj.width,
                borderLineCap: PDFLib.LineCapStyle.Round });
            } else if (obj.type === "image") {
              var canvas = document.createElement("canvas");
              var scale = Math.min(1, 2000 / Math.max(obj.img.naturalWidth, obj.img.naturalHeight));
              canvas.width = Math.round(obj.img.naturalWidth * scale); canvas.height = Math.round(obj.img.naturalHeight * scale);
              canvas.getContext("2d").drawImage(obj.img, 0, 0, canvas.width, canvas.height);
              return new Promise(function (res) { canvas.toBlob(res, "image/png"); })
                .then(function (blob) { return blob.arrayBuffer(); })
                .then(function (buf) { return doc.embedPng(buf); })
                .then(function (png) {
                  var r2 = rectToPdf(obj.page, obj.x, obj.y, obj.w, obj.h);
                  target.drawImage(png, { x: r2.x, y: r2.y, width: r2.w, height: r2.h });
                });
            }
          });
        }, Promise.resolve()).then(function () { return doc.save(); });
      });
    }).then(function (out) {
      var finished = new Date();
      var blob = new Blob([out], { type: "application/pdf" });
      var name = file.name.replace(/\.[^.]+$/, "") + "-edited.pdf";
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      blobUrl = URL.createObjectURL(blob);
      link.href = blobUrl; link.download = name;
      linkText.textContent = "Download " + name;
      q("[data-result-name]").textContent = name;
      q("[data-result-meta]").textContent = objects.length + (objects.length === 1 ? " change" : " changes") + " · " + size(blob.size) +
        " · saved in " + ((finished - started) / 1000).toFixed(1) + " seconds";
      box.querySelectorAll("[data-receipt] time").forEach(function (t) { t.textContent = clock(finished); t.setAttribute("datetime", finished.toISOString()); });
      show("done");
      link.focus();
      if (problems.length) setStatus("Some characters (" + Array.from(new Set(problems)).slice(0, 8).join(" ") + ") aren't supported yet and were saved as ?. English letters, numbers and common symbols work.", true);
    }).catch(function (err) {
      if (window.console) console.error(err);
      show("edit");
      setStatus("Sorry, this PDF couldn't be saved. It may be damaged or protected.", true);
    });
  }

  q("[data-save]").addEventListener("click", save);
  q("[data-change]").addEventListener("click", function () { show("pick"); setStatus(""); input.focus(); });
  q("[data-again]").addEventListener("click", function () { setStatus(""); show("edit"); });
  input.addEventListener("change", function () { load(input.files[0]); input.value = ""; });
  ["dragenter", "dragover"].forEach(function (evt) { drop.addEventListener(evt, function (e) { e.preventDefault(); drop.classList.add("over"); }); });
  ["dragleave", "drop"].forEach(function (evt) { drop.addEventListener(evt, function (e) { e.preventDefault(); drop.classList.remove("over"); }); });
  drop.addEventListener("drop", function (e) { load(e.dataTransfer.files[0]); });
  if (window.GPHandoff) GPHandoff.take().then(function (f) { if (f && f.length) load(f[0]); });
})();
