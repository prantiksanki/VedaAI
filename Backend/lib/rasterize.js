import { createRequire } from 'module'
import { pathToFileURL } from 'url'
import path from 'path'
import sharp from 'sharp'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

const require = createRequire(import.meta.url)
const { createCanvas } = require('@napi-rs/canvas')

// pdf.js still spins up a "fake worker" on the main thread in Node, but it insists on a
// resolvable workerSrc. Resolve the bundled worker + standard fonts through the package
// so it works regardless of cwd / hoisting.
const PDFJS_ROOT = path.dirname(require.resolve('pdfjs-dist/package.json'))
const PDFJS_WORKER_URL = pathToFileURL(
  path.join(PDFJS_ROOT, 'legacy/build/pdf.worker.mjs'),
).href
// pdf.js's Node data factory does fs.readFile(`${standardFontDataUrl}${filename}`), so this
// must be a plain filesystem path (forward slashes work on Windows), ending in "/".
const STANDARD_FONTS_PATH = `${PDFJS_ROOT.replace(/\\/g, '/')}/standard_fonts/`

pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL

// Claude's high-res vision tops out at 2576px on the long edge. Stay under it so the
// service never has to down-sample our render, and pages stay legible for handwriting.
const MAX_LONG_EDGE = 2200
// ~200 DPI (a US-Letter page at 72pt/in * (200/72) ≈ 1700px tall) is plenty for
// handwriting while keeping payloads small; capped by MAX_LONG_EDGE.
const TARGET_DPI = 200
const JPEG_QUALITY = 92

/**
 * @param {import('@napi-rs/canvas').Canvas} canvas
 * @returns {string} data:image/jpeg;base64,...
 */
function canvasToDataUrl(canvas) {
  const buf = canvas.toBuffer('image/jpeg', JPEG_QUALITY / 100)
  return `data:image/jpeg;base64,${buf.toString('base64')}`
}

/**
 * Renders every page of a PDF to a JPEG data URL.
 * @param {Buffer} buffer
 * @returns {Promise<Array<{ page:number, width:number, height:number, dataUrl:string }>>}
 */
async function rasterizePdf(buffer) {
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    // Uploaded PDFs are untrusted - do not run any embedded JS, do not fetch external resources.
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    standardFontDataUrl: STANDARD_FONTS_PATH,
  })
  const doc = await loadingTask.promise

  const pages = []
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n)
      try {
        const base = page.getViewport({ scale: 1 })
        let scale = TARGET_DPI / 72
        const longEdge = Math.max(base.width, base.height) * scale
        if (longEdge > MAX_LONG_EDGE) scale *= MAX_LONG_EDGE / longEdge

        const viewport = page.getViewport({ scale })
        const width = Math.ceil(viewport.width)
        const height = Math.ceil(viewport.height)
        const canvas = createCanvas(width, height)
        const ctx = canvas.getContext('2d')
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, width, height)

        await page.render({ canvasContext: ctx, viewport }).promise
        pages.push({ page: n, width, height, dataUrl: canvasToDataUrl(canvas) })
      } finally {
        page.cleanup()
      }
    }
  } finally {
    await loadingTask.destroy()
  }
  return pages
}

/**
 * Normalizes a single uploaded image (photo/scan) to one page entry: honours EXIF
 * orientation, downscales to MAX_LONG_EDGE, re-encodes as JPEG.
 * @param {Buffer} buffer
 * @returns {Promise<Array<{ page:number, width:number, height:number, dataUrl:string }>>}
 */
async function rasterizeImage(buffer) {
  const rotated = sharp(buffer).rotate() // applies EXIF orientation, then strips it
  const meta = await rotated.metadata()
  const longEdge = Math.max(meta.width ?? 0, meta.height ?? 0)

  let pipeline = rotated
  if (longEdge > MAX_LONG_EDGE) {
    pipeline = pipeline.resize({
      width: meta.width >= meta.height ? MAX_LONG_EDGE : undefined,
      height: meta.height > meta.width ? MAX_LONG_EDGE : undefined,
      fit: 'inside',
    })
  }

  const out = await pipeline.jpeg({ quality: JPEG_QUALITY }).toBuffer({ resolveWithObject: true })
  return [
    {
      page: 1,
      width: out.info.width,
      height: out.info.height,
      dataUrl: `data:image/jpeg;base64,${out.data.toString('base64')}`,
    },
  ]
}

/**
 * Turns an uploaded question paper / answer sheet (PDF or image) into page images
 * that a vision model can read. Replaces the docTR OCR sidecar for reading.
 *
 * @param {{ buffer: Buffer, mimetype?: string, originalname?: string }} file
 * @returns {Promise<Array<{ page:number, width:number, height:number, dataUrl:string }>>}
 */
export async function rasterize(file) {
  const name = (file.originalname || '').toLowerCase()
  const isPdf = file.mimetype === 'application/pdf' || name.endsWith('.pdf')

  try {
    const pages = isPdf ? await rasterizePdf(file.buffer) : await rasterizeImage(file.buffer)
    if (!pages.length) throw new Error('No pages found in the uploaded file.')
    return pages
  } catch (err) {
    throw new Error(`Could not read the uploaded ${isPdf ? 'PDF' : 'image'}: ${err.message}`)
  }
}
