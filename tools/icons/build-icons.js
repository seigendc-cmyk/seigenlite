// node tools/icons/build-icons.js            -> assets/brand/generated/* (+ previews)
// node tools/icons/build-icons.js --tauri    -> also regenerates src-tauri/icons/
//
// Makes every app icon from assets/brand/globe-master.png (1254x1254 RGB,
// cream rounded tile, marble globe ~80% wide). The master is never changed.
// Image work runs in headless Chromium's canvas via Playwright (already a dev
// dependency), so no image library is needed. Re-runnable: outputs are
// overwritten each time.
//
// Large sizes are the master, resampled. Small sizes (<=48) are NOT the
// globe scaled down — at 48/32 the marble turns to noise and the bag pair to
// a blob — they're a separate flat drawing (FAVICON_* below).
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { ROOT, MASTER, OUT, withPage, render, rasterSvg, buildIco, pngInfo } = require("./lib");
const { measure } = require("./measure-master");

const PREVIEW = path.join(ROOT, "assets", "brand", "preview");   // gitignored contact sheets
const TAURI_ICONS = path.join(ROOT, "src-tauri", "icons");
const MASKABLE_BG = "#FFFAF6";          // manifest background_color, full bleed
const MASKABLE_GLOBE = 0.72;            // globe's larger diameter as a share of the canvas (safe zone = central 80%)
const TRANSPARENT_MARGIN = 4/1024;      // breathing room around the cut-out globe
const MASK_SHRINK = 1.5;                // px at master scale: keeps the cream outside the rim out of the cut-out
const MASK_FEATHER = 0.8;               // px blur on the mask edge = a 1–2 px anti-aliased edge
const TILE_RADIUS = 158/1254;           // the master's rounded-tile corner, measured (diagonal / top-edge probes)
const SHARPEN_192 = 0.35;               // light unsharp mask on the 192 only (see report); 0 = off

