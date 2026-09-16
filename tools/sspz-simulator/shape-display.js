// Shared manuscript-style density view. Derived display only; native SSP and
// widths stay in the numerical result. At most two axial panels or one FBP panel.
globalThis.SSPZShapeDisplay = (() => {
  const exponent = 0.35;
  const intensity = fraction => Math.round(255 * Math.max(0, Math.min(1, fraction)) ** exponent);
  function ticks(lo, hi, target = 6) {
    const raw = (hi - lo) / target, unit = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map(v => v * unit).find(v => v >= raw - 1e-12);
    const out = [];
    for (let i = Math.ceil(lo / step - 1e-9); i <= Math.floor(hi / step + 1e-9); i++) out.push(Number((i * step).toPrecision(12)));
    return out;
  }
  function fromFdk(result) {
    const groups = result.reference ? [['CBA', result, [1, 0, 0]], ['RRI', result.reference, [0, 0, 1]]] : [[result.model?.kind==='rri'?'RRI':'FDK', result, [1, 0, 0]]];
    return groups.map(([name, r, rgb]) => {
      const z = r.z, count = r.profiles.length, values = new Float64Array(z.length * count);
      r.profiles.forEach((p, i) => values.set(p.profile, i * z.length));
      const a = SSPZShape.analyze({ z, zCount: z.length, stateCount: count, data: { final: values, coverage: new Float64Array(count).fill(1) } }, 'data');
      return { name, rgb, analysis: a };
    });
  }
  function draw(canvas, groups, { title = '', panel = '', span = null } = {}) {
    const ctx = canvas.getContext('2d'), scale = canvas.width / 1000, height = canvas.height / scale;
    ctx.save(); ctx.scale(scale, scale); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1000, height);
    const b = { left: 145, right: 965, top: 78 + 63 * groups.length, bottom: height - 218 };
    const domain = Math.min(...groups.map(g => Math.min(-g.analysis.x[0], g.analysis.x.at(-1))));
    const maxWidth = Math.max(...groups.flatMap(g => g.analysis.fwhm));
    const requested = span ?? (maxWidth <= 2 ? 1.5 : Math.max(4, Math.ceil(maxWidth * .8 - 1e-9)));
    span = Math.min(domain, Math.max(requested, maxWidth * .55));
    if (!(span > 0)) throw new Error('No bilateral common support for the aligned shape view.');
    const limit = Math.max(...groups.map(g => -g.analysis.low));
    const x = v => b.left + (v + span) / (2 * span) * (b.right - b.left);
    const y = v => b.bottom - (v + limit) / (2 * limit) * (b.bottom - b.top);
    const xt = ticks(-span, span, span >= 3 ? 8 : 6), yt = ticks(-limit, limit);
    // Histogram cells are discrete and are never spatially smoothed. Composite
    // channels use the same fraction mapping and add only different source hues.
    const step = groups[0].analysis.step, width = groups[0].analysis.width;
    const start = Math.ceil(Math.max(-span, ...groups.map(g => g.analysis.x[0])) / step - 1e-8);
    const stop = Math.floor(Math.min(span, ...groups.map(g => g.analysis.x.at(-1))) / step + 1e-8);
    const nx = stop - start + 1, ny = Math.round(2 * limit / width);
    const temp = document.createElement('canvas'); temp.width = nx; temp.height = ny;
    const tc = temp.getContext('2d'), im = tc.createImageData(nx, ny);
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
      const rgb = [0, 0, 0], z = (start + i) * step, value = -limit + (j + .5) * width;
      for (const g of groups) {
        const a = g.analysis, ix = Math.round((z - a.x[0]) / step), iy = Math.floor((value - a.low) / width + 1e-8);
        if (ix < 0 || ix >= a.x.length || iy < 0 || iy >= a.bins) continue;
        const v = intensity(a.hist[ix * a.bins + iy]);
        g.rgb.forEach((c, k) => { rgb[k] += c * v; });
      }
      im.data.set([...rgb.map(v => Math.min(255, v)), 255], 4 * ((ny - 1 - j) * nx + i));
    }
    tc.putImageData(im, 0, 0);
    ctx.save(); ctx.beginPath(); ctx.rect(b.left, b.top, b.right - b.left, b.bottom - b.top); ctx.clip();
    ctx.fillStyle = '#000'; ctx.fillRect(b.left, b.top, b.right - b.left, b.bottom - b.top);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(temp, x((start - .5) * step), b.top, x((stop + .5) * step) - x((start - .5) * step), b.bottom - b.top);
    ctx.strokeStyle = 'rgba(255,255,255,.34)'; ctx.lineWidth = 1; ctx.setLineDash([4, 6]);
    // Guides follow the labeled ticks on both axes, including zero. They are
    // display overlays; histogram values and the adaptive domain are unchanged.
    ctx.beginPath();
    for (const v of xt) { ctx.moveTo(x(v), b.top); ctx.lineTo(x(v), b.bottom); }
    for (const v of yt) { ctx.moveTo(b.left, y(v)); ctx.lineTo(b.right, y(v)); }
    ctx.stroke(); ctx.restore();
    ctx.strokeStyle = '#111'; ctx.lineWidth = 1.8; ctx.strokeRect(b.left, b.top, b.right - b.left, b.bottom - b.top);
    ctx.font = '30px Arial'; ctx.fillStyle = '#111';
    for (const v of xt) {
      ctx.beginPath(); ctx.moveTo(x(v), b.bottom); ctx.lineTo(x(v), b.bottom + 9); ctx.stroke();
      ctx.textAlign = 'center'; ctx.fillText(Math.abs(v) < 1e-9 ? '0' : String(v), x(v), b.bottom + 39);
    }
    for (const v of yt) {
      ctx.beginPath(); ctx.moveTo(b.left - 9, y(v)); ctx.lineTo(b.left, y(v)); ctx.stroke();
      ctx.textAlign = 'right'; ctx.fillText(Math.abs(v) < 1e-9 ? '0' : v.toFixed(2), b.left - 16, y(v) + 10);
    }
    ctx.font = '34px Arial'; ctx.textAlign = 'center'; ctx.fillText('z position (mm)', (b.left + b.right) / 2, b.bottom + 83);
    ctx.save(); ctx.translate(39, (b.top + b.bottom) / 2); ctx.rotate(-Math.PI / 2); ctx.fillText('SSPz − mean', 0, 0); ctx.restore();
    ctx.font = 'bold 32px Arial'; ctx.textAlign = 'left'; ctx.fillText(panel, 18, 36);
    ctx.font = '30px Arial'; ctx.textAlign = 'center'; ctx.fillText(title, (b.left + b.right) / 2, 39);
    groups.forEach((g, i) => {
      const w = g.analysis.fwhm, mean = w.reduce((s, v) => s + v, 0) / w.length;
      const sd = w.length > 1 ? Math.sqrt(w.reduce((s, v) => s + (v - mean) ** 2, 0) / (w.length - 1)) : null;
      const color = g.rgb.every(v => v === 1) ? '#444' : `rgb(${g.rgb.map(v => Math.round(v * 180)).join(',')})`, yy = 106 + 63 * i;
      ctx.fillStyle = color; ctx.font = '28px Arial'; ctx.textAlign = 'center';
      const stats = sd === null ? `${mean.toFixed(2)} mm` : sd < .001 ? `${mean.toFixed(2)} mm; SD < 0.001 mm` : `${mean.toFixed(2)} ± ${sd.toFixed(3)} mm`;
      ctx.fillText(`${g.name}: FWHM ${stats}`, (b.left + b.right) / 2, yy - 17);
      ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(x(-mean / 2), yy); ctx.lineTo(x(mean / 2), yy);
      for (const [v, d] of [[-mean / 2, 1], [mean / 2, -1]]) { ctx.moveTo(x(v) + d * 10, yy - 5); ctx.lineTo(x(v), yy); ctx.lineTo(x(v) + d * 10, yy + 5); }
      ctx.stroke();
      // Short ticks above the plot align the arrow ends with the z axis without
      // drawing vertical lines through (or anchoring) the observed distribution.
      ctx.lineWidth = 1.2;
      for (const v of [-mean / 2, mean / 2]) { ctx.beginPath(); ctx.moveTo(x(v), b.top - 7); ctx.lineTo(x(v), b.top); ctx.stroke(); }
      const gap = 75, bw = ((b.right - b.left) - gap * (groups.length - 1)) / groups.length;
      const bx = b.left + i * (bw + gap), by = height - 82;
      ctx.font = '28px Arial'; ctx.fillStyle = '#111'; ctx.fillText(g.name, bx + bw / 2, by - 13);
      const lut = document.createElement('canvas'); lut.width = 256; lut.height = 1;
      const lc = lut.getContext('2d'), pixels = lc.createImageData(256, 1);
      for (let k = 0; k < 256; k++) pixels.data.set([...g.rgb.map(c => c * intensity(k / 255)), 255], 4 * k);
      lc.putImageData(pixels, 0, 0); ctx.imageSmoothingEnabled = false; ctx.drawImage(lut, bx, by, bw, 19);
      ctx.strokeStyle = '#111'; ctx.lineWidth = 1; ctx.strokeRect(bx, by, bw, 19);
      ctx.font = '24px Arial'; ctx.fillStyle = '#111';
      for (const v of [0, 25, 50, 75, 100]) ctx.fillText(String(v), bx + bw * v / 100, by + 46);
    });
    ctx.fillStyle = '#111'; ctx.font = '26px Arial'; ctx.fillText('Fraction per bin (%)', (b.left + b.right) / 2, height - 12);
    ctx.restore();
    canvas.dataset.intensityExponent = String(exponent);
    canvas.dataset.alignment = 'native-fwhm-midpoint-translation-only';
    canvas.dataset.xTicks = JSON.stringify(xt); canvas.dataset.yTicks = JSON.stringify(yt);
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `${title}. ${groups.map(g => `${g.name}: ${g.analysis.valid.length} profiles`).join('; ')}. SSPz minus each group mean, native FWHM midpoints aligned to zero. Arrows show mean individual FWHM. Fraction per bin intensity power ${exponent}.`);
  }
  return { draw, fromFdk, intensity, ticks, exponent };
})();
