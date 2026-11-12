// GetPDF360 Rotate PDF: runs in the browser. The file is never uploaded.
GP.single({
  selector: "[data-rotate]",
  working: "Rotating on your device…",
  onChange: function (cur, api) {
    api.box.querySelector("[data-range-row]").hidden = api.option("which") !== "some";
  },
  onLoad: function (cur, api) {
    api.box.querySelector("[data-range-row]").hidden = api.option("which") !== "some";
  },
  run: function (cur, api) {
    var turn = parseInt(api.option("angle"), 10) || 90;
    var only = null;
    if (api.option("which") === "some") {
      try { only = GP.pageSet(GP.parseRanges(api.box.querySelector("[data-ranges]").value, cur.pages)); }
      catch (e) { api.fail(e.message + "."); }
    }
    return PDFLib.PDFDocument.load(cur.bytes).then(function (doc) {
      var count = 0;
      doc.getPages().forEach(function (page, i) {
        if (only && !only[i]) return;
        page.setRotation(PDFLib.degrees((page.getRotation().angle + turn) % 360));
        count++;
      });
      return doc.save().then(function (bytes) {
        return { blob: new Blob([bytes], { type: "application/pdf" }), name: cur.base + "-rotated.pdf",
                 meta: count + (count === 1 ? " page" : " pages") + " rotated" };
      });
    });
  }
});
