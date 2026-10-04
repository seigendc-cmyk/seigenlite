// Shared helpers for tools/icons: a headless Chromium (Playwright, already a
// dev dependency) used as the image engine, so no image library is needed.
// Every function takes/returns PNG bytes as Buffers.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const MASTER = path.join(ROOT, "assets", "brand", "globe-master.png");
const OUT = path.join(ROOT, "assets", "brand", "generated");

async function withPage(fn){
  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  try{
    const page = await browser.newPage();
    await page.setContent("<!doctype html><html><body></body></html>");
    return await fn(page);
  } finally { await browser.close(); }
}
const dataUrl = (buf, mime)=> "data:"+(mime||"image/png")+";base64,"+buf.toString("base64");
const fromDataUrl = (u)=> Buffer.from(u.split(",")[1], "base64");

// Runs `body` (a function source string taking (ctx, canvas, img, args)) in
// the page with the master loaded; returns the canvas as PNG bytes.
async function render(page, srcBuf, w, h, body, args){
  const out = await page.evaluate(async ({ src, w, h, body, args })=>{
    const img = new Image();
    await new Promise((res, rej)=>{ img.onload = res; img.onerror = rej; img.src = src; });
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    // high-quality downscale: halve in steps until within 2x of the target
    window.stepDown = (source, sx, sy, sw, sh, tw, th)=>{
      let cur = document.createElement("canvas"), cw = sw, ch = sh;
      cur.width = sw; cur.height = sh;
      const c0 = cur.getContext("2d"); c0.imageSmoothingQuality = "high";
      c0.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);
      while(cw/2 >= tw && ch/2 >= th){
        const nx = document.createElement("canvas");
        nx.width = Math.round(cw/2); nx.height = Math.round(ch/2);
        const c = nx.getContext("2d"); c.imageSmoothingQuality = "high";
        c.drawImage(cur, 0, 0, nx.width, nx.height);
        cur = nx; cw = nx.width; ch = nx.height;
      }
      return cur;
    };
    await (new Function("ctx","canvas","img","args", "return (async()=>{"+body+"})()"))(ctx, canvas, img, args);
    return canvas.toDataURL("image/png");
  }, { src: dataUrl(srcBuf), w, h, body, args: args||{} });
  return fromDataUrl(out);
}

// Rasterise an SVG string at w×h (1:1, no smoothing tricks: what a browser tab shows).
async function rasterSvg(page, svg, w, h){
  const out = await page.evaluate(async ({ svg, w, h })=>{
    const img = new Image();
    await new Promise((res, rej)=>{ img.onload = res; img.onerror = rej; img.src = "data:image/svg+xml;base64,"+btoa(svg); });
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    c.getContext("2d").drawImage(img, 0, 0, w, h);
    return c.toDataURL("image/png");
  }, { svg, w, h });
  return fromDataUrl(out);
}

// Windows .ico holding PNG-encoded images (supported since Vista; what browsers and Tauri read).
function buildIco(pngs){   // pngs: [{ size, buf }]
  const header = Buffer.alloc(6); header.writeUInt16LE(0,0); header.writeUInt16LE(1,2); header.writeUInt16LE(pngs.length,4);
  const dir = Buffer.alloc(16*pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach((p, i)=>{
    const o = i*16;
    dir.writeUInt8(p.size>=256?0:p.size, o); dir.writeUInt8(p.size>=256?0:p.size, o+1);
    dir.writeUInt8(0, o+2); dir.writeUInt8(0, o+3);
    dir.writeUInt16LE(1, o+4); dir.writeUInt16LE(32, o+6);
    dir.writeUInt32LE(p.buf.length, o+8); dir.writeUInt32LE(offset, o+12);
    offset += p.buf.length;
  });
  return Buffer.concat([header, dir, ...pngs.map(p=>p.buf)]);
}
// PNG width/height/colour type straight from the IHDR chunk.
function pngInfo(buf){
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bitDepth: buf[24], colorType: buf[25] };
}

module.exports = { ROOT, MASTER, OUT, withPage, render, rasterSvg, buildIco, pngInfo, dataUrl, fromDataUrl };
