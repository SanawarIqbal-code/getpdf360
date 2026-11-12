// GetPDF360 JPG to PDF: runs entirely in the browser. Photos are never uploaded.
(function () {
  var box = document.querySelector("[data-images]");
  if (!box || !window.PDFLib) return;

  var MAX_FILE = 30 * 1024 * 1024;   // 30 MB per image
  var MAX_FILES = 100;
  var MAX_SIDE = 2400;               // pixels; keeps the PDF a sensible size
  var A4 = [595.28, 841.89];         // points
  var OK = /\.(jpe?g|png|webp|gif|bmp|heic|heif)$/i;

  var input = box.querySelector("input[type=file]");
  var drop = box.querySelector(".drop");
  var listEl = box.querySelector("[data-list]");
  var countEl = box.querySelector("[data-count]");
  var goBtn = box.querySelector("[data-go]");
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

  var items = [];   // { file, url }
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
  function option(name) {
    var el = box.querySelector("input[name=" + name + "]:checked");
    return el ? el.value : "";
  }

  function addFiles(fileList) {
    var problems = [];
    Array.prototype.forEach.call(fileList || [], function (file) {
      if (!OK.test(file.name) && !/^image\//.test(file.type)) { problems.push(file.name + " is not an image"); return; }
      if (file.size > MAX_FILE) { problems.push(file.name + " is over 30 MB"); return; }
      if (items.length >= MAX_FILES) { problems.push("You can add up to " + MAX_FILES + " images"); return; }
      items.push({ file: file, url: URL.createObjectURL(file) });
    });
    setStatus(problems.length ? problems.join(". ") + "." : "", problems.length > 0);
    render();
  }

  function move(from, to) {
    if (to < 0 || to >= items.length || from === to) return;
    items.splice(to, 0, items.splice(from, 1)[0]);
    render();
  }
  function removeAt(i) {
    URL.revokeObjectURL(items[i].url);
    items.splice(i, 1);
    render();
  }

  function render() {
    if (!items.length) { show("pick"); return; }
    show("list");
    listEl.innerHTML = "";
    items.forEach(function (it, i) {
      var li = document.createElement("li");
      li.className = "merge-item";
      li.draggable = true;
      li.innerHTML =
        '<span class="merge-num">' + (i + 1) + '</span>' +
        '<img class="thumb" alt="">' +
        '<span class="merge-info"><span class="merge-name"></span><span class="merge-meta"></span></span>' +
        '<span class="merge-actions">' +
        '<button type="button" data-up aria-label="Move up">↑</button>' +
        '<button type="button" data-down aria-label="Move down">↓</button>' +
        '<button type="button" data-remove aria-label="Remove">✕</button></span>';
      li.querySelector(".thumb").src = it.url;
      li.querySelector(".merge-name").textContent = it.file.name;
      li.querySelector(".merge-meta").textContent = size(it.file.size);
      li.querySelector("[data-up]").disabled = i === 0;
      li.querySelector("[data-down]").disabled = i === items.length - 1;
      li.querySelector("[data-up]").addEventListener("click", function () { move(i, i - 1); });
      li.querySelector("[data-down]").addEventListener("click", function () { move(i, i + 1); });
      li.querySelector("[data-remove]").addEventListener("click", function () { removeAt(i); });
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
    var total = items.reduce(function (s, it) { return s + it.file.size; }, 0);
    countEl.textContent = items.length + (items.length === 1 ? " image" : " images") + " · " + size(total);
    goBtn.textContent = "Convert " + items.length + (items.length === 1 ? " image" : " images") + " to PDF";
  }

  // Draw the photo upright (honours the phone's rotation tag), shrink if huge, return JPEG bytes
  function toJpeg(file) {
    var decode = window.createImageBitmap
      ? createImageBitmap(file, { imageOrientation: "from-image" }).catch(function () { return createImageBitmap(file); })
      : Promise.reject(new Error("unsupported"));
    return decode.then(function (bmp) {
      var scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
      var w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
      var canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      var ctx = canvas.getContext("2d");
      ctx.fillStyle = "#FFFFFF";            // transparent PNGs get a white background
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(bmp, 0, 0, w, h);
      if (bmp.close) bmp.close();
      return new Promise(function (resolve, reject) {
        canvas.toBlob(function (blob) {
          if (!blob) return reject(new Error("encode"));
          blob.arrayBuffer().then(function (buf) { resolve({ bytes: buf, w: w, h: h }); });
        }, "image/jpeg", 0.9);
      });
    });
  }

  function convert() {
    if (!items.length) return;
    setStatus("");
    var pageSize = option("pagesize") || "a4";
    var margin = option("margin") === "small" ? 28 : 0;  // 28pt is about 1 cm
    var started = new Date();
    var failed = [];
    show("working");

    PDFLib.PDFDocument.create().then(function (doc) {
      return items.reduce(function (chain, it, i) {
        return chain.then(function () {
          workingText.textContent = "Adding image " + (i + 1) + " of " + items.length + " on your device…";
          return toJpeg(it.file).then(function (img) {
            return doc.embedJpg(img.bytes).then(function (jpg) {
              var pw, ph;
              if (pageSize === "fit") {
                pw = img.w * 0.75 + margin * 2; ph = img.h * 0.75 + margin * 2;   // 96 dpi in points
              } else {
                var landscape = img.w > img.h;
                pw = landscape ? A4[1] : A4[0]; ph = landscape ? A4[0] : A4[1];
              }
              var page = doc.addPage([pw, ph]);
              var maxW = pw - margin * 2, maxH = ph - margin * 2;
              var s = Math.min(maxW / img.w, maxH / img.h);
              var dw = img.w * s, dh = img.h * s;
              page.drawImage(jpg, { x: (pw - dw) / 2, y: (ph - dh) / 2, width: dw, height: dh });
            });
          }).catch(function () { failed.push(it.file.name); });
        });
      }, Promise.resolve()).then(function () {
        if (!doc.getPageCount()) throw new Error("none");
        return doc.save();
      }).then(function (bytes) {
        var finished = new Date();
        var blob = new Blob([bytes], { type: "application/pdf" });
        var name = items.length === 1 ? items[0].file.name.replace(/\.[^.]+$/, "") + ".pdf" : "images.pdf";
        if (blobUrl) URL.revokeObjectURL(blobUrl);
        blobUrl = URL.createObjectURL(blob);
        link.href = blobUrl;
        link.download = name;
        linkText.textContent = "Download " + name;
        resultName.textContent = name;
        resultMeta.textContent = doc.getPageCount() + (doc.getPageCount() === 1 ? " page" : " pages") + " · " + size(blob.size) +
          " · made in " + ((finished - started) / 1000).toFixed(1) + " seconds";
        receiptTimes.forEach(function (t) { t.textContent = clock(finished); t.setAttribute("datetime", finished.toISOString()); });
        show("done");
        link.focus();
        if (failed.length) setStatus("Skipped " + failed.join(", ") + ": this browser can't open that image type. Try saving it as JPG first.", true);
      });
    }).catch(function () {
      show("list");
      setStatus(failed.length
        ? "These images couldn't be opened. HEIC photos from iPhone may need saving as JPG first."
        : "Sorry, these images couldn't be converted.", true);
    });
  }

  input.addEventListener("change", function () { addFiles(input.files); input.value = ""; });
  ["dragenter", "dragover"].forEach(function (evt) {
    box.addEventListener(evt, function (e) {
      if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, "Files") > -1) { e.preventDefault(); drop.classList.add("over"); }
    });
  });
  ["dragleave", "drop"].forEach(function (evt) {
    box.addEventListener(evt, function () { drop.classList.remove("over"); });
  });
  box.addEventListener("drop", function (e) {
    if (e.dataTransfer && e.dataTransfer.files.length) { e.preventDefault(); addFiles(e.dataTransfer.files); }
  });
  addBtn.addEventListener("click", function () { input.click(); });
  goBtn.addEventListener("click", convert);
  box.querySelector("[data-again]").addEventListener("click", function () {
    items.forEach(function (it) { URL.revokeObjectURL(it.url); });
    items = []; setStatus(""); show("pick"); input.focus();
  });
})();
