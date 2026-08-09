// In-browser PDF text extraction.
//
// The patient's file is read with FileReader and parsed by pdf.js entirely inside
// the tab. The bytes never reach the network; the backend now receives only the
// de-identified text produced downstream of this module (see ./deidentify.js).

// pdf.js is loaded on demand, not at module scope. A static import put the whole
// parser in the main bundle, so every visitor downloaded a PDF engine before the
// landing page painted — including the ones who only ever read the page. The
// import now happens inside the handler, on the first file the user picks.
let pdfjsPromise = null;

function loadPdfjs() {
  // Cached, so a second file does not re-import; the browser would serve it from
  // memory anyway, but this also keeps workerSrc assignment to exactly once.
  pdfjsPromise ??= (async () => {
    const [pdfjs, { default: PdfWorker }] = await Promise.all([
      import("pdfjs-dist"),
      // Bundled locally by Vite. Deliberately not a CDN URL: a remote worker
      // would be a third-party dependency sitting in the middle of PHI parsing.
      import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
    ]);
    pdfjs.GlobalWorkerOptions.workerSrc = PdfWorker;
    return pdfjs;
  })();
  return pdfjsPromise;
}

/**
 * Extract plain text from a PDF File/Blob without uploading it.
 *
 * @param {File|Blob} file
 * @param {(progress: {page: number, total: number}) => void} [onProgress]
 * @returns {Promise<string>}
 */
export async function extractPdfText(file, onProgress) {
  const pdfjs = await loadPdfjs();
  const buffer = await file.arrayBuffer();

  // `data` is transferred to the worker; nothing is written to storage.
  // Keep the loading task: in pdfjs-dist v6 `destroy()` lives on the task, not on
  // the document proxy, and tearing it down is what frees the worker's copy of the
  // patient's bytes.
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    disableFontFace: true,
  });
  const doc = await loadingTask.promise;

  try {
    const pages = [];
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum += 1) {
      const page = await doc.getPage(pageNum);
      try {
        const content = await page.getTextContent();
        pages.push(joinTextItems(content.items));
      } finally {
        page.cleanup();
      }
      onProgress?.({ page: pageNum, total: doc.numPages });
    }
    return pages.join("\n").trim();
  } finally {
    // Drops the document and terminates the worker's held copy of the PDF bytes.
    await loadingTask.destroy();
  }
}

/**
 * Reassemble pdf.js text items into lines.
 *
 * pdf.js emits positioned fragments, not lines. `hasEOL` marks a line break; without
 * this the whole page collapses into one run-on string and the scrubber's
 * line-anchored patterns (e.g. "Name: ...") stop matching.
 */
function joinTextItems(items) {
  let out = "";
  for (const item of items) {
    if (typeof item.str !== "string") continue;
    out += item.str;
    if (item.hasEOL) out += "\n";
    else if (item.str && !item.str.endsWith(" ")) out += " ";
  }
  return out
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}
