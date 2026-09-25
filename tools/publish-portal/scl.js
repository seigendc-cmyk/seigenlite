// Reading a vendor's .scl marketing export (written by src/marketing.js,
// format "seigen.market_export" v1) for the publish portal. The file came in
// over WhatsApp, so everything in it is untrusted: this checks the shape,
// the checksum the app stamped on it, every field against what
// vendor_listings will accept, and that each photo really is a WebP image.
// Pure — no network, no Supabase.
"use strict";
const crypto = require("crypto");

const FORMAT = "seigen.market_export";
const FORMAT_VERSION = 1;
const MAX_PRODUCTS = 200;              // src/marketing.js MARKET_MAX_PRODUCTS
const IMAGE_PREFIX = "data:image/webp;base64,";
const MAX_IMAGE_CHARS = 150000;        // src/marketing.js MARKET_MAX_IMAGE_CHARS
const MAX_FILE_BYTES = 40 * 1024 * 1024;

const sha256 = (s)=> crypto.createHash("sha256").update(s).digest("hex");
const isObj = (v)=> v && typeof v === "object" && !Array.isArray(v);
const str = (v)=> typeof v === "string" ? v.trim() : "";

// The app's checksum: sha256 of the JSON text of the document before the
// checksum key was added. JSON.parse keeps key order, so re-stringifying the
// parsed object without it gives back that exact text.
function checksumOf(doc){
  const copy = Object.assign({}, doc);
  delete copy.checksum;
  return sha256(JSON.stringify(copy));
}

// A photo is a data URI holding a real WebP file (RIFF....WEBP header).
function decodeImage(v){
  if(v === null || v === undefined) return { bytes: null, problem: null };
  if(typeof v !== "string" || v.indexOf(IMAGE_PREFIX) !== 0) return { bytes: null, problem: "photo isn't a WebP image" };
  if(v.length > MAX_IMAGE_CHARS) return { bytes: null, problem: "photo is too large" };
  const b64 = v.slice(IMAGE_PREFIX.length);
  if(!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return { bytes: null, problem: "photo data is damaged" };
  const bytes = Buffer.from(b64, "base64");
  if(bytes.length < 16 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP")
    return { bytes: null, problem: "photo data isn't a WebP file" };
  return { bytes, problem: null };
}

function checkVendor(v){
  const problems = [];
  if(!isObj(v)) return { vendor: null, problems: ["the file has no vendor details"] };
  const vendor = {
    install_id: str(v.install_id),
    business_name: str(v.business_name).replace(/\s+/g, " "),
    whatsapp_number: str(v.whatsapp_number) || null,
    city: str(v.city).replace(/\s+/g, " ") || null,
  };
  if(!vendor.install_id) problems.push("the vendor has no install ID");
  else if(vendor.install_id.length > 100) problems.push("the install ID is too long");
  if(!vendor.business_name) problems.push("the vendor has no business name");
  else if(vendor.business_name.length > 200) problems.push("the business name is too long");
  if(vendor.whatsapp_number && vendor.whatsapp_number.length > 40) problems.push("the WhatsApp number is too long");
  if(vendor.city && vendor.city.length > 60) problems.push("the city is too long");
  return { vendor, problems };
}

// One listing -> the row it would become, plus anything that stops it being
// published (problems) or is worth a look (notes).
function checkListing(l, i, seen){
  const problems = [], notes = [];
  if(!isObj(l)) return { index: i, problems: ["not a product entry"], notes, row: null, image: null };
  const num = (v)=> typeof v === "number" && Number.isFinite(v) ? v : NaN;
  const row = {
    source_product_id: l.source_product_id == null ? "" : String(l.source_product_id).trim(),
    product_name: str(l.product_name).replace(/\s+/g, " "),
    price: Math.round(num(l.price) * 100) / 100,
    currency: str(l.currency).toUpperCase(),
    category: str(l.category) || null,
    stock_quantity: Math.round(num(l.stock_quantity) * 1000) / 1000,
    exported_at: str(l.exported_at),
  };
  if(!row.source_product_id) problems.push("no product ID");
  else if(seen.has(row.source_product_id)) problems.push("same product ID as an earlier item in this file");
  else seen.add(row.source_product_id);
  if(!row.product_name) problems.push("no name");
  else if(row.product_name.length > 200) problems.push("name is too long");
  if(!Number.isFinite(row.price) || row.price < 0) problems.push("price is missing or negative");
  else if(row.price === 0) notes.push("price is 0");
  if(!/^[A-Z]{3}$/.test(row.currency)) problems.push("currency isn't a 3-letter code");
  if(!Number.isFinite(row.stock_quantity) || row.stock_quantity < 0) problems.push("stock is missing or negative");
  else if(row.stock_quantity === 0) notes.push("out of stock");
  if(row.category && row.category.length > 100) problems.push("category is too long");
  if(!row.exported_at || isNaN(Date.parse(row.exported_at))) problems.push("export date is missing");
  const img = decodeImage(l.image_webp);
  if(img.problem) notes.push(img.problem + " — it would be published without a photo");
  else if(!img.bytes) notes.push("no photo");
  return { index: i, problems, notes, row, image: img.bytes };
}

// text -> { ok, fileProblems[], doc, vendor, vendorProblems[], items[] }
// fileProblems block the whole file; an item's problems block only it.
function parseScl(text){
  const fail = (msg)=> ({ ok: false, fileProblems: [msg], vendor: null, vendorProblems: [], items: [] });
  if(typeof text !== "string" || !text.trim()) return fail("The file is empty.");
  if(Buffer.byteLength(text) > MAX_FILE_BYTES) return fail("The file is too large to be a marketing export.");
  let doc;
  try{ doc = JSON.parse(text); }catch(e){ return fail("This isn't a marketing export (.scl) file — it isn't readable JSON."); }
  if(!isObj(doc) || doc.format !== FORMAT) return fail("This isn't a marketing export (.scl) file.");
  if(doc.format_version !== FORMAT_VERSION) return fail(`This file is format version ${doc.format_version}; the portal reads version ${FORMAT_VERSION}. Update the portal.`);
  const fileProblems = [];
  if(typeof doc.checksum !== "string" || checksumOf(doc) !== doc.checksum)
    fileProblems.push("The file's checksum doesn't match its contents — it was changed or damaged after the app made it. Ask the vendor to send it again.");
  if(!Array.isArray(doc.listings) || !doc.listings.length) fileProblems.push("The file has no products.");
  else if(doc.listings.length > MAX_PRODUCTS) fileProblems.push(`The file has ${doc.listings.length} products; the most a vendor can send is ${MAX_PRODUCTS}.`);
  const { vendor, problems: vendorProblems } = checkVendor(doc.vendor);
  const seen = new Set();
  const items = Array.isArray(doc.listings) ? doc.listings.slice(0, MAX_PRODUCTS).map((l, i)=> checkListing(l, i, seen)) : [];
  return {
    ok: !fileProblems.length && !vendorProblems.length,
    fileProblems, vendor, vendorProblems, items,
    exportNo: str(doc.export_no), createdIso: str(doc.created_iso), exportedAt: str(doc.exported_at),
  };
}

module.exports = { parseScl, checksumOf, decodeImage, FORMAT, FORMAT_VERSION, IMAGE_PREFIX, MAX_PRODUCTS };
