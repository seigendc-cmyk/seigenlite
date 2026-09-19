  function renderAbout(main){
    main.innerHTML = `
      <div class="card">
        <p>seiGEN Commerce Lite is for people who care about growth in business. It's built so any shop — one till or several — can run sales, track stock, and close the day properly, without needing the internet to work.</p>
        <div class="hr"></div>
        <p><b>Digital Commerce</b><br>Commerce Valley Est, Marirangwe, Mhondoro<br>digitalcommerce.com</p>
        <p><b>Call/WhatsApp:</b> +263774479121 / +263789487287</p>
        <button class="btn btn-primary" id="waAbout1">📲 WhatsApp +263774479121</button>
        <div style="height:8px"></div>
        <button class="btn btn-outline" id="waAbout2">📲 WhatsApp +263789487287</button>
        <div class="hr"></div>
        <p class="muted" style="font-size:11.5px">Distributed under license from seiGEN Commerce Infrastructure.</p>
        <p class="muted" style="font-size:11.5px">Version ${escapeHtml(APP_VERSION)}</p>
      </div>
    `;
    const intro = "Hi, I'm using seiGEN Commerce Lite and would like to get in touch.";
    document.getElementById("waAbout1").onclick=()=> window.open("https://wa.me/263774479121?text="+encodeURIComponent(intro),"_blank");
    document.getElementById("waAbout2").onclick=()=> window.open("https://wa.me/263789487287?text="+encodeURIComponent(intro),"_blank");
  }

  function renderHelp(main){
    main.innerHTML = `
        <div class="search-wrap">
          <span class="ic">🔎</span>
          <input class="field" id="helpSearch" placeholder="Search help topics…" value="${escapeHtml(helpQuery)}">
        </div>
        <div class="card" id="helpCard">
          <p><b>Setup:</b> On first open, enter your shop name, branch, branch type (Main or Remote), contact number and banner image. This needs internet the very first time (to load the database engine) — after that it works fully offline.</p>
          <p><b>If the app won't open on a phone:</b> make sure it's opened in Chrome (not a preview inside WhatsApp — tap "Open with" → Chrome) and that there's an internet connection the first time. After that first successful open, it no longer needs one.</p>
          <p><b>Who's working:</b> each time the app opens, it asks who's working today. That name is recorded against sales, stock changes, receiving, and discount approvals. Tap your name in the top bar any time to switch, e.g. at a shift change.</p>
          <p><b>Selling:</b> Search a product by name, SKU, or hidden search keywords, tap Add. Open the cart with the orange cart icon, adjust quantities, add a discount if needed. Customer name/phone is optional for Cash and EcoCash and required for Credit.</p>
          <p><b>Payment methods:</b> Cash, EcoCash, Bank, or Credit. EcoCash and Bank both require a payment reference number before the sale completes.</p>
          <p><b>Discounts:</b> Any discount above zero requires a reason, and an optional approver's name — left blank, it's recorded as Pending; filled in, it's Approved. Both show up on the Discount Report.</p>
          <p><b>Products:</b> Add a photo, SKU, price, cost, stock, and optional hidden search keywords for each product (keywords never appear on any screen or report — they only help search find the item). Tap Edit to update details, add stock, or print a small marketing card. Cost is hidden entirely on Remote branches.</p>
          <p><b>Main vs Remote branch:</b> set at Setup (changeable in Settings). Remote branches can sell normally, but can't add or edit products, change stock quantities directly, or see item costs — that stays with the Main branch. A remote gets its products from the main branch's <b>catalogue file</b> (Products → Get catalogue). Main chooses, per branch, whether prices follow main, are set by main for that branch, or can be changed at the branch (selling price only, with the Admin passcode).</p>
          <p><b>Merging another branch's file on a Remote branch:</b> a Remote branch can still import another branch's exported data file in Settings. If it does, that branch's stock and prices become visible — read-only — under More → Product List and in most Reports, even though the Remote branch still can't sell from it, edit it, or see its cost. If you don't want a Remote branch to see another branch's data at all, don't send it their export file.</p>
          <p><b>Requests (under More):</b> a quick notepad for stock a customer asked for that you didn't have — tap + Log Request to note the item, and the customer's name/phone if they want to be told when it arrives. Any branch, including Remote, can log one. Once branches are merged onto one device, the Branch filter here lets you see requests logged everywhere — useful for spotting what to stock next.</p>
          <p><b>Product Catalogue:</b> in Products, tick the items you want to publish (or Select all), then Print Catalogue for an A4 sheet of cards — photo, SKU, name, price — ready to hand out or display. Cost and search keywords never appear on it.</p>
          <p><b>Credit sales:</b> Entering a customer name on Credit creates or matches that customer automatically. The Credit tab lists only customers who owe or have owed money, for recording payments and sending payment reminders on WhatsApp.</p>
          <p><b>Directory:</b> Under More → Directory is every customer who's given a name at checkout, for sending general WhatsApp marketing messages — separate from Credit, which stays focused on balances.</p>
          <p><b>Payouts:</b> On End of Day, tap + Add Payout to log cash taken from the drawer with a reason — this is subtracted from expected cash.</p>
          <p><b>End of Day:</b> Count your physical cash, enter it, then tap Reveal Variance.</p>
          <p><b>Multiple branches:</b> Each device runs one branch. In Settings, you can Export your branch's data file and Import another branch's file into a head-office device — choose Merge (keeps every branch's records separate and filterable) or Replace (wipes current data). A backup downloads automatically before either. A remote branch can only take a data file exported by another remote branch, never one from a main branch; it gets products from the catalogue and stock from Delivery Notes. A remote creates its own Admin passcode at Setup.</p>
          <p><b>Stock adjustments:</b> for stock that is lost in transit, damaged, expired, stolen or miscounted, tap the adjust button on a product (main and remote branches). Choose a reason, enter the quantity change (a whole number, negative to reduce), write a note and enter an Admin passcode. Lost, damaged, expired and theft can only reduce stock; miscount correction and other can also add. Stock can't go below zero. Price and cost are never changed. <b>Adjustments</b> on the Products page lists this device's adjustments; on the main branch, Reports → <b>Stock Adjustments</b> lists every merged branch's, valued at main's cost by product code.</p>
          <p><b>Cancelling, reissuing or closing a Delivery Note:</b> from Dispatch history, an Admin on the dispatching branch can cancel a Delivery Note that is dispatched, awaiting or has a variance, cancel and reissue it with corrected lines, or close it as a loss. Nothing in the dispatcher's stock changes until the receiving branch confirms it (Receive stock, then send the confirmation back and Import it in Dispatch history), so stock is never restored while the receiver could still accept the goods. A receiver who has already accepted the Delivery Note cannot cancel it: the goods stay received. If a receiver can't be reached, an Admin can cancel without confirmation; it is flagged, and if the goods are received after all the Delivery Note shows Conflict. Stock movements on main shows the chain (superseded by / replaces) and the loss at main's cost. Switch this on in Settings only after every branch has updated the app.</p>
          <p><b>Branch name:</b> locked after setup, because Delivery Notes, catalogues and the branch register carry it. In the destination list a name can be changed only until the first Delivery Note is dispatched to it.</p>
          <p><b>Dispatch, receipt and confirmation:</b> the dispatcher sends a Delivery Note; the receiver checks it, accepts it and sends the Goods Received Voucher (GRV) back with <b>Send GRV to…</b>; the dispatcher opens <b>Dispatch history → Import GRV</b> to confirm delivery (stock is not changed). Status shows as Dispatched, Received, Variance (when a variance report has been merged in) or Awaiting (no GRV after the number of days set in Settings). On the main branch, Reports → <b>Stock Movements</b> lists every Delivery Note; it is for information only. Merging a branch's data file brings its Delivery Note events across.</p>
          <p><b>Reports:</b> Sales, Inventory, Stock Received, Low Stock, Credit Sales, Discount Report (with reason and approval status), Margin Report (revenue vs cost — hidden on Remote branches), Aging Inventory (0-15/15-30/30-60/60-90/90+ days since last received), Fast Moving Items, Payouts Report, and Customer Report — all filterable by branch and date. Branch Report combines all of these into one document for a branch and period.</p>
          <p><b>Printing:</b> Receipts and End of Day print formatted for thermal paper (set 58mm or 80mm in Settings). Reports and the Catalogue print at normal A4 page size.</p>
          <p><b>WhatsApp sharing:</b> The 📲 buttons next to Print send a neatly formatted text version of the receipt/report/reminder straight into WhatsApp.</p>
          <p><b>USB printer:</b> When available (Chrome, app served via a local server), a 🔌 button appears next to Print on receipts and End of Day — connect a USB thermal printer directly, no driver needed. See Settings to connect one ahead of time.</p>
          <p><b>Frequent-customer vouchers:</b> Set a purchase count, a day window, and a voucher amount in Settings, and a customer who hits that many purchases in that time at a branch automatically earns a voucher. It shows as a 🎁 badge next to their name at their next sale — tap Apply Voucher to subtract it from the total. Left at $0 (the default), this feature does nothing.</p>
          <p><b>Credit sale invoices:</b> Any Credit sale gets a 🖨️ Invoice option alongside its receipt — a proper A4 document with your letterhead, itemized lines, and the customer's current Balance Due, useful for handing to a customer or filing separately from the till receipt.</p>
          <p><b>Sharing an export via WhatsApp:</b> Next to Export in Settings, 📲 Share via WhatsApp opens your device's share sheet with the data file already attached, skipping the manual-attach step — where a browser doesn't support that, it downloads the file instead and tells you to attach it yourself.</p>
          <p><b>Export filenames:</b> Every exported data file — manual Export, WhatsApp share, or the automatic file after a Dispatch — is named the same way: name, branch, date, and time, so it's always clear at a glance which file is which and when it was made.</p>
          <p><b>Activation:</b> The app locks every 30 days. Call or WhatsApp +263774479121 with the device code shown and we'll send you an unlock code.</p>
          <p class="muted" id="helpNoMatch" style="display:none">No help topics match your search.</p>
        </div>
    `;
    const input = document.getElementById("helpSearch");
    // Filters existing <p> topics in place (show/hide via display, no
    // re-render of the card's own HTML) so the topic text/formatting is
    // never touched — just which paragraphs are visible.
    function applyHelpFilter(){
      const card = document.getElementById("helpCard");
      const topics = Array.from(card.querySelectorAll("p")).filter(p=> p.id!=="helpNoMatch");
      let anyVisible = false;
      topics.forEach(p=>{
        const match = matchesAnyOrder(helpQuery, p.textContent);
        p.style.display = match? "" : "none";
        if(match) anyVisible = true;
      });
      document.getElementById("helpNoMatch").style.display = anyVisible? "none" : "";
    }
    input.oninput = (e)=>{ helpQuery = e.target.value; applyHelpFilter(); };
    applyHelpFilter();
  }

