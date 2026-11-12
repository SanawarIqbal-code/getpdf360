// GetPDF360 converter: upload, convert, download, then confirm deletion.
(function () {
  var box = document.querySelector("[data-converter]");
  if (!box) return;

  var MAX = 20 * 1024 * 1024;
  var endpoint = box.dataset.endpoint;          // e.g. /word-to-pdf
  var accept = box.dataset.accept.split(",");    // e.g. .doc,.docx
  var outExt = box.dataset.out;                  // e.g. .pdf
  var outLabel = box.dataset.outLabel;           // e.g. PDF
  var inLabel = box.dataset.inLabel;             // e.g. Word
  var suffix = box.dataset.suffix || "";         // e.g. -compressed
  var verb = box.dataset.verb || "Converting";   // e.g. Compressing
  var showSaving = !!box.dataset.saving;         // show "2.1 MB → 640 KB"

  var input = box.querySelector("input[type=file]");
  var drop = box.querySelector(".drop");
  var views = {
    pick: box.querySelector("[data-view=pick]"),
    working: box.querySelector("[data-view=working]"),
    done: box.querySelector("[data-view=done]")
  };
  var statusBox = box.querySelector(".status");
  var workingText = box.querySelector("[data-working-text]");
  var link = box.querySelector(".download");
  var linkText = box.querySelector("[data-download-text]");
  var resultName = box.querySelector("[data-result-name]");
  var resultMeta = box.querySelector("[data-result-meta]");
  var steps = {
    up: box.querySelector("[data-step=up]"),
    back: box.querySelector("[data-step=back]"),
    gone: box.querySelector("[data-step=gone]")
  };
  var blobUrl = null;

  function show(name) {
    Object.keys(views).forEach(function (k) { views[k].hidden = k !== name; });
  }
  function setStatus(text, isError) {
    statusBox.textContent = text || "";
    statusBox.className = isError ? "status error" : "status";
  }
  function clock(d) {
    return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
  function size(bytes) {
    return bytes < 1048576 ? Math.max(1, Math.round(bytes / 1024)) + " KB" : (bytes / 1048576).toFixed(1) + " MB";
  }
  function markStep(el, when) {
    el.querySelector(".tick").classList.remove("wait");
    var t = el.querySelector("time");
    t.textContent = clock(when);
    t.setAttribute("datetime", when.toISOString());
  }
  function resetSteps() {
    Object.keys(steps).forEach(function (k) {
      steps[k].querySelector(".tick").classList.add("wait");
      steps[k].querySelector("time").textContent = "";
    });
    steps.gone.querySelector("[data-gone-text]").textContent = "Deleting both files from our server…";
  }

  function checkDeleted(jobId, tries) {
    fetch("/api/deleted/" + encodeURIComponent(jobId), { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.deleted) {
          steps.gone.querySelector("[data-gone-text]").textContent = "Both files deleted from our server";
          markStep(steps.gone, new Date());
        } else if (tries > 0) {
          setTimeout(function () { checkDeleted(jobId, tries - 1); }, 600);
        } else {
          steps.gone.querySelector("[data-gone-text]").textContent = "Files will be deleted within the hour";
        }
      })
      .catch(function () {
        steps.gone.querySelector("[data-gone-text]").textContent = "Files will be deleted within the hour";
      });
  }

  function convert(file) {
    if (!file) return;
    var lower = file.name.toLowerCase();
    if (!accept.some(function (ext) { return lower.endsWith(ext); })) {
      setStatus("This tool takes " + inLabel + " files (" + accept.join(", ") + "). Use the swap button for the other direction.", true);
      return;
    }
    if (file.size > MAX) {
      setStatus("This file is " + size(file.size) + ". The limit is 20 MB.", true);
      return;
    }

    setStatus("");
    resetSteps();
    workingText.textContent = verb + " " + file.name + "…";
    show("working");

    var started = new Date();
    var form = new FormData();
    form.append("file", file);
    var level = box.querySelector("input[name=level]:checked");
    if (level) form.append("level", level.value);

    fetch(endpoint, { method: "POST", body: form })
      .then(function (response) {
        if (!response.ok) {
          return response.json().catch(function () { return {}; }).then(function (data) {
            throw new Error(data.detail || "This file couldn't be converted. Try another file.");
          });
        }
        var jobId = response.headers.get("X-Job-Id");
        return response.blob().then(function (blob) { return { blob: blob, jobId: jobId }; });
      })
      .then(function (res) {
        var finished = new Date();
        var outName = file.name.replace(/\.[^.]+$/, "") + suffix + outExt;
        if (blobUrl) URL.revokeObjectURL(blobUrl);
        blobUrl = URL.createObjectURL(res.blob);
        link.href = blobUrl;
        link.download = outName;
        linkText.textContent = "Download " + outName;
        resultName.textContent = outName;
        var secs = ((finished - started) / 1000).toFixed(1) + " seconds";
        if (showSaving) {
          var saved = Math.round((1 - res.blob.size / file.size) * 100);
          resultMeta.textContent = saved > 0
            ? size(file.size) + " → " + size(res.blob.size) + " · " + saved + "% smaller"
            : "Already well compressed, so we kept your original (" + size(file.size) + ")";
        } else {
          resultMeta.textContent = size(res.blob.size) + " · converted in " + secs;
        }
        markStep(steps.up, started);
        markStep(steps.back, finished);
        show("done");
        link.focus();
        if (res.jobId) checkDeleted(res.jobId, 6);
      })
      .catch(function (err) {
        show("pick");
        setStatus(err.message, true);
      });
  }

  input.addEventListener("change", function () { convert(input.files[0]); input.value = ""; });
  ["dragenter", "dragover"].forEach(function (evt) {
    drop.addEventListener(evt, function (e) { e.preventDefault(); drop.classList.add("over"); });
  });
  ["dragleave", "drop"].forEach(function (evt) {
    drop.addEventListener(evt, function (e) { e.preventDefault(); drop.classList.remove("over"); });
  });
  drop.addEventListener("drop", function (e) { convert(e.dataTransfer.files[0]); });
  box.querySelector("[data-again]").addEventListener("click", function () {
    setStatus("");
    show("pick");
    input.focus();
  });
  if (window.GPHandoff) GPHandoff.take().then(function (f) { if (f && f.length) convert(f[0]); });
})();
