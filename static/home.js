// GetPDF360 home page: drop any file, see the tools that fit, open one with the file ready.
(function () {
  var box = document.querySelector("[data-smart]");
  if (!box) return;
  if (window.GPHandoff) GPHandoff.clear();

  var input = box.querySelector("input[type=file]");
  var drop = box.querySelector(".drop");
  var pick = box.querySelector("[data-view=pick]");
  var choose = box.querySelector("[data-view=choose]");
  var summary = box.querySelector("[data-summary]");
  var optionsEl = box.querySelector("[data-options]");
  var statusBox = box.querySelector(".status");
  var files = [];

  var TOOLS = {
    compress: ["/compress-pdf", "Compress PDF", "Make it smaller"],
    toword: ["/pdf-to-word", "PDF to Word", "Edit it in Word"],
    split: ["/split-pdf", "Split PDF", "Take out pages"],
    tojpg: ["/pdf-to-jpg", "PDF to JPG", "Save pages as images"],
    rotate: ["/rotate-pdf", "Rotate PDF", "Fix sideways pages"],
    numbers: ["/add-page-numbers", "Add page numbers", "Number the pages"],
    merge: ["/merge-pdf", "Merge PDF", "Join into one PDF"],
    word: ["/word-to-pdf", "Word to PDF", "Convert to PDF"],
    ppt: ["/powerpoint-to-pdf", "PowerPoint to PDF", "Convert to PDF"],
    excel: ["/excel-to-pdf", "Excel to PDF", "Convert to PDF"],
    images: ["/jpg-to-pdf", "JPG to PDF", "Make one PDF"]
  };

  function kind(name) {
    var ext = (name.split(".").pop() || "").toLowerCase();
    if (ext === "pdf") return "pdf";
    if (ext === "doc" || ext === "docx") return "word";
    if (ext === "ppt" || ext === "pptx" || ext === "odp") return "ppt";
    if (ext === "xls" || ext === "xlsx" || ext === "ods") return "excel";
    if (/^(jpe?g|png|webp|gif|bmp|heic|heif)$/.test(ext)) return "images";
    return null;
  }
  function size(bytes) {
    return bytes < 1048576 ? Math.max(1, Math.round(bytes / 1024)) + " KB" : (bytes / 1048576).toFixed(1) + " MB";
  }
  function setStatus(text) {
    statusBox.textContent = text || "";
    statusBox.className = text ? "status error" : "status";
  }

  function choicesFor(k, count) {
    if (k === "pdf") return count > 1 ? ["merge"] : ["compress", "toword", "split", "tojpg", "rotate", "numbers", "merge"];
    if (k === "word" || k === "ppt" || k === "excel") return count > 1 ? null : [k];
    if (k === "images") return ["images"];
    return null;
  }

  function handle(list) {
    files = Array.prototype.slice.call(list || []);
    if (!files.length) return;
    setStatus("");
    var kinds = files.map(function (f) { return kind(f.name); });
    if (kinds.indexOf(null) > -1) {
      setStatus("We can't work with that file type yet. Try a PDF, Word, PowerPoint, Excel or image file.");
      return;
    }
    var k = kinds[0];
    if (kinds.some(function (x) { return x !== k; })) {
      setStatus("Please choose files of one type, for example all PDFs or all photos.");
      return;
    }
    var choices = choicesFor(k, files.length);
    if (!choices) {
      setStatus("Please choose one file at a time for this type.");
      return;
    }
    var total = files.reduce(function (s, f) { return s + f.size; }, 0);
    summary.textContent = files.length === 1 ? files[0].name + " · " + size(total) : files.length + " files · " + size(total);

    optionsEl.innerHTML = "";
    choices.forEach(function (key, i) {
      var t = TOOLS[key];
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "smart-opt" + (i === 0 ? " first" : "");
      btn.innerHTML = "<strong></strong><span></span>";
      btn.querySelector("strong").textContent = t[1];
      btn.querySelector("span").textContent = key === "merge" && files.length === 1 ? "Add more PDFs next" : t[2];
      btn.addEventListener("click", function () { go(t[0]); });
      optionsEl.appendChild(btn);
    });
    pick.hidden = true;
    choose.hidden = false;
    var first = optionsEl.querySelector("button");
    if (first) first.focus();
  }

  function go(path) {
    var done = function () { location.href = path + "?from=home"; };
    if (!window.GPHandoff) { location.href = path; return; }
    GPHandoff.put(files).then(done).catch(function () { location.href = path; });
  }

  input.addEventListener("change", function () { handle(input.files); input.value = ""; });
  ["dragenter", "dragover"].forEach(function (evt) {
    drop.addEventListener(evt, function (e) { e.preventDefault(); drop.classList.add("over"); });
  });
  ["dragleave", "drop"].forEach(function (evt) {
    drop.addEventListener(evt, function (e) { e.preventDefault(); drop.classList.remove("over"); });
  });
  drop.addEventListener("drop", function (e) { handle(e.dataTransfer.files); });
  box.querySelector("[data-reset]").addEventListener("click", function () {
    files = []; setStatus(""); choose.hidden = true; pick.hidden = false; input.focus();
  });
})();