// ---------------- small-size art (drawn, not downscaled) ----------------
const CHARCOAL = "#2F343B", ORANGE = "#F55A00", CREAM = "#FDF8F0";
// (a) the bag pair alone on a cream rounded square
// Bodies taper (narrow top, wide bottom) with short handles and the front
// bag's swoosh, as in the master — square bodies with tall loops read as padlocks.
const FAVICON_A_32 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<rect x="0.5" y="0.5" width="31" height="31" rx="7" fill="${CREAM}" stroke="#E6D3BD"/>
<path d="M8.5 12.5V10.5a3 3 0 0 1 6 0v2" fill="none" stroke="${CHARCOAL}" stroke-width="2.2"/>
<path d="M6 12h11l1.5 15H4.5Z" fill="${CHARCOAL}" stroke="${CHARCOAL}" stroke-width="1" stroke-linejoin="round"/>
<path d="M17 15v-2a3 3 0 0 1 6 0v2" fill="none" stroke="${CREAM}" stroke-width="4.6"/>
<path d="M14 15h12l2 14H12Z" fill="${CREAM}" stroke="${CREAM}" stroke-width="3" stroke-linejoin="round"/>
<path d="M14 15h12l2 14H12Z" fill="${ORANGE}" stroke="${ORANGE}" stroke-width="1" stroke-linejoin="round"/>
<path d="M17 15v-2a3 3 0 0 1 6 0v2" fill="none" stroke="${ORANGE}" stroke-width="2.2"/>
<path d="M14.5 22q5.5 4.5 11 0" fill="none" stroke="#FFFFFF" stroke-width="1.7" stroke-linecap="round"/>
</svg>`;
// 16 px: whole-pixel rectangles only (stepped taper), so nothing lands between pixels
const FAVICON_A_16 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">
<rect x="0" y="0" width="16" height="16" rx="3" fill="${CREAM}"/>
<rect x="3" y="3" width="3" height="1" fill="${CHARCOAL}"/><rect x="3" y="4" width="1" height="2" fill="${CHARCOAL}"/><rect x="5" y="4" width="1" height="2" fill="${CHARCOAL}"/>
<rect x="2" y="6" width="5" height="2" fill="${CHARCOAL}"/><rect x="1" y="8" width="7" height="6" fill="${CHARCOAL}"/>
<rect x="7" y="7" width="8" height="3" fill="${CREAM}"/><rect x="6" y="9" width="10" height="7" fill="${CREAM}"/>
<rect x="10" y="5" width="2" height="1" fill="${ORANGE}"/><rect x="9" y="6" width="1" height="2" fill="${ORANGE}"/><rect x="12" y="6" width="1" height="2" fill="${ORANGE}"/>
<rect x="8" y="8" width="6" height="2" fill="${ORANGE}"/><rect x="7" y="10" width="8" height="5" fill="${ORANGE}"/>
<rect x="8" y="11" width="1" height="1" fill="#FFFFFF"/><rect x="9" y="12" width="4" height="1" fill="#FFFFFF"/><rect x="13" y="11" width="1" height="1" fill="#FFFFFF"/>
</svg>`;
// (b) an orange disc with a flat white Africa
const AFRICA_32 = "M10 6.5L14 5.5L18 6L20.5 7.5L22 7L23.5 10L26.5 12.5L25.5 14L23.5 16L23 19.5L21 22.5L19 26L17 27L15.5 25L15 21.5L13.5 18.5L13 17L10.5 17L8 15.5L6.5 13L7 10.5L8.5 8Z";
const FAVICON_B_32 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<circle cx="16" cy="16" r="15.5" fill="${ORANGE}"/>
<path d="${AFRICA_32}" fill="#FFFFFF"/><ellipse cx="25.5" cy="21.5" rx="1" ry="2.2" fill="#FFFFFF" transform="rotate(20 25.5 21.5)"/>
</svg>`;
const FAVICON_B_16 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<circle cx="16" cy="16" r="16" fill="${ORANGE}"/>
<path d="${AFRICA_32}" fill="#FFFFFF" transform="translate(16 16) scale(1.08) translate(-16 -16.5)"/>
</svg>`;
// Chosen after comparing both at 16/32/48 (contact sheet favicon-compare.png): see FAVICON_CHOICE.
const FAVICON_CHOICE = "a";
const FAV = FAVICON_CHOICE==="a"? { s32: FAVICON_A_32, s16: FAVICON_A_16 } : { s32: FAVICON_B_32, s16: FAVICON_B_16 };

// ---------------- canvas bodies (run in the page; see lib.render) ----------------
// Elliptical alpha cut-out of the globe at master resolution (the globe is
// drawn very slightly taller than wide: rx 503.5, ry 513 — a circle would
// either clip the rim top/bottom or keep cream slivers at the sides).
const CUT_GLOBE = `{
  const g = args.g, W = img.naturalWidth;
  const mask = document.createElement("canvas"); mask.width = W; mask.height = W;
  const mc = mask.getContext("2d"); mc.filter = "blur(" + args.feather + "px)";
  mc.beginPath(); mc.ellipse(g.cx, g.cy, g.rx - args.shrink, g.ry - args.shrink, 0, 0, Math.PI*2); mc.fill();
  const cut = document.createElement("canvas"); cut.width = W; cut.height = W;
  const cc = cut.getContext("2d"); cc.drawImage(img, 0, 0);
  cc.globalCompositeOperation = "destination-in"; cc.drawImage(mask, 0, 0);
  window.__cut = cut;
}`;
const GLOBE_ON = (bg)=> CUT_GLOBE + `
  const g = args.g, N = canvas.width;
  ${bg? `ctx.fillStyle = "${bg}"; ctx.fillRect(0, 0, N, N);` : ""}
  const bw = (g.rx*2), bh = (g.ry*2);
  const s = args.diameter * N / Math.max(bw, bh);
  const tw = Math.round(bw*s), th = Math.round(bh*s);
  const src = stepDown(window.__cut, g.cx - g.rx, g.cy - g.ry, Math.ceil(bw), Math.ceil(bh), tw, th);
  ctx.drawImage(src, 0, 0, src.width, src.height, (N - tw)/2, (N - th)/2, tw, th);
`;
// The full tile, resampled, with its rounded corners made transparent (the
// master has near-white outside the tile; on a dark launcher that would show
// as a white square behind the rounded tile).
const TILE = `
  const N = canvas.width;
  const src = stepDown(img, 0, 0, img.naturalWidth, img.naturalHeight, N, N);
  ctx.drawImage(src, 0, 0, src.width, src.height, 0, 0, N, N);
  ctx.globalCompositeOperation = "destination-in";
  const r = args.radius * N;
  ctx.beginPath(); ctx.roundRect(0, 0, N, N, r); ctx.fill();
  ctx.globalCompositeOperation = "source-over";
  if(args.sharpen > 0){
    const id = ctx.getImageData(0, 0, N, N), d = id.data, o = new Uint8ClampedArray(d);
    const k = args.sharpen;
    for(let y=1; y<N-1; y++) for(let x=1; x<N-1; x++){
      const i = (y*N + x)*4;
      for(let c=0; c<3; c++){
        const blur = (o[i-4+c] + o[i+4+c] + o[i-N*4+c] + o[i+N*4+c] + o[i+c]*4) / 8;
        d[i+c] = o[i+c] + k*(o[i+c] - blur);
      }
    }
    ctx.putImageData(id, 0, 0);
  }
`;

