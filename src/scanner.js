  // ---------------- Device Setup: Barcode / Inventory Reader ----------------
  // One physical device, used for both POS product search and Stocktake
  // counting — not two device types, and not a persistent connection like
  // the printer/drawer. It's a USB or Bluetooth-HID keyboard wedge: it
  // types the scanned code into whatever input already has focus, exactly
  // like a keyboard, so there's no pairing/connection object to manage here.
  // POS search (#searchInput, src/pos.js) and Stocktake counting
  // (#stCountSearch, src/stocktake.js) already accept scanner input as
  // plain keystrokes with no focus loss — confirmed by the rendering audit
  // — so this screen only has to prove the physical device itself works,
  // via its own plain text input, never new capture logic.
  function barcodeReaderSectionHtml(){
    return `
      <div class="card">
        <h3>Barcode / Inventory Reader</h3>
        <p class="muted">The same scanner used for Sell-screen search and Stocktake counting — one device, one setup screen.</p>
        <button class="btn btn-outline" id="openScannerSetup">📷 Barcode reader setup</button>
      </div>`;
  }
  function wireBarcodeReaderSection(){
    document.getElementById("openScannerSetup").onclick = ()=> openBarcodeReaderSetupModal();
  }
  function openBarcodeReaderSetupModal(){
    const wrap = openModal("Barcode / Inventory Reader setup", `
      <p class="muted" style="margin-top:0">This works as a keyboard-wedge device — USB or Bluetooth (HID) — so there's nothing to pair here. Once it's plugged in or paired at the OS level, it types the scanned code into whatever field has focus, exactly like a keyboard. It's the same device used for product search on the Sell screen and for counting during a Stocktake.</p>
      <label>Scan here to test</label>
      <input class="field" id="scanTestInput" placeholder="Tap here, then scan a barcode" autocomplete="off">
      <div id="scanTestResult" style="margin-top:10px"></div>
    `);
    const input = wrap.querySelector("#scanTestInput");
    const result = wrap.querySelector("#scanTestResult");
    input.oninput = (e)=>{
      const v = e.target.value;
      result.innerHTML = v.trim()===""? "" :
        `<div class="box" style="border:1px solid var(--success,#2E7D32);color:var(--success,#2E7D32);padding:8px 10px;border-radius:8px">✅ Captured: <b>${escapeHtml(v)}</b></div>`;
    };
    input.focus();
  }
