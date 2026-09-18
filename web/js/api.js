/**
 * HTTP client — one function per endpoint of CONTRACT.md section 3.
 *
 * Every failure surfaces as an Error carrying the message the server sent; `err.status` holds the HTTP status where there was one (409 means a
 * job is already running).
 */

const BASE = "/api";

/* ==================================================================== plumbing */

async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(BASE + path, options);
  } catch {
    throw fail("Server unreachable — is \"npm start\" running?", 0);
  }

  const text = await res.text().catch(() => "");
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = null; }
  }

  if (!res.ok) {
    const msg = body && typeof body.error === "string"
      ? body.error
      : `Server error ${res.status} on ${path}.`;
    throw fail(msg, res.status);
  }
  return body;
}

function fail(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const json = (method, body) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body)
});

const seg = v => encodeURIComponent(String(v));

/* ====================================================================== health */

/** `{ ok, node, platform, fluidx3dPath, fluidx3dFound, exeExists, solverInstalled, hasMsbuild, gpu }` */
export function health() {
  return request("/health");
}

/* ========================================================================= stl */

/** `[{ id, name, file, sizeBytes, triangles, bbox:{min,max}, uploadedAt }]` */
export function listStl() {
  return request("/stl");
}

/**
 * Uploads one STL file. `onProgress` receives 0 … 1 while the body is sent.
 * Resolves with the new index entry.
 */
export function uploadStl(file, onProgress) {
  return new Promise((resolve, reject) => {
    if (!file) { reject(fail("No file selected.", 0)); return; }

    const form = new FormData();
    form.append("file", file, file.name);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", BASE + "/stl");

    if (typeof onProgress === "function") {
      xhr.upload.addEventListener("progress", e => {
        if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
      });
    }

    xhr.addEventListener("load", () => {
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch { body = null; }
      if (xhr.status >= 200 && xhr.status < 300) {
        if (body) resolve(body);
        else reject(fail("The server sent no valid response to the upload.", xhr.status));
      } else {
        const msg = body && typeof body.error === "string"
          ? body.error
          : `Upload failed (status ${xhr.status}).`;
        reject(fail(msg, xhr.status));
      }
    });
    xhr.addEventListener("error", () => reject(fail("Upload failed — server unreachable.", 0)));
    xhr.addEventListener("abort", () => reject(fail("Upload aborted.", 0)));

    xhr.send(form);
  });
}

export function deleteStl(id) {
  return request(`/stl/${seg(id)}`, { method: "DELETE" });
}

/** URL of the raw bytes; the viewport loads the geometry from here. */
export function stlRawUrl(id) {
  return `${BASE}/stl/${seg(id)}/raw`;
}

/** Raw STL bytes as an ArrayBuffer, for the STLLoader. */
export async function fetchStl(id) {
  let res;
  try {
    res = await fetch(stlRawUrl(id));
  } catch {
    throw fail("Server unreachable — the geometry could not be loaded.", 0);
  }
  if (!res.ok) {
    let msg = `The geometry could not be loaded (status ${res.status}).`;
    try {
      const body = await res.json();
      if (body && typeof body.error === "string") msg = body.error;
    } catch { /* raw endpoint answers with bytes, not JSON */ }
    throw fail(msg, res.status);
  }
  return res.arrayBuffer();
}

/**
 * Seals one upload so that every wall survives voxelisation — CONTRACT.md
 * section 8. The request carries the cell size the result is computed for; the
 * server caches identical parameter sets and answers from disk.
 *
 * @param {string} id upload id of the *source* STL
 * @param {{mode:"off"|"shell"|"fill", close_holes:number, min_thickness:number, cell_m:number}} options
 * @returns {Promise<{sealedId:string, file:string, cell_m:number, seconds:number, stats:object}>}
 */
export function sealStl(id, options = {}) {
  const cell = Number(options.cell_m);
  if (!Number.isFinite(cell) || cell <= 0) {
    return Promise.reject(fail("Cannot seal without a valid cell size.", 0));
  }
  // metres per mesh unit — an export in millimetres has 0.001 here
  const scale = Number(options.mesh_scale);
  const mode = options.mode === "shell" || options.mode === "fill" ? options.mode : "fill";
  return request(`/stl/${seg(id)}/seal`, json("POST", {
    mode,
    close_holes: Math.round(Number(options.close_holes) || 0),
    min_thickness: Math.max(1, Math.round(Number(options.min_thickness) || 1)),
    cell_m: cell,
    mesh_scale: Number.isFinite(scale) && scale > 0 ? scale : 1
  }));
}

/* ====================================================================== setups */

/** `[{ name, savedAt }]` */
export function listSetups() {
  return request("/setups");
}

export function loadSetup(name) {
  return request(`/setups/${seg(name)}`);
}

export function saveSetup(name, config) {
  return request(`/setups/${seg(name)}`, json("PUT", config));
}

export function deleteSetup(name) {
  return request(`/setups/${seg(name)}`, { method: "DELETE" });
}

/* ================================================================= build & run */

/** `{ defines, needsRebuild, currentHash, targetHash, reason }` */
export function preview(config) {
  return request("/preview", json("POST", config));
}

/** `{ jobId }` — throws with status 409 while another job is running. */
export function run(config, forceRebuild = false) {
  return request("/run", json("POST", { config, forceRebuild }));
}

export function stopJob(id) {
  return request(`/jobs/${seg(id)}/stop`, { method: "POST" });
}

/** `[{ id, state, mode, startedAt, endedAt, exitCode }]` */
export function listJobs() {
  return request("/jobs");
}

/* ========================================================================= sse */

/**
 * Opens the event stream of a job. `onEvent` gets one parsed object per line:
 * `{type:"stage"|"log"|"status"|"exit", …}`. Lines that are not JSON arrive as
 * studio log entries so nothing is lost.
 *
 * @returns {{ close():void, closed:boolean }}
 */
export function openJobStream(jobId, onEvent) {
  if (typeof onEvent !== "function") throw new TypeError("openJobStream expects a function.");

  const source = new EventSource(`${BASE}/jobs/${seg(jobId)}/events`);
  let closed = false;

  const shut = () => {
    if (closed) return;
    closed = true;
    source.close();
  };

  source.addEventListener("message", ev => {
    let data;
    try {
      data = JSON.parse(ev.data);
    } catch {
      data = { type: "log", stream: "studio", text: String(ev.data) };
    }
    onEvent(data);
    // the server ends the stream after the exit event; do not reconnect
    if (data && data.type === "exit") shut();
  });

  source.addEventListener("error", () => {
    if (closed) return;
    if (source.readyState === EventSource.CLOSED) {
      shut();
      onEvent({ type: "stage", stage: "error", text: "Connection to the run was lost." });
    } else {
      onEvent({ type: "log", stream: "studio", text: "Connection interrupted — retrying …" });
    }
  });

  return {
    close: shut,
    get closed() { return closed; }
  };
}