function write(name, buf){
  fs.mkdirSync(path.dirname(name), { recursive: true });
  fs.writeFileSync(name, buf);
  const i = pngInfo(buf);
  return { file: path.relative(ROOT, name).replace(/\\/g, "/"), size: i.width+"x"+i.height, bytes: buf.length };
}

async function main(){
  const doTauri = process.argv.includes("--tauri");
  const master = fs.readFileSync(MASTER);
  const report = [];
  await withPage(async (page)=>{
    const m = await measure(page, master);
    if(m.width!==1254 || m.height!==1254) throw new Error("unexpected master size "+m.width+"x"+m.height);
    // ellipse from the measured extent (outermost rim pixels)
    const g = { cx: (m.globe.minX + m.globe.maxX)/2, cy: (m.globe.minY + m.globe.maxY)/2, rx: m.globe.w/2, ry: m.globe.h/2 };
    const globeArgs = (diameter)=> ({ g, diameter, shrink: MASK_SHRINK, feather: MASK_FEATHER });
    const tile = (N, sharpen)=> render(page, master, N, N, TILE, { radius: TILE_RADIUS, sharpen: sharpen||0 });

    // 1. "any" icons: the full tile
    report.push(write(path.join(OUT, "icon-512.png"), await tile(512)));
    report.push(write(path.join(OUT, "icon-192.png"), await tile(192, SHARPEN_192)));
    // 2/3. maskable + apple-touch: full-bleed cream, globe inside the safe zone
    for(const N of [512, 192]) report.push(write(path.join(OUT, "icon-maskable-"+N+".png"), await render(page, master, N, N, GLOBE_ON(MASKABLE_BG), globeArgs(MASKABLE_GLOBE))));
    report.push(write(path.join(OUT, "apple-touch-icon.png"), await render(page, master, 180, 180, GLOBE_ON(MASKABLE_BG), globeArgs(MASKABLE_GLOBE))));
    // 4. transparent globe for the Start screen
    for(const N of [1024, 512]) report.push(write(path.join(OUT, "globe-transparent-"+N+".png"), await render(page, master, N, N, GLOBE_ON(null), globeArgs(1 - 2*TRANSPARENT_MARGIN))));
    // 5. small icons: drawn art
    fs.writeFileSync(path.join(OUT, "favicon.svg"), FAV.s32);
    report.push({ file: "assets/brand/generated/favicon.svg", size: "vector 32x32", bytes: Buffer.byteLength(FAV.s32) });
    const fav32 = await rasterSvg(page, FAV.s32, 32, 32), fav16 = await rasterSvg(page, FAV.s16, 16, 16), fav48 = await rasterSvg(page, FAV.s32, 48, 48);
    report.push(write(path.join(OUT, "favicon-32.png"), fav32));
    report.push(write(path.join(OUT, "favicon-16.png"), fav16));
    const ico = buildIco([{ size:16, buf:fav16 }, { size:32, buf:fav32 }, { size:48, buf:fav48 }]);
    fs.writeFileSync(path.join(OUT, "icon.ico"), ico);
    report.push({ file: "assets/brand/generated/icon.ico", size: "16, 32, 48", bytes: ico.length });
    // Tauri source: the tile at 1024 with transparent corners
    report.push(write(path.join(OUT, "tauri-source-1024.png"), await tile(1024)));

    // ---- previews (gitignored) ----
    fs.mkdirSync(PREVIEW, { recursive: true });
    const compare = {};
    for(const [k, s32, s16] of [["a", FAVICON_A_32, FAVICON_A_16], ["b", FAVICON_B_32, FAVICON_B_16]]){
      compare[k] = { 16: await rasterSvg(page, s16, 16, 16), 32: await rasterSvg(page, s32, 32, 32), 48: await rasterSvg(page, s32, 48, 48) };
    }
    // downscaled globe at small sizes, to show why they're not used
    const down = {}; for(const N of [48, 32, 16]) down[N] = await tile(N);
    await contactSheet(page, compare, down);

    // fringe check: average colour of the outermost opaque ring of the 1024 cut-out
    report.fringe = await page.evaluate(async (src)=>{
      const img = new Image(); await new Promise(r=>{ img.onload = r; img.src = src; });
      const N = img.naturalWidth, c = document.createElement("canvas"); c.width = N; c.height = N;
      const x = c.getContext("2d"); x.drawImage(img, 0, 0); const d = x.getImageData(0, 0, N, N).data;
      let r=0, gg=0, b=0, n=0;
      for(let yy=0; yy<N; yy++) for(let xx=0; xx<N; xx++){
        const i = (yy*N+xx)*4, a = d[i+3];
        if(a>=100 && a<=250){ r+=d[i]; gg+=d[i+1]; b+=d[i+2]; n++; }   // the anti-aliased edge band
      }
      return { edgePixels: n, avgRGB: [Math.round(r/n), Math.round(gg/n), Math.round(b/n)] };
    }, "data:image/png;base64,"+fs.readFileSync(path.join(OUT, "globe-transparent-1024.png")).toString("base64"));
  });

  if(doTauri) report.tauri = await tauriIcons();
  console.log(JSON.stringify({ files: report, fringe: report.fringe, tauri: report.tauri }, null, 1));
}

