// pdf.js adapter — the only module in the extension that imports pdfjs-dist.
//
// Its whole job is turning a statement PDF into per-page arrays of visual lines, so that
// ccStatementParse.ts can stay a pure string->data function with no DOM and no pdf.js
// dependency (and therefore be unit-testable without a browser).
//
// MV3 notes: the default extension CSP is `script-src 'self'`, which forbids eval but
// DOES allow a Worker created from an extension-origin URL. Vite's `?url` import emits
// pdf.worker.min.mjs as a build asset and hands back its extension-relative URL, so the
// worker loads same-origin from the side panel with no web_accessible_resources entry
// (WAR only governs access from *other* origins).

import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

/** Text items whose baselines are within this many PDF units count as one visual line. */
const LINE_Y_TOLERANCE = 3;

export class StatementPdfError extends Error {}

/**
 * pdf.js is ~500 KB minified and this is an infrequent workflow, so it is loaded on
 * first parse rather than bundled into the side panel's initial chunk — the panel opens
 * on every ticket, and most of those tickets are not statement corrections.
 */
let pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null;

function loadPdfjs(): Promise<typeof import('pdfjs-dist')> {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist').then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

/**
 * Reconstructs the visual lines of each page.
 *
 * pdf.js hands back text items in drawing order, not reading order, so items are grouped
 * by their baseline y (transform[5]) and then sorted left-to-right by x (transform[4]).
 * The result is `pages[pageIndex][lineIndex]`, top line first.
 */
export async function extractStatementText(file: File): Promise<string[][]> {
  const pdfjs = await loadPdfjs();
  const bytes = new Uint8Array(await file.arrayBuffer());

  let doc: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>;
  try {
    doc = await pdfjs.getDocument({ data: bytes }).promise;
  } catch (e) {
    throw new StatementPdfError(
      `Could not read that file as a PDF (${e instanceof Error ? e.message : String(e)}).`,
    );
  }

  const pages: string[][] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      pages.push(linesFromItems(content.items as TextItemLike[]));
    }
  } finally {
    // Frees the worker's copy of the document. The panel can parse several statements in
    // one session, so leaking these matters.
    void doc.destroy();
  }

  if (pages.every((lines) => lines.length === 0)) {
    throw new StatementPdfError(
      'No text found in that PDF — it looks like a scan or an image-only export. ' +
      'Statement PDFs downloaded from Atlas have real text; try re-downloading it.',
    );
  }

  return pages;
}

interface TextItemLike {
  str?: string;
  transform?: number[];
}

/** Exported for tests: the grouping is the part most likely to regress. */
export function linesFromItems(items: TextItemLike[]): string[] {
  const rows: { y: number; items: { x: number; str: string }[] }[] = [];

  for (const item of items) {
    const str = item.str;
    if (!str || !str.trim()) continue;
    const transform = item.transform;
    if (!transform || transform.length < 6) continue;
    const x = transform[4];
    const y = transform[5];

    let row = rows.find((r) => Math.abs(r.y - y) <= LINE_Y_TOLERANCE);
    if (!row) {
      row = { y, items: [] };
      rows.push(row);
    }
    row.items.push({ x, str });
  }

  return rows
    .sort((a, b) => b.y - a.y) // PDF y grows upward, so descending y is top-to-bottom
    .map((row) =>
      row.items
        .sort((a, b) => a.x - b.x)
        .map((i) => i.str)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean);
}
