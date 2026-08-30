const OCR_SERVICE_URL = process.env.OCR_SERVICE_URL || 'http://localhost:8000'

/**
 * Gets precise text-LINE bounding boxes for an answer sheet page image, from the
 * geometry-only detection service (no text is read there - a vision LLM does all
 * reading). Boxes are normalized 0-1 and numbered in reading order.
 *
 * @param {{ buffer: Buffer, mimetype?: string, originalname?: string }} file
 * @returns {Promise<Array<{ page:number, width:number, height:number, lines: Array<{index:number,x:number,y:number,width:number,height:number}> }>>}
 */
export async function detectLines(file) {
  const formData = new FormData()
  formData.append('file', new Blob([file.buffer], { type: file.mimetype }), file.originalname || 'file')

  let response
  try {
    response = await fetch(`${OCR_SERVICE_URL}/detect-lines`, { method: 'POST', body: formData })
  } catch {
    throw new Error(
      `Could not reach the line-geometry service at ${OCR_SERVICE_URL}. Make sure it is running (see OcrService/README).`,
    )
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(body.detail || `Line-geometry service error (${response.status})`)
  }

  const { pages } = await response.json()
  return pages
}