// One page showing every output at 1:1 and 4x, on light and dark.
async function contactSheet(page, compare, down){
  const b64 = (buf)=> "data:image/png;base64,"+buf.toString("base64");
  const f = (n)=> b64(fs.readFileSync(path.join(OUT, n)));
  const items = ["icon-512.png","icon-192.png","icon-maskable-512.png","icon-maskable-192.png","apple-touch-icon.png","globe-transparent-512.png","favicon-32.png","favicon-16.png"];
  const cell = (src, w, label, zoom)=> `<figure><img src="${src}" style="width:${w*(zoom||1)}px;height:auto;image-rendering:${zoom>1?"pixelated":"auto"}"><figcaption>${label}</figcaption></figure>`;
  const sizeOf = (n)=> ({ "icon-512.png":512, "icon-192.png":192, "icon-maskable-512.png":512, "icon-maskable-192.png":192, "apple-touch-icon.png":180, "globe-transparent-512.png":512, "favicon-32.png":32, "favicon-16.png":16 })[n];
  const row = (bg, fg)=> `<section style="background:${bg};color:${fg}">
    ${items.map(n=> cell(f(n), Math.min(sizeOf(n), 192), n+" (1:1"+(sizeOf(n)>192?" shown at 192":"")+")")).join("")}
    ${["favicon-32.png","favicon-16.png"].map(n=> cell(f(n), sizeOf(n), n+" ×4", 4)).join("")}
  </section>`;
  // maskable safe-zone preview: circle (Android) and squircle masks + the 80% zone
  const mask = (shape)=> `<figure><div style="width:192px;height:192px;overflow:hidden;border-radius:${shape};position:relative">
      <img src="${f("icon-maskable-512.png")}" style="width:192px;height:192px">
      <div style="position:absolute;inset:19.2px;border-radius:50%;outline:1px dashed #0a0"></div></div><figcaption>maskable, mask ${shape}, dashed = 80% safe zone</figcaption></figure>`;
  const cmp = (bg, fg)=> `<section style="background:${bg};color:${fg}">${["a","b"].map(k=>[16,32,48].map(s=>
      cell(b64(compare[k][s]), s, "("+k+") "+s+" 1:1") + cell(b64(compare[k][s]), s, "("+k+") "+s+" ×4", 4)).join("")).join("")}
    ${[48,32,16].map(s=> cell(b64(down[s]), s, "globe downscaled "+s+" ×4", 4)).join("")}</section>`;
  const html = `<!doctype html><html><head><style>
    body{margin:0;font:12px system-ui} section{display:flex;flex-wrap:wrap;gap:18px;align-items:flex-end;padding:16px}
    figure{margin:0;text-align:center} figcaption{margin-top:4px;opacity:.8;max-width:200px}
  </style></head><body>
    <h3 style="margin:12px 16px">Generated icons — light / dark</h3>${row("#ffffff","#222")}${row("#1d1d1f","#eee")}
    <h3 style="margin:12px 16px">Maskable safe zone</h3><section>${mask("50%")}${mask("22%")}${mask("0")}</section>
    <h3 style="margin:12px 16px">Favicon options (a) bag pair, (b) Africa — and the globe downscaled</h3>${cmp("#ffffff","#222")}${cmp("#1d1d1f","#eee")}
  </body></html>`;
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.setContent(html);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(PREVIEW, "contact-sheet.png"), fullPage: true });
}

