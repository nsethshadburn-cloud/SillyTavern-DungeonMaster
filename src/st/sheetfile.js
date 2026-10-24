// Read a character sheet from (almost) any file: PDFs (text, form fields, or page images when
// it's a scan), photos and screenshots, Word/OpenDocument files, and anything text-like.
// Images go to Claude as pictures; everything else as text.


const MAX_IMAGE_SIDE = 1600;   // Claude reads sheets fine at this size and it keeps uploads small
const MAX_PDF_PAGES_AS_IMAGES = 4;

/**
 * @param {File} file
 * @returns {Promise<{kind: string, text: string, fields: Record<string,string>, images: string[]}>}
 *  images are data URLs (JPEG)
 */
export async function readSheetFile(file) {
    const name = String(file.name || '').toLowerCase();
    const type = String(file.type || '').toLowerCase();
    const ext = name.includes('.') ? name.split('.').pop() : '';

    if (type === 'application/pdf' || ext === 'pdf') {
        const { extractPdf } = await import('./sheets.js');
        const pdf = await extractPdf(file);
        if (pdf.text.length > 80 || Object.keys(pdf.fields).length) return { kind: 'PDF', text: pdf.text, fields: pdf.fields, images: [] };
        // A scanned PDF has no text layer: send its pages as pictures instead.
        return { kind: 'scanned PDF', text: '', fields: {}, images: await pdfPagesAsImages(file) };
    }
    if (type.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'].includes(ext)) {
        return { kind: 'image', text: '', fields: {}, images: [await imageFileToJpeg(file)] };
    }
    if (['docx', 'odt'].includes(ext) || type.includes('wordprocessingml') || type.includes('opendocument.text')) {
        const xmlPath = ext === 'odt' || type.includes('opendocument') ? 'content.xml' : 'word/document.xml';
        const xml = await readZipEntry(await file.arrayBuffer(), xmlPath);
        if (!xml) throw new Error(`Couldn't open "${file.name}" as a document.`);
        return { kind: ext.toUpperCase() || 'document', text: xmlToText(xml), fields: {}, images: [] };
    }
    // Anything else: use it as text if it really is text.
    const raw = await file.text();
    if (!looksLikeText(raw)) {
        throw new Error(`Couldn't read "${file.name}". Try a PDF, a photo or screenshot of the sheet, a Word document, or a text file.`);
    }
    let text = raw;
    if (['html', 'htm', 'xml'].includes(ext) || /<\/?(html|body|div|p|table|span)[\s>]/i.test(raw)) text = htmlToText(raw);
    else if (ext === 'rtf' || raw.startsWith('{\\rtf')) text = raw.replace(/\\par[d]?/g, '\n').replace(/\{\*?\\[^{}]+}|[{}]|\\[a-z]+-?\d* ?/gi, '');
    return { kind: ext ? ext.toUpperCase() : 'text', text: text.trim(), fields: {}, images: [] };
}

function looksLikeText(s) {
    if (!s) return false;
    const sample = s.slice(0, 4000);
    let ok = 0;
    for (const ch of sample) {
        const c = ch.charCodeAt(0);
        if (c === 9 || c === 10 || c === 13 || (c >= 32 && c !== 0xFFFD)) ok++;
    }
    return ok / sample.length > 0.9;
}

function htmlToText(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script, style').forEach(el => el.remove());
    return (doc.body?.innerText || doc.body?.textContent || '').replace(/\n{3,}/g, '\n\n');
}

function xmlToText(xml) {
    return xml
        .replace(/<\/(w:p|text:p|text:h)>/g, '\n')
        .replace(/<(w:tab|text:tab)\/>/g, '\t')
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, '\'').replace(/&amp;/g, '&')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** Read one file out of a zip (Word/OpenDocument) using the browser's own inflater. */
async function readZipEntry(buffer, path) {
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    // End of central directory: scan back from the end.
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 66000); i--) {
        if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return null;
    const count = view.getUint16(eocd + 10, true);
    let p = view.getUint32(eocd + 16, true);
    const decoder = new TextDecoder();
    for (let n = 0; n < count && p + 46 <= bytes.length; n++) {
        if (view.getUint32(p, true) !== 0x02014b50) break;
        const method = view.getUint16(p + 10, true);
        const compSize = view.getUint32(p + 20, true);
        const nameLen = view.getUint16(p + 28, true);
        const extraLen = view.getUint16(p + 30, true);
        const commentLen = view.getUint16(p + 32, true);
        const local = view.getUint32(p + 42, true);
        const entryName = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
        if (entryName === path) {
            const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
            const data = bytes.subarray(start, start + compSize);
            if (method === 0) return decoder.decode(data);
            if (method !== 8 || typeof DecompressionStream === 'undefined') return null;
            const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
            return await new Response(stream).text();
        }
        p += 46 + nameLen + extraLen + commentLen;
    }
    return null;
}

/** Shrink a photo/screenshot to a JPEG data URL Claude accepts. */
async function imageFileToJpeg(file) {
    const url = URL.createObjectURL(file);
    try {
        const img = await new Promise((resolve, reject) => {
            const el = new Image();
            el.onload = () => resolve(el);
            el.onerror = () => reject(new Error(`Couldn't open "${file.name}" as an image. Try a JPEG or PNG.`));
            el.src = url;
        });
        return drawToJpeg(img, img.naturalWidth, img.naturalHeight);
    } finally {
        URL.revokeObjectURL(url);
    }
}

function drawToJpeg(source, w, h) {
    const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.88);
}

async function pdfPagesAsImages(file) {
    const { loadPdfJs } = await import('./sheets.js');
    const pdfjsLib = await loadPdfJs();
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const images = [];
    for (let i = 1; i <= Math.min(pdf.numPages, MAX_PDF_PAGES_AS_IMAGES); i++) {
        const page = await pdf.getPage(i);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: MAX_IMAGE_SIDE / Math.max(base.width, base.height) });
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        images.push(drawToJpeg(canvas, canvas.width, canvas.height));
    }
    if (!images.length) throw new Error('This PDF has no pages to read.');
    return images;
}
