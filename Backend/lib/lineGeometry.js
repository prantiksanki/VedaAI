const OCR_SERVICE_URL = process.env.OCR_SERVICE_URL || 'http://localhost:8000'

// Render's free tier spins the service down after inactivity; a cold start can take
// 30-50+ seconds to come back up, during which requests fail outright rather than
// queueing. Retry with backoff so a sleeping instance gets a chance to wake up
// instead of permanently losing the highlight-box feature for that request.
const RETRY_DELAYS_MS = [3000, 8000, 15000, 20000]

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Gets precise text-LINE bounding boxes for an answer sheet page image, from the
 * geometry-only detection service (no text is read there - a vision LLM does all
 * reading). Boxes are normalized 0-1 and numbered in reading order.
 *
 * @param {{ buffer: Buffer, mimetype?: string, originalname?: string }} file
 * @returns {Promise<Array<{ page:number, width:number, height:number, lines: Array<{index:number,x:number,y:number,width:number,height:number}> }>>}
 */
export async function detectLines(file) {
  let lastError

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1])

    const formData = new FormData()
    formData.append('file', new Blob([file.buffer], { type: file.mimetype }), file.originalname || 'file')

    let response
    try {
      response = await fetch(`${OCR_SERVICE_URL}/detect-lines`, { method: 'POST', body: formData })
    } catch (err) {
      lastError = new Error(
        `Could not reach the line-geometry service at ${OCR_SERVICE_URL}. Make sure it is running (see OcrService/README).`,
      )
      continue
    }

    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      lastError = new Error(body.detail || `Line-geometry service error (${response.status})`)
      // A real error response (not a connection failure) means the service is up but
      // rejected the request - retrying won't help.
      throw lastError
    }

    const { pages } = await response.json()
    return pages
  }

  throw lastError
}
