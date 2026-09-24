  // ---------------- Device Setup: Cash Drawer (Web Serial) ----------------
  // Deliberately independent of printing.js: a kick drawer is its own
  // USB/serial device with its own connection object (window._drawer) and
  // its own explicit "open" action. NEVER wired into the printer's
  // connection object or triggered as a side effect of printing — no RJ11
  // kick-pulse-via-printer passthrough here. openCashDrawer() below is the
  // only thing that opens the drawer, and nothing in printing.js calls it.
  //
  // Connection type: Web Serial (navigator.serial) — same zero-native-
  // plugin approach printing.js already uses for WebUSB/WebBluetooth (see
  // its comments): this app has never routed peripheral access through a
  // Tauri Rust bridge, relying instead on the OS webview's own Chromium
  // engine exposing these Web APIs directly. Falls back to a clear
  // "not supported" message wherever navigator.serial doesn't exist,
  // without blocking anything else on the Settings screen from rendering.
  function hasSerialPort(){ return !!(navigator.serial); }
  // Standard ESC/POS drawer-kick pulse (ESC p m t1 t2) — what generic
  // USB/serial kick interfaces for RJ11 cash drawers almost universally
  // expect, even when the interface itself isn't a receipt printer.
  const DRAWER_KICK_BYTES = new Uint8Array([0x1B,0x70,0x00,0x19,0xFA]);

  async function connectCashDrawer(){
    if(!hasSerialPort()){ alert("Serial port access isn't available in this browser/build. Use Chrome or the desktop app, served via a local server (not a plain file)."); return false; }
    try{
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate: 9600 });
      window._drawer = { port };
      setSetting("drawer_connection_type","serial"); persist();
      return true;
    }catch(e){
      if(e && e.name!=="NotFoundError") alert("Couldn't connect to the cash drawer: "+(e.message||e));
      return false;
    }
  }
  // Silent reconnect: navigator.serial.getPorts() only ever returns ports
  // this origin was already granted (no chooser, no new user gesture) —
  // same "reconnect on drop" pattern as printing.js's USB/Bluetooth helpers.
  async function reconnectCashDrawerSilently(){
    if(!hasSerialPort()) return false;
    try{
      const ports = await navigator.serial.getPorts();
      if(ports.length===0) return false;
      const port = ports[0];
      if(!port.writable) await port.open({ baudRate: 9600 });
      window._drawer = { port };
      return true;
    }catch(e){ return false; }
  }
  function drawerConnected(){ return !!(window._drawer && window._drawer.port && window._drawer.port.writable); }
  function drawerStatusHtml(){
    if(!hasSerialPort()) return "Not supported in this build — Web Serial needs Chrome/Edge or the desktop app, served via a local server (not a plain file).";
    return drawerConnected()? "Connected." : "Not connected.";
  }
  // The explicit, standalone "open drawer" action — Step 4's own device
  // entry, never called from printReceipt/printEOD/printSaleCopy/etc.
  async function openCashDrawer(){
    if(!drawerConnected() && !(await reconnectCashDrawerSilently())){
      alert("No cash drawer connected. Open Settings → Cash Drawer to connect one.");
      return false;
    }
    try{
      const writer = window._drawer.port.writable.getWriter();
      await writer.write(DRAWER_KICK_BYTES);
      writer.releaseLock();
      return true;
    }catch(e){
      alert("Couldn't open the cash drawer — check the connection and try again: "+(e.message||e));
      window._drawer = null;
      return false;
    }
  }
  function cashDrawerSectionHtml(){
    return `
      <div class="card">
        <h3>Cash Drawer</h3>
        <p class="muted">A standalone USB/serial kick drawer — separate from the receipt printer. Opening it is always an explicit action, never automatic when a receipt prints.</p>
        <button class="btn btn-outline" id="openDrawerSetup">🗃️ Cash drawer setup</button>
      </div>`;
  }
  function wireCashDrawerSection(){
    document.getElementById("openDrawerSetup").onclick = ()=> openCashDrawerSetupModal();
  }
  function cashDrawerSetupBodyHtml(){
    return `
      <div id="drawerStatusArea" class="box">${drawerStatusHtml()}</div>
      ${hasSerialPort()? `<button class="btn btn-outline" id="dsConnect" style="margin-top:10px">🔌 Connect drawer</button>` : ""}
      <button class="btn btn-primary" id="dsTestOpen" style="margin-top:10px" ${hasSerialPort()? "" : "disabled"}>🗃️ Test open drawer</button>
    `;
  }
  function openCashDrawerSetupModal(){
    const wrap = openModal("Cash Drawer setup", cashDrawerSetupBodyHtml());
    const statusArea = wrap.querySelector("#drawerStatusArea");
    const refresh = ()=>{ statusArea.textContent = drawerStatusHtml(); };
    const connectBtn = wrap.querySelector("#dsConnect");
    if(connectBtn) connectBtn.onclick = async ()=>{ await connectCashDrawer(); refresh(); };
    wrap.querySelector("#dsTestOpen").onclick = async ()=>{ await openCashDrawer(); refresh(); };
  }
