// node tools/icons/measure-master.js
// Re-measures assets/brand/globe-master.png: size, colour type, tile colour,
// and the globe's extent (pixels that differ clearly from the cream tile,
// inside the tile's rounded square), plus a best-fit circle from the
// globe's outer orange rim. Prints JSON; build-icons.js uses the same logic.
"use strict";
const fs = require("fs");
const { MASTER, withPage, dataUrl, pngInfo } = require("./lib");

async function measure(page, buf){
  return page.evaluate(async (src)=>{
    const img = new Image();
    await new Promise((res, rej)=>{ img.onload = res; img.onerror = rej; img.src = src; });
    const W = img.naturalWidth, H = img.naturalHeight;
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, W, H).data;
    const px = (x, y)=>{ const i = (y*W+x)*4; return [d[i], d[i+1], d[i+2], d[i+3]]; };
    // tile colour: median of a ring of samples well inside the tile corners but outside the globe
    const samples = [[60,600],[1194,600],[600,40],[600,1214],[80,80+40],[1170,120]].map(([x,y])=>px(x,y));
    const tile = [0,1,2].map(k=> Math.round(samples.map(s=>s[k]).sort((a,b)=>a-b)[Math.floor(samples.length/2)]));
    const far = (p)=> Math.abs(p[0]-tile[0]) + Math.abs(p[1]-tile[1]) + Math.abs(p[2]-tile[2]) > 60;
    // orange-ish = the globe rim / land colour (R high, B low)
    let minX=W, maxX=0, minY=H, maxY=0;
    for(let y=20; y<H-20; y++) for(let x=20; x<W-20; x++){
      const p = px(x,y);
      if(far(p) && p[0]>180 && p[2]<140){ if(x<minX)minX=x; if(x>maxX)maxX=x; if(y<minY)minY=y; if(y>maxY)maxY=y; }
    }
    // rim radius per row: farthest orange pixel left/right of the centre, along the horizontal & vertical diameters
    const cx = (minX+maxX)/2, cy = (minY+maxY)/2;
    let alpha = true; for(let i=3; i<d.length; i+=4) if(d[i]!==255){ alpha=false; break; }
    return { width: W, height: H, opaque: alpha, tile, tileHex: "#"+tile.map(v=>v.toString(16).padStart(2,"0")).join("").toUpperCase(),
      globe: { minX, maxX, minY, maxY, cx, cy, w: maxX-minX+1, h: maxY-minY+1, rx: (maxX-minX+1)/2, ry: (maxY-minY+1)/2,
        widthPct: Math.round((maxX-minX+1)/W*1000)/10 } };
  }, dataUrl(buf));
}
module.exports = { measure };

if(require.main === module){
  (async()=>{
    const buf = fs.readFileSync(MASTER);
    const info = pngInfo(buf);
    const m = await withPage(page=> measure(page, buf));
    console.log(JSON.stringify(Object.assign({ file: MASTER, bytes: buf.length, pngColorType: info.colorType, pngColorTypeName: ({0:"gray",2:"RGB",3:"palette",4:"gray+alpha",6:"RGBA"})[info.colorType] }, m), null, 1));
  })().catch(e=>{ console.error(e); process.exit(1); });
}
