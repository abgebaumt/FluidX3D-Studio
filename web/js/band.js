/**
 * Bottom instrument band.
 *
 * Nine read-outs that answer the two questions asked before every run: does it
 * fit into the GPU, and is it going to stay stable. The traffic light on
 * τ − ½ knows about SUBGRID, because with the LES model a τ that sits on 0.5
 * is expected rather than fatal.
 */
import { state } from "./state.js";
import { derive, nf, ni, sci, bigCells, dur } from "./derive.js";

const WARN_FRACTION = 0.82;
const CRIT_FRACTION = 0.94;
const TAU_FLOOR = 5e-4;

export function renderBand() {
  const band = document.getElementById("band");
  if (!band) return;
  const gpu = (state.health && state.health.gpu) || {};
  const d = derive(state.config, gpu);
  band.textContent = "";

  const tauMargin = d.tau - 0.5;
  const subgrid = (state.config.solver.extensions || []).includes("SUBGRID");
  const tauClass = tauMargin < TAU_FLOOR ? (subgrid ? "warn" : "crit") : "ok";

  band.append(
    cell("Grid", `${d.Nx}×${d.Ny}×${d.Nz}`),
    cell("Cells", bigCells(d.N)),
    cell("Cell size", nf(d.cell * 100, 2), null, " cm"),
    cell("Reynolds", sci(d.Re)),
    cell("τ − ½", sci(tauMargin), tauClass),
    cell("Time step", sci(d.dt), null, " s"),
    cell("Throughput", ni(d.mlups), null, " MLUPs"),
    cell("1 s real time", dur(d.secPerSimSec)),
    memoryCell(d, gpu)
  );
}

/* ==================================================================== pieces */

function cell(key, value, cls, small) {
  const c = el("div", "cell");
  c.appendChild(el("k", null, key));
  const v = el("v", cls || null, value);
  if (small) v.appendChild(el("small", null, small));
  c.appendChild(v);
  return c;
}

function memoryCell(d, gpu) {
  const total = d.gpuVramMB;
  const fraction = total > 0 ? d.vramMB / total : 0;
  const cls = fraction > CRIT_FRACTION ? "crit" : fraction > WARN_FRACTION ? "warn" : "";

  const c = el("div", "cell grow");
  const name = gpu.name || "unknown GPU";
  c.appendChild(el("k", null, `GPU memory · ${name}, ${nf(total / 1024, 0)} GB`));

  const v = el("v", cls || null, nf(d.vramMB / 1024, 2) + " GB");
  v.appendChild(el("small", null, ` of ${nf(total / 1024, 2)} GB · ${nf(fraction * 100, 0)} %`));
  c.appendChild(v);

  const meter = el("div", "meter");
  const bar = el("i", cls || null);
  bar.style.width = Math.min(100, Math.max(0, fraction * 100)) + "%";
  const tick = el("div", "tick");
  tick.style.left = WARN_FRACTION * 100 + "%";
  meter.append(bar, tick);
  c.appendChild(meter);

  const labels = el("div", "meter-labels");
  labels.append(
    el("span", null, "0"),
    el("span", null,
      fraction > CRIT_FRACTION ? "Does not fit — lower the VRAM target or shrink the box"
        : fraction > WARN_FRACTION ? "tight — nothing else may use the GPU"
          : "headroom available"),
    el("span", null, nf(total / 1024, 0) + " GB")
  );
  c.appendChild(labels);
  return c;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}