// Tauri: `cargo tauri icon` from the 1024 tile (large sizes = the globe), then
// the small Windows sizes are replaced with the flat favicon art.
async function tauriIcons(){
  const src = path.join(OUT, "tauri-source-1024.png");
  execFileSync("cargo", ["tauri", "icon", src, "-o", TAURI_ICONS], { cwd: path.join(ROOT, "src-tauri"), stdio: "pipe" });
  const out = { generatedBy: "cargo tauri icon", replacedWithFlatArt: [] };
  await withPage(async (page)=>{
    const flat = async (n)=> n<=16? rasterSvg(page, FAV.s16, n, n) : rasterSvg(page, FAV.s32, n, n);
    // PNGs Tauri lists at small sizes
    for(const [file, n] of [["32x32.png", 32], ["Square30x30Logo.png", 30], ["Square44x44Logo.png", 44]]){
      if(fs.existsSync(path.join(TAURI_ICONS, file))){ fs.writeFileSync(path.join(TAURI_ICONS, file), await flat(n)); out.replacedWithFlatArt.push(file); }
    }
    // icon.ico: 16/24/32 flat art; 48/64/256 from the globe tile
    const tileAt = (n)=> render(page, fs.readFileSync(MASTER), n, n, TILE, { radius: TILE_RADIUS, sharpen: 0 });
    const ico = buildIco([{ size:16, buf: await flat(16) }, { size:24, buf: await flat(24) }, { size:32, buf: await flat(32) },
      { size:48, buf: await tileAt(48) }, { size:64, buf: await tileAt(64) }, { size:256, buf: await tileAt(256) }]);
    fs.writeFileSync(path.join(TAURI_ICONS, "icon.ico"), ico);
    out.replacedWithFlatArt.push("icon.ico (16, 24, 32; 48/64/256 = globe)");
  });
  return out;
}

if(require.main === module) main().catch(e=>{ console.error(e); process.exit(1); });
module.exports = { FAVICON_A_32, FAVICON_A_16, FAVICON_B_32, FAVICON_B_16, FAVICON_CHOICE };
