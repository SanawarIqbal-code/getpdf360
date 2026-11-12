// GetPDF360 Split PDF: runs entirely in the browser. The file is never uploaded.
(function () {
  var box = document.querySelector("[data-split]");
  if (!box || !window.PDFLib) return;

  var MAX_FILE = 100 * 1024 * 1024; // 100 MB

  var input = box.querySelector("input[type=file]");
  var drop = box.querySelector(".drop");
  var statusBox = box.querySelector(".status");
  var fileNameEl = box.querySelector("[data-file-name]");
  var fileMetaEl = box.querySelector("[data-file-meta]");
  var rangeRow = box.querySelector("[data-range-row]");
  var rangeInput = box.querySelector("[data-ranges]");
  var goBtn = box.querySelector("[data-go]");
  var workingText = box.querySelector("[data-working-text]");
  var link = box.querySelector("a.download");
  var linkText = box.querySelector("[data-download-text]");
  var resultName = box.querySelector("[data-result-name]");
  var resultMeta = box.querySelector("[data-result-meta]");
  var resultBadge = box.querySelector(".result-badge");
  var receiptTimes = box.querySelectorAll("[data-receipt] time");
  var views = {
    pick: box.querySelector("[data-view=pick]"),
    options: box.querySelector("[data-view=options]"),
    working: box.querySelector("[data-view=working]"),
    done: box.querySelector("[data-view=done]")
  };

  var current = null; // { file, bytes, pages }
  var blobUrl = null;

  function show(name) {
    Object.keys(views).forEach(function (k) { views[k].hidden = k !== name; });
  }
  function setStatus(text, isError) {
    statusBox.textContent = text || "";
    statusBox.className = isError ? "status error" : "status";
  }
  function size(bytes) {
    return bytes < 1048576 ? Math.max(1, Math.round(bytes / 1024)) + " KB" : (bytes / 1048576).toFixed(1) + " MB";
  }
  function clock(d) {
    return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
  function mode() {
    var m = box.querySelector("input[name=mode]:checked");
    return m ? m.value : "extract";
  }
  function baseName() {
    return current.file.name.replace(/\.[^.]+$/, "");
  }

  // "1-3, 5, 8-10" -> [[1,3],[5,5],[8,10]]; throws a friendly message if invalid
  function parseRanges(text, max) {
    var parts = text.split(",").map(function (p) { return p.trim(); }).filter(Boolean);
    if (!parts.length) throw new Error("Type the pages you want, for example 1-3, 5");
    return parts.map(function (p) {
      var m = p.match(/^(\d+)\s*(?:-\s*(\d+))?$/);
      if (!m) throw new Error("\"" + p + "\" isn't a page number or range. Use numbers like 2 or 4-7");
      var a = parseInt(m[1], 10), b = m[2] ? parseInt(m[2], 10) : a;
      if (a < 1 || b < 1 || a > max || b > max) throw new Error("This PDF has " + max + " pages. \"" + p + "\" is outside that");
      if (a > b) { var t = a; a = b; b = t; }
      return [a, b];
    });
  }

  function load(file) {
    if (!file) return;
    setStatus("");
    if (!file.name.toLowerCase().endsWith(".pdf")) { setStatus("Please choose a PDF file.", true); return; }
    if (file.size > MAX_FILE) { setStatus("This file is " + size(file.size) + ". The limit is 100 MB.", true); return; }
    file.arrayBuffer().then(function (buf) {
      return PDFLib.PDFDocument.load(buf).then(function (doc) {
        current = { file: file, bytes: buf, pages: doc.getPageCount() };
        fileNameEl.textContent = file.name;
        fileMetaEl.textContent = current.pages + (current.pages === 1 ? " page" : " pages") + " · " + size(file.size);
        rangeInput.placeholder = current.pages > 1 ? "e.g. 1-" + Math.min(3, current.pages) + (current.pages > 4 ? ", 5" : "") : "1";
        updateMode();
        show("options");
      });
    }).catch(function (err) {
      var locked = err && /encrypt/i.test(err.message || "");
      setStatus(locked ? "This PDF is password-protected. Remove the password first." : "This PDF couldn't be read. It may be damaged.", true);
    });
  }

  function updateMode() {
    var m = mode();
    rangeRow.hidden = m === "every";
    goBtn.textContent = m === "every" ? "Split into " + (current ? current.pages : "") + " PDFs" : m === "ranges" ? "Split into separate PDFs" : "Extract pages";
  }

  function makePdf(src, from, to) {
    return PDFLib.PDFDocument.create().then(function (out) {
      var idx = [];
      for (var i = from - 1; i < to; i++) idx.push(i);
      return out.copyPages(src, idx).then(function (pages) {
        pages.forEach(function (p) { out.addPage(p); });
        return out.save();
      });
    });
  }

  function finish(blob, name, badge, meta) {
    var finished = new Date();
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    blobUrl = URL.createObjectURL(blob);
    link.href = blobUrl;
    link.download = name;
    linkText.textContent = "Download " + name;
    resultName.textContent = name;
    resultBadge.textContent = badge;
    resultMeta.textContent = meta + " · " + size(blob.size);
    receiptTimes.forEach(function (t) { t.textContent = clock(finished); t.setAttribute("datetime", finished.toISOString()); });
    show("done");
    link.focus();
  }

  function run() {
    if (!current) return;
    var m = mode(), ranges;
    setStatus("");
    try {
      ranges = m === "every"
        ? Array.from({ length: current.pages }, function (_, i) { return [i + 1, i + 1]; })
        : parseRanges(rangeInput.value, current.pages);
    } catch (err) { setStatus(err.message + ".", true); rangeInput.focus(); return; }
    if (m !== "extract" && !window.JSZip) { setStatus("Sorry, something didn't load. Refresh the page and try again.", true); return; }

    workingText.textContent = "Splitting on your device…";
    show("working");

    PDFLib.PDFDocument.load(current.bytes).then(function (src) {
      if (m === "extract") {
        // All chosen pages, in the order typed, in one PDF
        return PDFLib.PDFDocument.create().then(function (out) {
          var idx = [];
          ranges.forEach(function (r) { for (var i = r[0] - 1; i < r[1]; i++) idx.push(i); });
          return out.copyPages(src, idx).then(function (pages) {
            pages.forEach(function (p) { out.addPage(p); });
            return out.save();
          }).then(function (bytes) {
            finish(new Blob([bytes], { type: "application/pdf" }), baseName() + "-pages.pdf", "PDF",
              idx.length + (idx.length === 1 ? " page" : " pages"));
          });
        });
      }
      // One PDF per range (or per page), packed into a zip
      var zip = new JSZip();
      var pad = String(current.pages).length;
      return ranges.reduce(function (chain, r) {
        return chain.then(function () {
          return makePdf(src, r[0], r[1]).then(function (bytes) {
            var label = r[0] === r[1] ? "page-" + String(r[0]).padStart(pad, "0") : "pages-" + r[0] + "-" + r[1];
            zip.file(baseName() + "-" + label + ".pdf", bytes);
          });
        });
      }, Promise.resolve()).then(function () {
        return zip.generateAsync({ type: "blob" });
      }).then(function (blob) {
        finish(blob, baseName() + "-split.zip", "ZIP", ranges.length + " PDFs in one zip file");
      });
    }).catch(function () {
      show("options");
      setStatus("Sorry, this PDF couldn't be split. It may be damaged.", true);
    });
  }

  input.addEventListener("change", function () { load(input.files[0]); input.value = ""; });
  ["dragenter", "dragover"].forEach(function (evt) {
    drop.addEventListener(evt, function (e) { e.preventDefault(); drop.classList.add("over"); });
  });
  ["dragleave", "drop"].forEach(function (evt) {
    drop.addEventListener(evt, function (e) { e.preventDefault(); drop.classList.remove("over"); });
  });
  drop.addEventListener("drop", function (e) { load(e.dataTransfer.files[0]); });
  box.querySelectorAll("input[name=mode]").forEach(function (r) { r.addEventListener("change", updateMode); });
  rangeInput.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); run(); } });
  goBtn.addEventListener("click", run);
  box.querySelector("[data-change]").addEventListener("click", function () { current = null; setStatus(""); show("pick"); input.focus(); });
  box.querySelector("[data-again]").addEventListener("click", function () { setStatus(""); show(current ? "options" : "pick"); });
})();
