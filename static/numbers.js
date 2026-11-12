// GetPDF360 Add page numbers: runs in the browser. The file is never uploaded.
GP.single({
  selector: "[data-numbers]",
  working: "Adding page numbers on your device…",
  run: function (cur, api) {
    var position = api.option("position") || "bottom-center";
    var style = api.option("style") || "plain";
    var skipFirst = api.option("first") === "skip";
    return PDFLib.PDFDocument.load(cur.bytes).then(function (doc) {
      return doc.embedFont(PDFLib.StandardFonts.Helvetica).then(function (font) {
        var pages = doc.getPages(), total = pages.length, added = 0;
        pages.forEach(function (page, i) {
          if (skipFirst && i === 0) return;
          var text = style === "of" ? "Page " + (i + 1) + " of " + total : String(i + 1);
          // Work in the page as the reader sees it, even if the page is rotated
          var box = page.getCropBox ? page.getCropBox() : { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() };
          var rot = ((page.getRotation().angle % 360) + 360) % 360;
          var W = (rot === 90 || rot === 270) ? box.height : box.width;
          var H = (rot === 90 || rot === 270) ? box.width : box.height;
          var fontSize = Math.max(9, Math.min(12, W / 50));
          var tw = font.widthOfTextAtSize(text, fontSize), m = Math.max(24, W / 22);
          var vx = position === "bottom-center" ? (W - tw) / 2 : W - m - tw;
          var vy = position === "top-right" ? H - m : m - fontSize * 0.3;
          // Map the reader's view back to the page's own coordinates
          var x, y;
          if (rot === 0) { x = vx; y = vy; }
          else if (rot === 90) { x = box.width - vy; y = vx; }
          else if (rot === 180) { x = box.width - vx; y = box.height - vy; }
          else { x = vy; y = box.height - vx; }
          page.drawText(text, { x: box.x + x, y: box.y + y, size: fontSize, font: font,
                                color: PDFLib.rgb(0.22, 0.25, 0.35), rotate: PDFLib.degrees(rot) });
          added++;
        });
        return doc.save().then(function (bytes) {
          return { blob: new Blob([bytes], { type: "application/pdf" }), name: cur.base + "-numbered.pdf",
                   meta: added + (added === 1 ? " page" : " pages") + " numbered" };
        });
      });
    });
  }
});
