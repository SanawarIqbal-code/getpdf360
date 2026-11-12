// GetPDF360 PDF to JPG: draws each page as an image in the browser. The file is never uploaded.
import * as pdfjsLib from "/static/vendor/pdf.min.js";
pdfjsLib.GlobalWorkerOptions.workerSrc = "/static/vendor/pdf.worker.min.js";

var MAX_PIXELS = 16000000; // keep each image under ~16 megapixels so phones don't run out of memory

GP.single({
  selector: "[data-pdf2jpg]",
  maxMB: 100,
  working: "Turning pages into images on your device…",
  onChange: function (cur, api) { api.box.querySelector("[data-range-row]").hidden = api.option("which") !== "some"; },
  onLoad: function (cur, api) { api.box.querySelector("[data-range-row]").hidden = api.option("which") !== "some"; },
  run: function (cur, api) {
    var dpi = api.option("quality") === "high" ? 300 : 150;
    var wanted = [];
    if (api.option("which") === "some") {
      var set;
      try { set = GP.pageSet(GP.parseRanges(api.box.querySelector("[data-ranges]").value, cur.pages)); }
      catch (e) { api.fail(e.message + "."); }
      for (var i = 0; i < cur.pages; i++) if (set[i]) wanted.push(i + 1);
    } else {
      for (var j = 1; j <= cur.pages; j++) wanted.push(j);
    }
    if (wanted.length > 1 && !window.JSZip) api.fail("Something didn't load. Refresh the page and try again.");

    var pad = String(cur.pages).length;
    // pdf.js takes ownership of the bytes it is given, so pass a copy
    var task = pdfjsLib.getDocument({ data: new Uint8Array(cur.bytes.slice(0)) });
    return task.promise.then(function (pdf) {
      var images = [];
      return wanted.reduce(function (chain, n, k) {
        return chain.then(function () {
          api.setWorking("Making image " + (k + 1) + " of " + wanted.length + " on your device…");
          return pdf.getPage(n).then(function (page) {
            var scale = dpi / 72;
            var vp = page.getViewport({ scale: scale });
            if (vp.width * vp.height > MAX_PIXELS) {
              scale = scale * Math.sqrt(MAX_PIXELS / (vp.width * vp.height));
              vp = page.getViewport({ scale: scale });
            }
            var canvas = document.createElement("canvas");
            canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
            var ctx = canvas.getContext("2d");
            ctx.fillStyle = "#FFFFFF";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            return page.render({ canvas: canvas, canvasContext: ctx, viewport: vp }).promise.then(function () {
              return new Promise(function (resolve) { canvas.toBlob(resolve, "image/jpeg", 0.9); });
            }).then(function (blob) {
              images.push({ n: n, blob: blob });
              canvas.width = canvas.height = 0;  // free memory
              page.cleanup();
            });
          });
        });
      }, Promise.resolve()).then(function () {
        task.destroy();
        if (images.length === 1) {
          return { blob: images[0].blob, name: cur.base + "-page-" + images[0].n + ".jpg", badge: "JPG", meta: "1 image" };
        }
        var zip = new JSZip();
        images.forEach(function (im) { zip.file(cur.base + "-page-" + String(im.n).padStart(pad, "0") + ".jpg", im.blob); });
        return zip.generateAsync({ type: "blob" }).then(function (blob) {
          return { blob: blob, name: cur.base + "-images.zip", badge: "ZIP", meta: images.length + " images in one zip file" };
        });
      });
    });
  }
});
