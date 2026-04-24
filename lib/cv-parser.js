// CV parsing helpers.
// PDF text extraction still happens in-browser (pdf.js cannot run in a MV3
// service worker). The structured parse step now goes to our backend instead
// of Gemini directly — see lib/backend.js#parseCVText.
//
// The options page extracts text locally via pdf.js and sends it to the
// service worker with UPLOAD_CV → { text }. The service worker calls the
// backend to get the structured profile.

/**
 * Extract all text from a PDF ArrayBuffer using pdf.js.
 * Requires pdf.js to be available — either as globalThis.pdfjsLib or passed in.
 * @param {ArrayBuffer} arrayBuffer
 * @param {object} [pdfjsLibOverride] - optional pdfjsLib reference
 * @returns {Promise<string>}
 */
export async function extractTextFromPDF(arrayBuffer, pdfjsLibOverride) {
  const pdfjsLib = pdfjsLibOverride || (typeof globalThis !== "undefined" && globalThis.pdfjsLib);
  if (!pdfjsLib) {
    throw new Error(
      "pdf.js no está cargado. Incluye /vendor/pdf.min.js en el <head> de la página antes de parsear un CV."
    );
  }

  // Configure worker src if the host hasn't done it already. Extension resources
  // are exposed as chrome-extension://... via web_accessible_resources.
  if (
    pdfjsLib.GlobalWorkerOptions &&
    !pdfjsLib.GlobalWorkerOptions.workerSrc &&
    typeof chrome !== "undefined" &&
    chrome.runtime &&
    typeof chrome.runtime.getURL === "function"
  ) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdf.worker.min.js");
  }

  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
  const doc = await loadingTask.promise;

  let fullText = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const strings = (content.items || []).map((it) => (typeof it.str === "string" ? it.str : ""));
    fullText += strings.join(" ") + "\n";
  }
  return fullText.trim();
}
