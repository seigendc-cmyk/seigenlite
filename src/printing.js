  function paperWidth(){ return parseFloat(getSetting("paper_width","58")) || 58; }
  // Estimated character columns for a given paper width in mm, now that
  // every print job forces condensed Font B (0.75 replaces the old 0.6
  // used for the default wider font). Still just an estimate — the "Print
  // test line" tool in Settings is the real calibration step.
  function paperColumns(mm){ return Math.max(16, Math.round(mm * 0.75)); }

  // ---------------- USB (WebUSB) thermal printing ----------------
  // Works only in Chrome/Edge (desktop or Android with an OTG-connected
  // printer), and only when served via http(s)/localhost — never from a
  // plain double-clicked file. Talks directly to the printer over USB
  // using raw ESC/POS commands, so no OS print driver is needed.
  function hasUSBPrint(){ return !!(navigator.usb); }
  function escposColWidth(){ return paperColumns(paperWidth()); }
  function concatBytes(arrays){
    const total = arrays.reduce((s,a)=>s+a.length,0);
    const out = new Uint8Array(total);
    let offset=0;
    arrays.forEach(a=>{ out.set(a,offset); offset+=a.length; });
    return out;
  }
  function escposTextBytes(str){ return new TextEncoder().encode(str); }
  const ESC=0x1B, GS=0x1D;
  const escposInit = ()=> new Uint8Array([ESC,0x40]);
  const escposBold = on => new Uint8Array([ESC,0x45,on?1:0]);
  const escposAlign = a => new Uint8Array([ESC,0x61, a==="center"?1:a==="right"?2:0]);
  const escposCut = ()=> new Uint8Array([0x0A,0x0A,0x0A,GS,0x56,0x00]);
  const escposLine = (width)=> escposTextBytes("-".repeat(width)+"\n");
  // Forced at the start of every print job (right after escposInit()) so
  // lines stop wrapping regardless of whatever font/width state the
  // printer powered on in: condensed Font B fits more characters per mm
  // than the default Font A, and the explicit 1x1 size reset undoes any
  // double-width/double-height mode that might still be active.
  const escposFontB = ()=> new Uint8Array([ESC, 0x4D, 0x01]); // ESC M 1 — condensed Font B
  const escposNormalSize = ()=> new Uint8Array([GS, 0x21, 0x00]); // GS ! 0x00 — 1x1 character size

  async function connectUSBPrinter(){
    if(!hasUSBPrint()){ alert("USB printing isn't available in this browser. Use Chrome, with the app served via a local server (not opened as a plain file)."); return false; }
    try{
      const device = await navigator.usb.requestDevice({ filters: [] });
      await device.open();
      if(device.configuration===null) await device.selectConfiguration(1);
      let interfaceNumber, endpointNumber;
      for(const iface of device.configuration.interfaces){
        for(const alt of iface.alternates){
          const outEp = alt.endpoints.find(e=>e.direction==="out");
          if(outEp){ interfaceNumber=iface.interfaceNumber; endpointNumber=outEp.endpointNumber; break; }
        }
        if(interfaceNumber!==undefined) break;
      }
      if(endpointNumber===undefined){ alert("That USB device doesn't look like a printer (no usable data channel found)."); return false; }
      await device.claimInterface(interfaceNumber);
      window._usbPrinter = {device, endpointNumber};
      return true;
    }catch(e){
      if(e && e.name!=="NotFoundError") alert("Couldn't connect to a USB printer: "+(e.message||e));
      return false;
    }
  }
  async function usbPrintBytes(bytes){
    if(!window._usbPrinter){ const ok = await connectUSBPrinter(); if(!ok) return false; }
    try{
      await window._usbPrinter.device.transferOut(window._usbPrinter.endpointNumber, bytes);
      return true;
    }catch(e){
      alert("USB print failed — check the printer is still connected and try again: "+(e.message||e));
      window._usbPrinter = null;
      return false;
    }
  }
  function usbPrintButtonHtml(id){
    return hasUSBPrint()? `<button class="btn btn-outline" id="${id}" style="flex:none;width:auto;padding:12px">🔌</button>` : "";
  }

  // ---------------- Bluetooth (Web Bluetooth/BLE) ESC/POS printing ----------------
  // Parallel to the USB path above, same escpos* byte builders, just a
  // different transport underneath. Many cheap BLE thermal printers expose
  // a plain "serial over BLE" characteristic under one of a couple of very
  // common vendor UUIDs — since we can't know the exact printer's service
  // ahead of time, we declare both as optionalServices (GATT requires the
  // service UUID to be pre-declared to access it after connecting) and
  // discover the actual writable characteristic at connect time instead of
  // assuming one.
  const BT_SERIAL_SERVICE_UUIDS = [
    "49535343-fe7d-4ae5-8fa9-9fafd205e455", // ISSC/Microchip transparent UART
    "6e400001-b5a3-f393-e0a9-e50e24dcca9e", // Nordic UART Service
  ];
  function hasBTPrint(){ return !!(navigator.bluetooth); }
  async function connectBTPrinter(){
    if(!hasBTPrint()){ alert("Bluetooth printing isn't available in this browser. Use Chrome, with the app served via a local server (not opened as a plain file)."); return false; }
    try{
      const device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: BT_SERIAL_SERVICE_UUIDS
      });
      const server = await device.gatt.connect();
      const services = await server.getPrimaryServices();
      let writable = null;
      for(const service of services){
        const chars = await service.getCharacteristics();
        writable = chars.find(c=> c.properties.write || c.properties.writeWithoutResponse);
        if(writable) break;
      }
      if(!writable){
        alert("Connected, but couldn't find a way to send data to it — this printer's Bluetooth mode may not be compatible with this app.");
        return false;
      }
      window._btPrinter = {device, characteristic: writable};
      return true;
    }catch(e){
      if(e && e.name!=="NotFoundError") alert("Couldn't connect to a Bluetooth printer: "+(e.message||e));
      return false;
    }
  }
  async function btPrintBytes(bytes){
    if(!window._btPrinter){ const ok = await connectBTPrinter(); if(!ok) return false; }
    try{
      const ch = window._btPrinter.characteristic;
      const canWriteWithResponse = !!ch.properties.write;
      const CHUNK = 20; // GATT writes are typically capped around 20 bytes without a negotiated MTU
      for(let i=0;i<bytes.length;i+=CHUNK){
        const chunk = bytes.slice(i, i+CHUNK);
        if(canWriteWithResponse) await ch.writeValueWithResponse(chunk);
        else await ch.writeValueWithoutResponse(chunk);
      }
      return true;
    }catch(e){
      alert("Bluetooth print failed — check the printer is still connected and try again: "+(e.message||e));
      window._btPrinter = null;
      return false;
    }
  }

  // Sends straight to whichever direct printer is already connected, with
  // no OS dialog. Bluetooth wins if both happen to be connected at once —
  // an arbitrary but reasonable tie-break, not meant to be configurable.
  // Returns false when nothing is connected, so callers can fall back to
  // the normal #printArea/printNow() dialog path.
  async function sendDirect(bytes){
    if(window._btPrinter){ await btPrintBytes(bytes); return true; }
    if(window._usbPrinter){ await usbPrintBytes(bytes); return true; }
    return false;
  }

  // Byte-building is shared between USB and Bluetooth — only the transport
  // call at the end differs, so each format is built once here.
  function buildReceiptBytes(saleId, ts, subtotal, discount, markup, voucherAmount, total, method, items){
    const w = escposColWidth();
    const shop = getSetting("shop_name","My Shop");
    const branch = getSetting("branch_name","");
    const parts = [ escposInit(), escposFontB(), escposNormalSize(), escposAlign("center"), escposBold(true),
      escposTextBytes(shop+"\n"), escposBold(false) ];
    if(branch) parts.push(escposTextBytes(branch+"\n"));
    parts.push(escposAlign("left"), escposLine(w));
    parts.push(escposTextBytes(new Date(ts).toLocaleString()+"\n"));
    parts.push(escposTextBytes("Receipt #"+saleId+"\n"));
    parts.push(escposLine(w));
    items.forEach(i=> parts.push(escposTextBytes(padLine(`${i.qty} x ${i.name}`, `${currency}${(i.price*i.qty).toFixed(2)}`, w)+"\n")));
    parts.push(escposLine(w));
    parts.push(escposTextBytes(padLine("Subtotal", `${currency}${subtotal.toFixed(2)}`, w)+"\n"));
    if(discount>0) parts.push(escposTextBytes(padLine("Discount", `-${currency}${discount.toFixed(2)}`, w)+"\n"));
    if(markup>0) parts.push(escposTextBytes(padLine("Markup", `+${currency}${markup.toFixed(2)}`, w)+"\n"));
    if(voucherAmount>0) parts.push(escposTextBytes(padLine("Voucher", `-${currency}${voucherAmount.toFixed(2)}`, w)+"\n"));
    parts.push(escposBold(true), escposTextBytes(padLine("TOTAL", `${currency}${total.toFixed(2)}`, w)+"\n"), escposBold(false));
    parts.push(escposTextBytes("Payment: "+method+"\n"));
    parts.push(escposLine(w));
    parts.push(escposAlign("center"), escposTextBytes("Thank you for your business\n"));
    parts.push(escposCut());
    return concatBytes(parts);
  }
  async function usbPrintReceipt(saleId, ts, subtotal, discount, markup, voucherAmount, total, method, items){
    await usbPrintBytes(buildReceiptBytes(saleId, ts, subtotal, discount, markup, voucherAmount, total, method, items));
  }
  async function btPrintReceipt(saleId, ts, subtotal, discount, markup, voucherAmount, total, method, items){
    await btPrintBytes(buildReceiptBytes(saleId, ts, subtotal, discount, markup, voucherAmount, total, method, items));
  }

  function buildEODBytes(summary){
    const w = escposColWidth();
    const shop = getSetting("shop_name","My Shop");
    const parts = [ escposInit(), escposFontB(), escposNormalSize(), escposAlign("center"), escposBold(true),
      escposTextBytes(shop+"\n"), escposBold(false),
      escposTextBytes("End of Day — "+summary.date+"\n"), escposAlign("left"), escposLine(w) ];
    parts.push(escposTextBytes(padLine("Sales Cash", `${currency}${summary.cash.toFixed(2)}`, w)+"\n"));
    parts.push(escposTextBytes(padLine("Sales EcoCash", `${currency}${summary.ecocash.toFixed(2)}`, w)+"\n"));
    parts.push(escposTextBytes(padLine("Sales Credit", `${currency}${summary.credit.toFixed(2)}`, w)+"\n"));
    parts.push(escposTextBytes(padLine("Less: Discounts", `-${currency}${summary.discounts.toFixed(2)}`, w)+"\n"));
    parts.push(escposBold(true), escposTextBytes(padLine("Total Sales", `${currency}${summary.totalSales.toFixed(2)}`, w)+"\n"), escposBold(false));
    parts.push(escposLine(w));
    summary.payouts.forEach(p=> parts.push(escposTextBytes(padLine(p.reason||"Payout", `-${currency}${p.amount.toFixed(2)}`, w)+"\n")));
    parts.push(escposTextBytes(padLine("Less: Payouts", `-${currency}${summary.payoutsTotal.toFixed(2)}`, w)+"\n"));
    parts.push(escposLine(w));
    parts.push(escposTextBytes(padLine("Expected Cash", `${currency}${summary.expected.toFixed(2)}`, w)+"\n"));
    parts.push(escposTextBytes(padLine("Cash Count", `${currency}${summary.counted.toFixed(2)}`, w)+"\n"));
    parts.push(escposBold(true), escposTextBytes(padLine("Variance", `${currency}${summary.variance.toFixed(2)}`, w)+"\n"), escposBold(false));
    parts.push(escposLine(w));
    parts.push(escposTextBytes("Low stock:\n"));
    if(summary.lowStock.length) summary.lowStock.forEach(p=> parts.push(escposTextBytes("- "+p.name+" ("+p.stock+")\n")));
    else parts.push(escposTextBytes("None\n"));
    parts.push(escposCut());
    return concatBytes(parts);
  }
  async function usbPrintEODBytes(summary){ await usbPrintBytes(buildEODBytes(summary)); }
  async function btPrintEODBytes(summary){ await btPrintBytes(buildEODBytes(summary)); }

  // Calibration tool: a fixed-length known string is a far more reliable
  // wrap test than any receipt's real content. Accepts an explicit column
  // count so the Settings button can test the live (unsaved) mm value
  // instead of whatever's already persisted.
  function buildTestLineBytes(w){
    w = w || escposColWidth();
    let digits = "";
    for(let i=0;i<w;i++) digits += (i%2===0? "1":"9");
    const parts = [ escposInit(), escposFontB(), escposNormalSize() ];
    parts.push(escposTextBytes(digits+"\n"));
    parts.push(escposLine(w));
    parts.push(escposTextBytes("If this line wrapped, lower the mm value above.\n"));
    parts.push(escposCut());
    return concatBytes(parts);
  }
  async function printTestLine(){
    const mm = parseFloat(document.getElementById("sPaper").value) || paperWidth();
    const w = paperColumns(mm);
    const sentDirect = await sendDirect(buildTestLineBytes(w));
    if(sentDirect) return;
    let digits = "";
    for(let i=0;i<w;i++) digits += (i%2===0? "1":"9");
    document.getElementById("printArea").innerHTML = `
      <div class="receipt">
        <div style="font-family:monospace">${digits}</div>
        <hr>
        <div>If this line wrapped, lower the mm value above.</div>
      </div>`;
    printNow(mm);
  }

  function printNow(pageSizeMm){
    let styleEl = document.getElementById("dynPageSize");
    if(!styleEl){ styleEl=document.createElement("style"); styleEl.id="dynPageSize"; document.head.appendChild(styleEl); }
    styleEl.textContent = pageSizeMm ? `@page{size:${pageSizeMm}mm auto;margin:2mm;}` : `@page{margin:10mm;}`;
    window.print();
  }

  async function printReceipt(saleId, ts, subtotal, discount, markup, voucherAmount, total, method, items){
    const sentDirect = await sendDirect(buildReceiptBytes(saleId, ts, subtotal, discount, markup, voucherAmount, total, method, items));
    if(sentDirect) return;
    const shop = getSetting("shop_name","My Shop");
    const branch = getSetting("branch_name","");
    const contact = getSetting("contact_phone","");
    const lines = items.map(i=>`<div class="line"><span>${i.qty} x ${escapeHtml(i.name)}</span><span>${currency}${(i.price*i.qty).toFixed(2)}</span></div>`).join("");
    document.getElementById("printArea").innerHTML = `
      <div class="receipt">
        <h3>${escapeHtml(shop)}</h3>
        ${branch?`<div style="text-align:center">${escapeHtml(branch)}</div>`:""}
        ${contact?`<div style="text-align:center">${escapeHtml(contact)}</div>`:""}
        <hr>
        <div>${new Date(ts).toLocaleString()}</div>
        <div>Receipt #${saleId}</div>
        <hr>
        ${lines}
        <hr>
        <div class="line"><span>Subtotal</span><span>${currency}${subtotal.toFixed(2)}</span></div>
        ${discount>0?`<div class="line"><span>Discount</span><span>-${currency}${discount.toFixed(2)}</span></div>`:""}
        ${markup>0?`<div class="line"><span>Markup</span><span>+${currency}${markup.toFixed(2)}</span></div>`:""}
        ${voucherAmount>0?`<div class="line"><span>Voucher</span><span>-${currency}${voucherAmount.toFixed(2)}</span></div>`:""}
        <div class="line"><b>TOTAL</b><b>${currency}${total.toFixed(2)}</b></div>
        <div>Payment: ${method}</div>
        <hr>
        <div style="text-align:center">Thank you for your business</div>
      </div>`;
    printNow(paperWidth());
  }
  async function printEOD(summary){
    const sentDirect = await sendDirect(buildEODBytes(summary));
    if(sentDirect) return;
    document.getElementById("printArea").innerHTML = `
      <div class="receipt">
        <h3>${escapeHtml(getSetting("shop_name","My Shop"))}</h3>
        <div style="text-align:center">End of Day — ${summary.date}</div>
        <hr>
        <div class="line"><span>Sales Cash</span><span>${currency}${summary.cash.toFixed(2)}</span></div>
        <div class="line"><span>Sales EcoCash</span><span>${currency}${summary.ecocash.toFixed(2)}</span></div>
        <div class="line"><span>Sales Credit</span><span>${currency}${summary.credit.toFixed(2)}</span></div>
        <div class="line"><span>Less: Discounts</span><span>-${currency}${summary.discounts.toFixed(2)}</span></div>
        <div class="line"><b>Total Sales</b><b>${currency}${summary.totalSales.toFixed(2)}</b></div>
        <hr>
        <div>Payouts:</div>
        ${summary.payouts.length? summary.payouts.map(p=>`<div class="line"><span>${escapeHtml(p.reason)}</span><span>-${currency}${p.amount.toFixed(2)}</span></div>`).join("") : "<div>None</div>"}
        <div class="line"><b>Less: Payouts</b><b>-${currency}${summary.payoutsTotal.toFixed(2)}</b></div>
        <hr>
        <div class="line"><span>Expected Cash</span><span>${currency}${summary.expected.toFixed(2)}</span></div>
        <div class="line"><span>Cash Count</span><span>${currency}${summary.counted.toFixed(2)}</span></div>
        <div class="line"><b>Variance</b><b>${currency}${summary.variance.toFixed(2)}</b></div>
        <hr>
        <div>Low stock:</div>
        ${summary.lowStock.length? summary.lowStock.map(p=>`<div>- ${escapeHtml(p.name)} (${p.stock})</div>`).join("") : "<div>None</div>"}
      </div>`;
    printNow(paperWidth());
  }

  function buildPaymentReceiptBytes(customerName, amount, newBalance, ts){
    const w = escposColWidth();
    const shop = getSetting("shop_name","My Shop");
    const branch = getSetting("branch_name","");
    const parts = [ escposInit(), escposFontB(), escposNormalSize(), escposAlign("center"), escposBold(true),
      escposTextBytes(shop+"\n"), escposBold(false) ];
    if(branch) parts.push(escposTextBytes(branch+"\n"));
    parts.push(escposAlign("left"), escposLine(w));
    parts.push(escposTextBytes(new Date(ts).toLocaleString()+"\n"));
    parts.push(escposBold(true), escposTextBytes("Payment Received\n"), escposBold(false));
    parts.push(escposLine(w));
    parts.push(escposTextBytes(padLine("Customer", customerName, w)+"\n"));
    parts.push(escposTextBytes(padLine("Amount Paid", `${currency}${amount.toFixed(2)}`, w)+"\n"));
    parts.push(escposBold(true), escposTextBytes(padLine("New Balance", `${currency}${newBalance.toFixed(2)}`, w)+"\n"), escposBold(false));
    parts.push(escposLine(w));
    parts.push(escposAlign("center"), escposTextBytes("Thank you\n"));
    parts.push(escposCut());
    return concatBytes(parts);
  }
  async function printPaymentReceipt(customerName, amount, newBalance, ts){
    const sentDirect = await sendDirect(buildPaymentReceiptBytes(customerName, amount, newBalance, ts));
    if(sentDirect) return;
    const shop = getSetting("shop_name","My Shop");
    const branch = getSetting("branch_name","");
    document.getElementById("printArea").innerHTML = `
      <div class="receipt">
        <h3>${escapeHtml(shop)}</h3>
        ${branch?`<div style="text-align:center">${escapeHtml(branch)}</div>`:""}
        <hr>
        <div>${new Date(ts).toLocaleString()}</div>
        <div style="text-align:center"><b>Payment Received</b></div>
        <hr>
        <div class="line"><span>Customer</span><span>${escapeHtml(customerName)}</span></div>
        <div class="line"><span>Amount Paid</span><span>${currency}${amount.toFixed(2)}</span></div>
        <div class="line"><b>New Balance</b><b>${currency}${newBalance.toFixed(2)}</b></div>
        <hr>
        <div style="text-align:center">Thank you</div>
      </div>`;
    printNow(paperWidth());
  }
  function printReport(title, subtitle, headers, rows, footerHtml){
    document.getElementById("printArea").innerHTML = `
      <div class="report-print">
        <h2>${escapeHtml(getSetting("shop_name","My Shop"))} — ${escapeHtml(title)}</h2>
        <div class="sub">${escapeHtml(subtitle)}</div>
        <table>
          <tr>${headers.map(h=>`<th>${escapeHtml(h)}</th>`).join("")}</tr>
          ${rows.map(r=>`<tr>${r.map(c=>`<td>${c}</td>`).join("")}</tr>`).join("")}
        </table>
        ${footerHtml||""}
      </div>`;
    printNow(null);
  }

  // Reprints ANY historical sale by id, reconstructed entirely from the
  // stored sales/sale_items rows — separate from printReceipt()/
  // buildReceiptBytes(), which only ever handle the sale that was just
  // completed. Clearly marked as a copy on both the direct-print (ESC/POS)
  // and OS-dialog (diagonal CSS watermark) paths, since thermal printers
  // can't do a true watermark.
  function buildSaleCopyBytes(sale, items){
    const w = escposColWidth();
    const shop = getSetting("shop_name","My Shop");
    const branch = getSetting("branch_name","");
    const parts = [ escposInit(), escposFontB(), escposNormalSize(), escposAlign("center"), escposBold(true),
      escposTextBytes("*** COPY - NOT ORIGINAL ***\n"), escposTextBytes(shop+"\n"), escposBold(false) ];
    if(branch) parts.push(escposTextBytes(branch+"\n"));
    parts.push(escposAlign("left"), escposLine(w));
    parts.push(escposTextBytes(new Date(sale.ts).toLocaleString()+"\n"));
    parts.push(escposTextBytes("Receipt #"+sale.id+"\n"));
    parts.push(escposLine(w));
    items.forEach(i=> parts.push(escposTextBytes(padLine(`${i.qty} x ${i.name}`, `${currency}${(i.price*i.qty).toFixed(2)}`, w)+"\n")));
    parts.push(escposLine(w));
    parts.push(escposTextBytes(padLine("Subtotal", `${currency}${sale.subtotal.toFixed(2)}`, w)+"\n"));
    if(sale.discount>0) parts.push(escposTextBytes(padLine("Discount", `-${currency}${sale.discount.toFixed(2)}`, w)+"\n"));
    if(sale.markup>0) parts.push(escposTextBytes(padLine("Markup", `+${currency}${sale.markup.toFixed(2)}`, w)+"\n"));
    if(sale.voucher_amount>0) parts.push(escposTextBytes(padLine("Voucher", `-${currency}${sale.voucher_amount.toFixed(2)}`, w)+"\n"));
    parts.push(escposBold(true), escposTextBytes(padLine("TOTAL", `${currency}${sale.total.toFixed(2)}`, w)+"\n"), escposBold(false));
    parts.push(escposTextBytes("Payment: "+sale.method+"\n"));
    parts.push(escposLine(w));
    parts.push(escposAlign("center"), escposTextBytes("Thank you for your business\n"));
    parts.push(escposCut());
    return concatBytes(parts);
  }
  async function printSaleCopy(saleId){
    const sale = one("SELECT * FROM sales WHERE id=?",[saleId]);
    if(!sale) return;
    const items = all("SELECT * FROM sale_items WHERE sale_id=?",[saleId]);
    const sentDirect = await sendDirect(buildSaleCopyBytes(sale, items));
    if(sentDirect) return;
    const shop = getSetting("shop_name","My Shop");
    const branch = getSetting("branch_name","");
    const contact = getSetting("contact_phone","");
    const lines = items.map(i=>`<div class="line"><span>${i.qty} x ${escapeHtml(i.name)}</span><span>${currency}${(i.price*i.qty).toFixed(2)}</span></div>`).join("");
    document.getElementById("printArea").innerHTML = `
      <div class="receipt" style="position:relative">
        <div style="position:absolute;top:40%;left:50%;transform:translate(-50%,-50%) rotate(-30deg);font-size:44px;font-weight:800;color:rgba(0,0,0,.18);white-space:nowrap;z-index:5;pointer-events:none">COPY</div>
        <h3>${escapeHtml(shop)}</h3>
        ${branch?`<div style="text-align:center">${escapeHtml(branch)}</div>`:""}
        ${contact?`<div style="text-align:center">${escapeHtml(contact)}</div>`:""}
        <hr>
        <div>${new Date(sale.ts).toLocaleString()}</div>
        <div>Receipt #${sale.id}</div>
        <hr>
        ${lines}
        <hr>
        <div class="line"><span>Subtotal</span><span>${currency}${sale.subtotal.toFixed(2)}</span></div>
        ${sale.discount>0?`<div class="line"><span>Discount</span><span>-${currency}${sale.discount.toFixed(2)}</span></div>`:""}
        ${sale.markup>0?`<div class="line"><span>Markup</span><span>+${currency}${sale.markup.toFixed(2)}</span></div>`:""}
        ${sale.voucher_amount>0?`<div class="line"><span>Voucher</span><span>-${currency}${sale.voucher_amount.toFixed(2)}</span></div>`:""}
        <div class="line"><b>TOTAL</b><b>${currency}${sale.total.toFixed(2)}</b></div>
        <div>Payment: ${sale.method}</div>
        <hr>
        <div style="text-align:center">Thank you for your business</div>
      </div>`;
    printNow(paperWidth());
  }
  // A4 Credit invoice — the OS-dialog #printArea/printNow() path (same
  // mechanism as Reports/Catalogue), never the thermal ESC/POS path, since
  // an invoice is a proper document, not a till receipt.
  function printCreditInvoice(saleId){
    const sale = one("SELECT * FROM sales WHERE id=?",[saleId]);
    if(!sale) return;
    const items = all("SELECT * FROM sale_items WHERE sale_id=?",[saleId]);
    const cust = sale.customer_id? one("SELECT * FROM customers WHERE id=?",[sale.customer_id]) : null;
    const balance = sale.customer_id? customerBalance(sale.customer_id) : sale.total;
    const shop = getSetting("shop_name","My Shop");
    const branch = getSetting("branch_name","");
    const contact = getSetting("contact_phone","");
    document.getElementById("printArea").innerHTML = `
      <div class="report-print">
        <h2>${escapeHtml(shop)}</h2>
        <div class="sub">${escapeHtml(branch)}${contact? ` · ${escapeHtml(contact)}` : ""}</div>
        <h3 class="section">INVOICE</h3>
        <p>Invoice #: ${sale.id}<br>Date: ${new Date(sale.ts).toLocaleString()}</p>
        <p><b>Bill To:</b><br>${cust? escapeHtml(cust.name) : "—"}${cust && cust.phone? `<br>${escapeHtml(cust.phone)}` : ""}</p>
        <table>
          <tr><th>Item</th><th>Qty</th><th>Price</th><th>Amount</th></tr>
          ${items.map(i=>`<tr><td>${escapeHtml(i.name)}</td><td>${i.qty}</td><td>${currency}${i.price.toFixed(2)}</td><td>${currency}${(i.price*i.qty).toFixed(2)}</td></tr>`).join("")}
        </table>
        <p style="text-align:right">
          Subtotal: ${currency}${sale.subtotal.toFixed(2)}<br>
          ${sale.discount>0? `Discount: -${currency}${sale.discount.toFixed(2)}<br>` : ""}
          ${sale.markup>0? `Markup: +${currency}${sale.markup.toFixed(2)}<br>` : ""}
          ${sale.voucher_amount>0? `Voucher: -${currency}${sale.voucher_amount.toFixed(2)}<br>` : ""}
          <b>TOTAL: ${currency}${sale.total.toFixed(2)}</b><br>
          <b>Balance Due: ${currency}${balance.toFixed(2)}</b>
        </p>
      </div>`;
    printNow(null);
  }
  // Read-only historical transaction view — reached by tapping a Receipt#
  // in the Sales Report (Report Writer). No inputs, no edit capability.
  function openSaleDetailModal(saleId){
    const sale = one("SELECT * FROM sales WHERE id=?",[saleId]);
    if(!sale) return;
    const items = all("SELECT * FROM sale_items WHERE sale_id=?",[saleId]);
    const cust = sale.customer_id? one("SELECT * FROM customers WHERE id=?",[sale.customer_id]) : null;
    const wrap = openModal(`Receipt #${sale.id}`, `
      <div class="subline"><span>Date/Time</span><span>${escapeHtml(new Date(sale.ts).toLocaleString())}</span></div>
      <div class="subline"><span>Branch</span><span>${escapeHtml(sale.branch||"")}</span></div>
      <div class="subline"><span>Method</span><span>${escapeHtml(sale.method)}</span></div>
      ${cust? `<div class="subline"><span>Customer</span><span>${escapeHtml(cust.name)}</span></div>` : ""}
      <div class="hr"></div>
      ${items.map(i=>`<div class="subline"><span>${i.qty} x ${escapeHtml(i.name)}</span><span>${currency}${(i.price*i.qty).toFixed(2)}</span></div>`).join("")}
      <div class="hr"></div>
      <div class="subline"><span>Subtotal</span><span>${currency}${sale.subtotal.toFixed(2)}</span></div>
      ${sale.discount>0? `<div class="subline"><span>Discount</span><span>-${currency}${sale.discount.toFixed(2)}</span></div>
        ${sale.discount_reason? `<div class="muted" style="margin-bottom:4px">Reason: ${escapeHtml(sale.discount_reason)}${sale.discount_status? ` · ${escapeHtml(sale.discount_status)}` : ""}</div>` : ""}` : ""}
      ${sale.markup>0? `<div class="subline"><span>Markup</span><span>+${currency}${sale.markup.toFixed(2)}</span></div>
        ${sale.markup_reason? `<div class="muted" style="margin-bottom:4px">Reason: ${escapeHtml(sale.markup_reason)}</div>` : ""}` : ""}
      ${sale.voucher_amount>0? `<div class="subline"><span>Voucher</span><span>-${currency}${sale.voucher_amount.toFixed(2)}</span></div>` : ""}
      <div class="total-line"><span>Total</span><span>${currency}${sale.total.toFixed(2)}</span></div>
      <button class="btn btn-outline" id="printSaleCopyBtn" style="margin-top:12px">🖨️ Print Copy</button>
      ${sale.method==="Credit"? `<button class="btn btn-outline" id="printInvoiceBtn" style="margin-top:8px">🖨️ Print Invoice</button>` : ""}
    `);
    wrap.querySelector("#printSaleCopyBtn").onclick=()=> printSaleCopy(sale.id);
    const invBtn = wrap.querySelector("#printInvoiceBtn");
    if(invBtn) invBtn.onclick=()=> printCreditInvoice(sale.id);
  }
