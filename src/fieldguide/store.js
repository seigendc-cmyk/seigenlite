  // ================== RPN Field Guide — on-device storage (IndexedDB) ==================
  // Everything the Field Guide keeps lives in one IndexedDB database on the
  // phone. Nothing here talks to a server.
  //
  //   profiles  {id, name, created}             one row per learner on this phone
  //   progress  {profileId, ...}                one row per learner (coach-engine.js
  //                                             newProgress() has the shape)
  //   meta      {key, value}                    e.g. activeProfileId, consoleSession
  //   notes     {id, rpnId, fields, status, …}  onboarding notes and their sending
  //                                             state (outbox.js); version 2
  //
  // Keeping each learner's progress in its own row is what keeps profiles
  // apart: switching loads exactly one row, and nothing reads across rows.
  //
  // If IndexedDB can't be opened (some private windows, blocked site data)
  // the same calls work on an in-memory copy instead, and storeMode says
  // "memory" so the app can warn that progress won't be kept.
  const STORE_DB_NAME = "rpn-field-guide";
  const STORE_DB_VERSION = 2; // 2: + notes (Phase 4). Upgrading only adds stores.
  const STORE_NAMES = { profiles: "id", progress: "profileId", meta: "key", notes: "id" };
  let storeMode = "idb"; // "idb" | "memory"
  let storeDb = null;
  let storeReady = null; // one open, shared by everything that calls storeInit()
  const storeMemory = { profiles: new Map(), progress: new Map(), meta: new Map(), notes: new Map() };

  function storeOpen() {
    return new Promise((resolve, reject) => {
      let req;
      try {
        req = indexedDB.open(STORE_DB_NAME, STORE_DB_VERSION);
      } catch (e) {
        reject(e);
        return;
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of Object.keys(STORE_NAMES)) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: STORE_NAMES[name] });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("IndexedDB blocked"));
    });
  }

  function storeInit() {
    if (!storeReady) {
      storeReady = (async () => {
        try {
          if (typeof indexedDB === "undefined") throw new Error("no IndexedDB");
          storeDb = await storeOpen();
          storeMode = "idb";
        } catch (e) {
          storeDb = null;
          storeMode = "memory";
        }
        return storeMode;
      })();
    }
    return storeReady;
  }

  function storeRequest(name, mode, makeRequest) {
    return new Promise((resolve, reject) => {
      const tx = storeDb.transaction(name, mode);
      const req = makeRequest(tx.objectStore(name));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  // Values are copied on the way in and out, in both modes, so a caller
  // changing an object it got back can never change what's stored.
  const storeCopy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

  async function storeGetAll(name) {
    if (storeMode === "memory") return [...storeMemory[name].values()].map(storeCopy);
    return storeRequest(name, "readonly", (s) => s.getAll());
  }
  async function storeGet(name, key) {
    if (storeMode === "memory") return storeCopy(storeMemory[name].get(key));
    return storeRequest(name, "readonly", (s) => s.get(key));
  }
  async function storePut(name, value) {
    const v = storeCopy(value);
    if (storeMode === "memory") {
      storeMemory[name].set(v[STORE_NAMES[name]], v);
      return;
    }
    await storeRequest(name, "readwrite", (s) => s.put(v));
  }
  async function storeDelete(name, key) {
    if (storeMode === "memory") {
      storeMemory[name].delete(key);
      return;
    }
    await storeRequest(name, "readwrite", (s) => s.delete(key));
  }
