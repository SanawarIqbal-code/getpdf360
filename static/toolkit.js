// GetPDF360 toolkit: shared upload → options → result flow for tools that run in the browser.
window.GP = (function () {
  function size(bytes) {
    return bytes < 1048576 ? Math.max(1, Math.round(bytes / 1024)) + " KB" : (bytes / 1048576).toFixed(1) + " MB";
  }
  function clock(d) {
    return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  // "1-3, 5" -> [[1,3],[5,5]]; throws a friendly message if invalid
  function parseRanges(text, max) {
    var parts = String(text || "").split(",").map(function (p) { return p.trim(); }).filter(Boolean);
    if (!parts.length) throw new Error("Type the pages you want, for example 1-3, 5");
    return parts.map(function (p) {
      var m = p.match(/^(\d+)\s*(?:-\s*(\d+))?$/);
      if (!m) throw new Error("\"" + p + "\" isn't a page number or range. Use numbers like 2 or 4-7");
      var a = parseInt(m[1], 10), b = m[2] ? parseInt(m[2], 10) : a;
      if (a < 1 || b < 1 || a > max || b > max) throw new Error("This PDF has " + max + " pages. \"" + p + "\" is outside that");
      return a <= b ? [a, b] : [b, a];
    });
  }
  // Set of 0-based page indexes from ranges
  function pageSet(ranges) {
    var set = {};
    ranges.forEach(function (r) { for (var i = r[0] - 1; i < r[1]; i++) set[i] = true; });
    return set;
  }

  // One PDF in, one result out. opts.run(ctx) must return {blob, name, badge, meta}.
  function single(opts) {
    var box = document.querySelector(opts.selector);
    if (!box || !window.PDFLib) return;
    var maxBytes = (opts.maxMB || 100) * 1048576;
    var q = function (s) { return box.querySelector(s); };
    var input = q("input[type=file]"), drop = q(".drop"), statusBox = q(".status");
    var goBtn = q("[data-go]"), workingText = q("[data-working-text]");
    var link = q("a.download"), linkText = q("[data-download-text]");
    var views = {
      pick: q("[data-view=pick]"), options: q("[data-view=options]"),
      working: q("[data-view=working]"), done: q("[data-view=done]")
    };
    var current = null, blobUrl = null;

    function show(name) { Object.keys(views).forEach(function (k) { views[k].hidden = k !== name; }); }
    function setStatus(text, isError) {
      statusBox.textContent = text || "";
      statusBox.className = isError ? "status error" : "status";
    }
    function option(name) {
      var el = box.querySelector("input[name=" + name + "]:checked");
      return el ? el.value : "";
    }

    function load(file) {
      if (!file) return;
      setStatus("");
      if (!file.name.toLowerCase().endsWith(".pdf")) { setStatus("Please choose a PDF file.", true); return; }
      if (file.size > maxBytes) { setStatus("This file is " + size(file.size) + ". The limit is " + (opts.maxMB || 100) + " MB.", true); return; }
      file.arrayBuffer().then(function (buf) {
        return PDFLib.PDFDocument.load(buf).then(function (doc) {
          current = { file: file, bytes: buf, pages: doc.getPageCount(), base: file.name.replace(/\.[^.]+$/, "") };
          q("[data-file-name]").textContent = file.name;
          q("[data-file-meta]").textContent = current.pages + (current.pages === 1 ? " page" : " pages") + " · " + size(file.size);
          if (opts.onLoad) opts.onLoad(current, api);
          show("options");
        });
      }).catch(function (err) {
        var locked = err && /encrypt/i.test(err.message || "");
        setStatus(locked ? "This PDF is password-protected. Remove the password first." : "This PDF couldn't be read. It may be damaged.", true);
      });
    }

    function run() {
      if (!current) return;
      setStatus("");
      var started = new Date();
      workingText.textContent = opts.working || "Working on your device…";
      show("working");
      Promise.resolve().then(function () { return opts.run(current, api); }).then(function (res) {
        var finished = new Date();
        if (blobUrl) URL.revokeObjectURL(blobUrl);
        blobUrl = URL.createObjectURL(res.blob);
        link.href = blobUrl;
        link.download = res.name;
        linkText.textContent = "Download " + res.name;
        q("[data-result-name]").textContent = res.name;
        q(".result-badge").textContent = res.badge || "PDF";
        q("[data-result-meta]").textContent = res.meta + " · " + size(res.blob.size) + " · done in " + ((finished - started) / 1000).toFixed(1) + " seconds";
        box.querySelectorAll("[data-receipt] time").forEach(function (t) { t.textContent = clock(finished); t.setAttribute("datetime", finished.toISOString()); });
        show("done");
        link.focus();
      }).catch(function (err) {
        if (window.console) console.error(err);
        show("options");
        setStatus(err && err.friendly ? err.message : "Sorry, something went wrong with this PDF. It may be damaged.", true);
      });
    }

    // Errors the user should see as written (e.g. a bad page range)
    function fail(message) { var e = new Error(message); e.friendly = true; throw e; }

    var api = { option: option, setStatus: setStatus, fail: fail, setWorking: function (t) { workingText.textContent = t; }, box: box };

    input.addEventListener("change", function () { load(input.files[0]); input.value = ""; });
    ["dragenter", "dragover"].forEach(function (evt) {
      drop.addEventListener(evt, function (e) { e.preventDefault(); drop.classList.add("over"); });
    });
    ["dragleave", "drop"].forEach(function (evt) {
      drop.addEventListener(evt, function (e) { e.preventDefault(); drop.classList.remove("over"); });
    });
    drop.addEventListener("drop", function (e) { load(e.dataTransfer.files[0]); });
    goBtn.addEventListener("click", run);
    box.querySelectorAll("input[type=radio]").forEach(function (r) {
      r.addEventListener("change", function () { if (opts.onChange) opts.onChange(current, api); });
    });
    var rangeInput = q("[data-ranges]");
    if (rangeInput) rangeInput.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); run(); } });
    q("[data-change]").addEventListener("click", function () { current = null; setStatus(""); show("pick"); input.focus(); });
    q("[data-again]").addEventListener("click", function () { setStatus(""); show(current ? "options" : "pick"); });
    if (window.GPHandoff) GPHandoff.take().then(function (f) { if (f && f.length) load(f[0]); });
    return api;
  }

  return { size: size, parseRanges: parseRanges, pageSet: pageSet, single: single };
})();
