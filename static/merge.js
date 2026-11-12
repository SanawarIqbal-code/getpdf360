// GetPDF360 Merge PDF: runs entirely in the browser. Files are never uploaded.
(function () {
  var box = document.querySelector("[data-merge]");
  if (!box || !window.PDFLib) return;

  var MAX_FILE = 50 * 1024 * 1024;    // 50 MB per file
  var MAX_TOTAL = 200 * 1024 * 1024;  // 200 MB in total
  var MAX_FILES = 50;

  var input = box.querySelector("input[type=file]");
  var drop = box.querySelector(".drop");
  var listEl = box.querySelector("[data-list]");
  var countEl = box.querySelector("[data-count]");
  var mergeBtn = box.querySelector("[data-merge-btn]");
  var addBtn = box.querySelector("[data-add]");
  var statusBox = box.querySelector(".status");
  var workingText = box.querySelector("[data-working-text]");
  var link = box.querySelector("a.download");
  var linkText = box.querySelector("[data-download-text]");
  var resultName = box.querySelector("[data-result-name]");
  var resultMeta = box.querySelector("[data-result-meta]");
  var receiptTimes = box.querySelectorAll("[data-receipt] time");
  var views = {
    pick: box.querySelector("[data-view=pick]"),
    list: box.querySelector("[data-view=list]"),
    working: box.querySelector("[data-view=working]"),
    done: box.querySelector("[data-view=done]")
  };

  var files = [];   // { file, pages }
  var blobUrl = null;
  var dragIndex = null;

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
  function totalSize() {
    return files.reduce(function (sum, f) { return sum + f.file.size; }, 0);
  }

  // Read each file once to check it is a real, unlocked PDF and count its pages
  function addFiles(fileList) {
    var incoming = Array.prototype.slice.call(fileList || []);
    if (!incoming.length) return;
    setStatus("");
    var problems = [];
    var jobs = incoming.map(function (file) {
      if (!file.name.toLowerCase().endsWith(".pdf")) { problems.push(file.name + " is not a PDF"); return null; }
      if (file.size > MAX_FILE) { problems.push(file.name + " is over 50 MB"); return null; }
      return file.arrayBuffer().then(function (buf) {
        return PDFLib.PDFDocument.load(buf).then(function (doc) {
          return { file: file, pages: doc.getPageCount() };
        });
      }).catch(function (err) {
        var locked = err && /encrypt/i.test(err.message || "");
        problems.push(file.name + (locked ? " is password-protected" : " couldn't be read"));
        return null;
      });
    });
    Promise.all(jobs).then(function (results) {
      results.forEach(function (r) {
        if (!r) return;
        if (files.length >= MAX_FILES) { problems.push("You can merge up to " + MAX_FILES + " files at once"); return; }
        if (totalSize() + r.file.size > MAX_TOTAL) { problems.push("All files together must be under 200 MB"); return; }
        files.push(r);
      });
      render();
      if (problems.length) setStatus(problems.join(". ") + ".", true);
    });
  }

  function move(from, to) {
    if (to < 0 || to >= files.length || from === to) return;
    var item = files.splice(from, 1)[0];
    files.splice(to, 0, item);
    render();
  }

  function render() {
    if (!files.length) { show("pick"); return; }
    show("list");
    listEl.innerHTML = "";
    files.forEach(function (f, i) {
      var li = document.createElement("li");
      li.className = "merge-item";
      li.draggable = true;
      li.dataset.index = i;
      li.innerHTML =
        '<span class="merge-num">' + (i + 1) + '</span>' +
        '<span class="merge-info"><span class="merge-name"></span><span class="merge-meta"></span></span>' +
        '<span class="merge-actions">' +
        '<button type="button" data-up aria-label="Move up">↑</button>' +
        '<button type="button" data-down aria-label="Move down">↓</button>' +
        '<button type="button" data-remove aria-label="Remove">✕</button></span>';
      li.querySelector(".merge-name").textContent = f.file.name;
      li.querySelector(".merge-meta").textContent = f.pages + (f.pages === 1 ? " page" : " pages") + " · " + size(f.file.size);
      li.querySelector("[data-up]").disabled = i === 0;
      li.querySelector("[data-down]").disabled = i === files.length - 1;
      li.querySelector("[data-up]").addEventListener("click", function () { move(i, i - 1); });
      li.querySelector("[data-down]").addEventListener("click", function () { move(i, i + 1); });
      li.querySelector("[data-remove]").addEventListener("click", function () { files.splice(i, 1); render(); });
      li.addEventListener("dragstart", function () { dragIndex = i; li.classList.add("dragging"); });
      li.addEventListener("dragend", function () { li.classList.remove("dragging"); });
      li.addEventListener("dragover", function (e) { e.preventDefault(); });
      li.addEventListener("drop", function (e) {
        e.preventDefault(); e.stopPropagation();
        if (dragIndex !== null) move(dragIndex, i);
        dragIndex = null;
      });
      listEl.appendChild(li);
    });
    var pages = files.reduce(function (s, f) { return s + f.pages; }, 0);
    countEl.textContent = files.length + (files.length === 1 ? " file" : " files") + " · " + pages + " pages · " + size(totalSize());
    mergeBtn.disabled = files.length < 2;
    mergeBtn.textContent = files.length < 2 ? "Add at least 2 PDFs" : "Merge " + files.length + " PDFs";
  }

  function merge() {
    if (files.length < 2) return;
    setStatus("");
    workingText.textContent = "Merging " + files.length + " PDFs on your device…";
    show("working");
    var started = new Date();
    PDFLib.PDFDocument.create().then(function (out) {
      return files.reduce(function (chain, f) {
        return chain.then(function () {
          return f.file.arrayBuffer().then(function (buf) {
            return PDFLib.PDFDocument.load(buf);
          }).then(function (src) {
            return out.copyPages(src, src.getPageIndices());
          }).then(function (pages) {
            pages.forEach(function (p) { out.addPage(p); });
          });
        });
      }, Promise.resolve()).then(function () { return out.save(); }).then(function (bytes) {
        return { bytes: bytes, pages: out.getPageCount() };
      });
    }).then(function (res) {
      var finished = new Date();
      var blob = new Blob([res.bytes], { type: "application/pdf" });
      var outName = files[0].file.name.replace(/\.[^.]+$/, "") + "-merged.pdf";
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      blobUrl = URL.createObjectURL(blob);
      link.href = blobUrl;
      link.download = outName;
      linkText.textContent = "Download " + outName;
      resultName.textContent = outName;
      resultMeta.textContent = res.pages + " pages · " + size(blob.size) + " · merged in " + ((finished - started) / 1000).toFixed(1) + " seconds";
      receiptTimes.forEach(function (t) { t.textContent = clock(finished); t.setAttribute("datetime", finished.toISOString()); });
      show("done");
      link.focus();
    }).catch(function () {
      show("list");
      setStatus("Sorry, these PDFs couldn't be merged. One of them may be damaged.", true);
    });
  }

  input.addEventListener("change", function () { addFiles(input.files); input.value = ""; });
  ["dragenter", "dragover"].forEach(function (evt) {
    box.addEventListener(evt, function (e) {
      if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, "Files") > -1) {
        e.preventDefault(); drop.classList.add("over");
      }
    });
  });
  ["dragleave", "drop"].forEach(function (evt) {
    box.addEventListener(evt, function () { drop.classList.remove("over"); });
  });
  box.addEventListener("drop", function (e) {
    if (e.dataTransfer && e.dataTransfer.files.length) { e.preventDefault(); addFiles(e.dataTransfer.files); }
  });
  addBtn.addEventListener("click", function () { input.click(); });
  mergeBtn.addEventListener("click", merge);
  box.querySelector("[data-again]").addEventListener("click", function () {
    files = []; setStatus(""); show("pick"); input.focus();
  });
  if (window.GPHandoff) GPHandoff.take().then(function (f) { if (f && f.length) addFiles(f); });
})();
