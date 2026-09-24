// Run: node --no-warnings test/staff-pin.test.js
// Staff Access List + PIN Login, over the REAL app source (staff.js) and
// SQLite, via the same harness the DN/cancel suites use.
"use strict";
const assert = require("assert");
const { makeApp } = require("./harness");

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,5).join("\n       ")); }
}

function rig(o){
  return makeApp(Object.assign({ branch_name:"Boka", branch_type:"main", setup_complete:"1" }, o||{}));
}
function addStaff(app, o){
  return app.api.saveStaffMember(Object.assign({ name:"Tendai", role:"Cashier", pin:"1234" }, o||{}));
}

(async()=>{
  // ================= add / edit / deactivate =================
  await t("add: name, role, PIN accepted; the PIN is never stored in plain text", ()=>{
    const A = rig();
    const s = addStaff(A,{ name:"Tendai Moyo", pin:"4821" });
    assert.strictEqual(s.name,"Tendai Moyo"); assert.strictEqual(s.role,"Cashier"); assert.strictEqual(s.active,1);
    assert.ok(s.pin_hash && s.pin_hash!=="4821", "hashed, not the raw PIN");
    assert.ok(s.pin_salt, "a per-staff salt is stored");
    assert.notStrictEqual(s.pin_hash, A.api.hashPinSync("4821",""), "salted — hashing with no salt must not match");
    assert.strictEqual(A.api.hashPinSync("4821", s.pin_salt), s.pin_hash);
  });
  await t("add: a name is required; a PIN is required for a brand-new staff member", ()=>{
    const A = rig();
    assert.throws(()=>A.api.saveStaffMember({ name:"", pin:"1234" }), /name/i);
    assert.throws(()=>A.api.saveStaffMember({ name:"Tendai", pin:"" }), /PIN/i);
  });
  await t("edit: name/role change; leaving the PIN box blank keeps the existing PIN", ()=>{
    const A = rig();
    const s = addStaff(A,{ name:"Tendai", pin:"1234" });
    const edited = A.api.saveStaffMember({ id:s.id, name:"Tendai M.", role:"Admin", pin:"" });
    assert.strictEqual(edited.name,"Tendai M."); assert.strictEqual(edited.role,"Admin");
    assert.strictEqual(edited.pin_hash, s.pin_hash, "PIN untouched");
  });
  await t("edit: a supplied PIN replaces the old one and resets any lockout", ()=>{
    const A = rig();
    const s = addStaff(A,{ pin:"1234" });
    A.api.attemptPinLogin(s.id,"0000"); A.api.attemptPinLogin(s.id,"0000");
    const midway = A.api.one("SELECT pin_fail_count FROM staff WHERE id=?",[s.id]);
    assert.strictEqual(midway.pin_fail_count,2);
    const edited = A.api.saveStaffMember({ id:s.id, name:"Tendai", pin:"5566" });
    assert.notStrictEqual(edited.pin_hash, s.pin_hash);
    assert.strictEqual(edited.pin_fail_count,0);
    assert.strictEqual(A.api.attemptPinLogin(s.id,"5566").ok,true);
  });
  await t("deactivate: an inactive staff member drops out of the sign-in list", ()=>{
    const A = rig();
    const s = addStaff(A,{ name:"Rudo", pin:"1111" });
    assert.strictEqual(A.api.activeStaffWithPin("Boka").length,1);
    A.api.saveStaffMember({ id:s.id, name:"Rudo", active:false, pin:"" });
    assert.strictEqual(A.api.activeStaffWithPin("Boka").length,0);
    assert.strictEqual(A.api.one("SELECT active FROM staff WHERE id=?",[s.id]).active,0);
  });

  // ================= PIN format & uniqueness =================
  await t("PIN format: 4-6 digits only", ()=>{
    const A = rig();
    assert.ok(/4 to 6 digit/.test(A.api.pinProblem("")));
    assert.ok(/4 to 6 digits/.test(A.api.pinProblem("123")));
    assert.ok(/4 to 6 digits/.test(A.api.pinProblem("1234567")));
    assert.ok(/4 to 6 digits/.test(A.api.pinProblem("12ab")));
    assert.strictEqual(A.api.pinProblem("1234"),"");
    assert.strictEqual(A.api.pinProblem("123456"),"");
  });
  await t("duplicate PIN rejected among active staff on the same branch (tenant)", ()=>{
    const A = rig();
    addStaff(A,{ name:"Tendai", pin:"4821" });
    assert.throws(()=>addStaff(A,{ name:"Rudo", pin:"4821" }), /already used/);
    // a different PIN is fine
    const r = addStaff(A,{ name:"Rudo", pin:"9999" });
    assert.ok(r.id);
  });
  await t("a PIN freed up by deactivating its owner can be reused", ()=>{
    const A = rig();
    const s1 = addStaff(A,{ name:"Tendai", pin:"4821" });
    A.api.saveStaffMember({ id:s1.id, name:"Tendai", active:false, pin:"" });
    const s2 = addStaff(A,{ name:"Rudo", pin:"4821" });
    assert.ok(s2.id);
  });
  await t("PIN uniqueness is per tenant: the same PIN is fine on a different branch/device", ()=>{
    const A = rig({ branch_name:"Boka" });
    const B = rig({ branch_name:"CBD" });
    addStaff(A,{ name:"Tendai", pin:"4821" });
    const s = addStaff(B,{ name:"Anyone", pin:"4821" });
    assert.ok(s.id);
  });
  await t("editing a staff member's own PIN to the same value is not treated as a clash", ()=>{
    const A = rig();
    const s = addStaff(A,{ name:"Tendai", pin:"4821" });
    const again = A.api.saveStaffMember({ id:s.id, name:"Tendai", pin:"4821" });
    assert.strictEqual(again.pin_hash, A.api.hashPinSync("4821", again.pin_salt));
  });

  // ================= login =================
  await t("correct PIN logs in and returns the staff record", ()=>{
    const A = rig();
    const s = addStaff(A,{ name:"Tendai", pin:"4821" });
    const res = A.api.attemptPinLogin(s.id,"4821");
    assert.strictEqual(res.ok,true); assert.strictEqual(res.staff.id,s.id); assert.strictEqual(res.staff.name,"Tendai");
  });
  await t("incorrect PIN is refused, counts down remaining attempts, and doesn't touch anyone else", ()=>{
    const A = rig();
    const s1 = addStaff(A,{ name:"Tendai", pin:"4821" });
    const s2 = addStaff(A,{ name:"Rudo", pin:"1111" });
    const r1 = A.api.attemptPinLogin(s1.id,"0000");
    assert.strictEqual(r1.ok,false); assert.ok(/4 attempt/.test(r1.message));
    assert.strictEqual(A.api.attemptPinLogin(s2.id,"1111").ok,true,"the other staff member is unaffected");
  });
  await t("an inactive staff member can no longer sign in even with the right PIN", ()=>{
    const A = rig();
    const s = addStaff(A,{ name:"Tendai", pin:"4821" });
    A.api.saveStaffMember({ id:s.id, name:"Tendai", active:false, pin:"" });
    const res = A.api.attemptPinLogin(s.id,"4821");
    assert.strictEqual(res.ok,false); assert.ok(/no longer active/.test(res.message));
  });

  // ================= lockout =================
  await t("5 wrong PINs lock the account out; a 6th attempt (even the right PIN) is refused while locked", ()=>{
    const A = rig();
    const s = addStaff(A,{ name:"Tendai", pin:"4821" });
    let last;
    for(let i=0;i<A.api.PIN_MAX_ATTEMPTS;i++) last = A.api.attemptPinLogin(s.id,"0000");
    assert.strictEqual(last.ok,false); assert.strictEqual(last.locked,true); assert.ok(/Too many/.test(last.message));
    const stillLocked = A.api.attemptPinLogin(s.id,"4821");
    assert.strictEqual(stillLocked.ok,false); assert.strictEqual(stillLocked.locked,true);
  });
  await t("the lockout clears itself once its time is up", ()=>{
    const A = rig();
    const s = addStaff(A,{ name:"Tendai", pin:"4821" });
    for(let i=0;i<A.api.PIN_MAX_ATTEMPTS;i++) A.api.attemptPinLogin(s.id,"0000");
    assert.strictEqual(A.api.attemptPinLogin(s.id,"4821").locked,true);
    // simulate the cooldown having elapsed
    A.api.run("UPDATE staff SET pin_locked_until=? WHERE id=?",[new Date(Date.now()-1000).toISOString(), s.id]);
    const res = A.api.attemptPinLogin(s.id,"4821");
    assert.strictEqual(res.ok,true);
  });
  await t("a correct PIN resets the fail counter, so near-misses don't accumulate across sessions", ()=>{
    const A = rig();
    const s = addStaff(A,{ name:"Tendai", pin:"4821" });
    A.api.attemptPinLogin(s.id,"0000"); A.api.attemptPinLogin(s.id,"0000"); A.api.attemptPinLogin(s.id,"0000");
    assert.strictEqual(A.api.attemptPinLogin(s.id,"4821").ok,true);
    assert.strictEqual(A.api.one("SELECT pin_fail_count FROM staff WHERE id=?",[s.id]).pin_fail_count,0);
  });

  // ================= single operator mode =================
  await t("single operator mode is ON by default — nobody's workflow changes until they opt in", ()=>{
    const A = rig();
    assert.strictEqual(A.api.singleOperatorMode(),true);
    assert.strictEqual(A.api.getSetting("single_operator_mode",""),"", "no row written just by reading the default");
  });
  await t("existing single-user installs keep working unchanged after the upgrade", ()=>{
    // an "old" device: already set up, has an Admin row from before this feature existed
    // (no pin_hash/pin_salt/pin_fail_count/pin_locked_until columns touched), never
    // told about single_operator_mode at all.
    const A = makeApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1" });
    A.api.run("INSERT INTO staff(name,role,passcode,branch,active,created_ts) VALUES('Owner','Admin','9999','Boka',1,'x')");
    A.api.migrate(A.db); A.api.migrate(A.db); // idempotent, arrives safely on an old device
    assert.strictEqual(A.api.singleOperatorMode(),true);
    assert.strictEqual(A.api.activeStaffWithPin("Boka").length,0,"the legacy Admin row has no PIN, so it never appears in the new dropdown");
    assert.strictEqual(A.api.findAdmin("9999").name,"Owner","the untouched Admin passcode flow still works");
  });
  await t("turning single operator mode off is a Settings-level choice this module only reads", ()=>{
    const A = rig();
    addStaff(A,{ name:"Tendai", pin:"4821" });
    A.api.setSetting("single_operator_mode","0");
    assert.strictEqual(A.api.singleOperatorMode(),false);
    assert.strictEqual(A.api.activeStaffWithPin("Boka").length,1);
  });

  // ================= current operator queryable (Part 6) =================
  await t("the signed-in staff member is queryable by the rest of the app once set", ()=>{
    const A = rig();
    const s = addStaff(A,{ name:"Tendai", pin:"4821" });
    assert.strictEqual(A.api.currentStaff(),null,"nobody signed in via PIN yet");
    A.api.setSessionStaffId(s.id);
    assert.strictEqual(A.api.currentStaff().id,s.id);
    assert.strictEqual(A.api.currentStaff().name,"Tendai");
  });

  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed?1:0);
})();
