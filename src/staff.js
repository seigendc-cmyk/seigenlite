  // ---------------- Staff & Roles (Settings, Main branch only) ----------------
  function staffSectionHtml(){
    const staffList = all("SELECT * FROM staff WHERE branch=? ORDER BY active DESC, name",[currentBranch()]);
    return `
      <div class="card">
        <h3>Staff & Roles</h3>
        <button class="btn btn-primary" id="openAddStaff" style="margin-bottom:10px">+ Add Staff</button>
        ${staffList.length===0? `<p class="muted">No staff added yet.</p>` : staffList.map(s=>`
          <div class="product-row">
            <div>
              <div class="pname">${escapeHtml(s.name)}${s.active? "" : ` <span class="pill low">inactive</span>`}</div>
              <div class="pmeta">${escapeHtml(s.role)}</div>
            </div>
            <button class="btn btn-sm btn-outline" data-edit-staff="${s.id}" style="flex:none">Edit</button>
          </div>`).join("")}
      </div>`;
  }
  function staffModal(existing){
    const isEdit = !!existing;
    const wrap = openModal(isEdit? "Edit Staff" : "Add Staff", `
      <label style="margin-top:0">Name</label>
      <input class="field" id="stName" value="${escapeHtml(existing? existing.name : "")}">
      <label>Role</label>
      <select class="field" id="stRole">
        <option value="Cashier" ${(!existing||existing.role==="Cashier")?"selected":""}>Cashier</option>
        <option value="Admin" ${(existing&&existing.role==="Admin")?"selected":""}>Admin</option>
      </select>
      <label>Passcode</label>
      <input class="field" id="stPasscode" value="${escapeHtml(existing? (existing.passcode||"") : "")}" placeholder="Numeric or text code">
      ${isEdit? `<label style="display:flex;align-items:center;gap:8px;margin-top:14px"><input type="checkbox" id="stActive" ${existing.active? "checked":""} style="width:auto;margin:0"> Active</label>` : ""}
      <button class="btn btn-primary" id="stConfirm" style="margin-top:14px">${isEdit? "Save Changes" : "Add Staff"}</button>
    `);
    wrap.querySelector("#stConfirm").onclick=()=>{
      const name = wrap.querySelector("#stName").value.trim();
      if(!name) return alert("Enter the staff member's name");
      const role = wrap.querySelector("#stRole").value;
      const passcode = wrap.querySelector("#stPasscode").value.trim();
      if(isEdit){
        const active = wrap.querySelector("#stActive").checked?1:0;
        run("UPDATE staff SET name=?, role=?, passcode=?, active=? WHERE id=?",[name,role,passcode,active,existing.id]);
      } else {
        run("INSERT INTO staff(name,role,passcode,branch,active,created_ts) VALUES(?,?,?,?,1,?)",
          [name,role,passcode,currentBranch(),new Date().toISOString()]);
      }
      persist(); wrap.remove(); render();
    };
  }
  function wireStaffSection(){
    document.getElementById("openAddStaff").onclick=()=>staffModal(null);
    document.querySelectorAll("[data-edit-staff]").forEach(b=>{
      b.onclick=()=>{
        const s = one("SELECT * FROM staff WHERE id=?",[+b.dataset.editStaff]);
        staffModal(s);
      };
    });
  }


  function renderWhoAmI(){
    route="whoami";
    const last = getSetting("last_user","");
    $app.innerHTML = `<div class="center-screen"><div class="setup-card center">
      <h2>Who's working today?</h2>
      <p class="muted">Your name is recorded against sales, stock changes, and discount approvals for this session.</p>
      <input class="field" id="whoName" placeholder="Your name" value="${escapeHtml(last)}" style="text-align:center;font-weight:700">
      <button class="btn btn-primary" id="whoContinue" style="margin-top:14px">Continue</button>
    </div></div>`;
    const input = document.getElementById("whoName");
    input.focus();
    document.getElementById("whoContinue").onclick=()=>{
      const name = input.value.trim();
      if(!name) return alert("Enter your name to continue");
      sessionUser = name;
      setSetting("last_user", name); persist();
      route="pos"; render();
    };
  }
  function changeSessionUser(){
    const name = prompt("Who's working now?", sessionUser||"");
    if(name && name.trim()){ sessionUser = name.trim(); setSetting("last_user", sessionUser); persist(); render(); }
  }


  // ---- device Admin passcode (Phase 4) ----
  // A remote branch creates its OWN first Admin passcode, at Setup or on the locked
  // Settings screen while it has none. It no longer depends on merging a main
  // branch's data file to receive one.
  const ADMIN_PASSCODE_MIN = 4;
  // "" = fine, otherwise the plain reason.
  function adminPasscodeProblem(passcode, confirmText){
    const p = String(passcode==null?"":passcode).trim();
    if(p.length<ADMIN_PASSCODE_MIN) return "The Admin passcode must be at least "+ADMIN_PASSCODE_MIN+" characters.";
    if(p!==String(confirmText==null?"":confirmText).trim()) return "The two passcodes don't match.";
    return "";
  }
  function createDeviceAdmin(passcode, confirmText){
    const bad = adminPasscodeProblem(passcode, confirmText);
    if(bad) throw new Error(bad);
    const branch = currentBranch();
    let name = "Admin", n = 1;
    while(one("SELECT 1 AS x FROM staff WHERE branch=? AND name=?",[branch,name])){ n++; name = "Admin "+n; }
    run("INSERT INTO staff(name,role,passcode,branch,active,created_ts) VALUES(?,?,?,?,1,?)",
      [name,"Admin",String(passcode).trim(),branch,new Date().toISOString()]);
    return name;
  }

  // The Admin unlock shared by price edits and stock adjustments: an active Admin whose
  // (non-empty) passcode matches. There is no session unlock - it is typed each time.
  function findAdmin(passcode){
    const code = String(passcode==null?"":passcode);
    return code.trim()? (one("SELECT * FROM staff WHERE role='Admin' AND passcode=? AND passcode<>'' AND active=1",[code]) || null) : null;
  }
