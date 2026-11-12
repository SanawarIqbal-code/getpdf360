// GetPDF360 handoff: carries files dropped on the home page to the chosen tool.
// Files are kept only in this browser (IndexedDB) and removed as soon as the tool picks them up.
window.GPHandoff = (function () {
  var DB = "gp-handoff", STORE = "files", KEY = "pending", MAX_AGE = 10 * 60 * 1000;

  function open() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) return reject(new Error("no indexedDB"));
      var req = indexedDB.open(DB, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(STORE); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function put(files) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put({ files: Array.prototype.slice.call(files), t: Date.now() }, KEY);
        tx.oncomplete = function () { db.close(); resolve(); };
        tx.onerror = function () { db.close(); reject(tx.error); };
      });
    });
  }

  // Returns the files (and deletes them) only when the page was opened from the home page
  function take() {
    if (!/[?&]from=home\b/.test(location.search)) return Promise.resolve(null);
    try { history.replaceState(null, "", location.pathname + location.hash); } catch (e) {}
    return open().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction(STORE, "readwrite"), store = tx.objectStore(STORE), value = null;
        var get = store.get(KEY);
        get.onsuccess = function () { value = get.result; store.delete(KEY); };
        tx.oncomplete = function () {
          db.close();
          resolve(value && value.files && Date.now() - value.t < MAX_AGE ? value.files : null);
        };
        tx.onerror = function () { db.close(); resolve(null); };
      });
    }).catch(function () { return null; });
  }

  // Remove anything left over (for example if the visitor went back instead of continuing)
  function clear() {
    return open().then(function (db) {
      var tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = function () { db.close(); };
    }).catch(function () {});
  }

  return { put: put, take: take, clear: clear };
})();
