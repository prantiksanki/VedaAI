const OCR_SERVICE_URL = process.env.OCR_SERVICE_URL || 'http://localhost:8000'

/**
 * Sends a file to the OCR sidecar and gets back, per page:
 * text lines with normalized bounding boxes, plus a displayable page image.
 *
 * @param {{ buffer: Buffer, originalname: string, mimetype: string }} file
 * @param {'printed'|'handwritten'} docType - which recognition model to use; question papers
 *   are virtually always printed, answer sheets are virtually always handwritten.
 * @returns {Promise<Array<{ page:number, width:number, height:number, dataUrl:string, lines: Array<{text:string,x:number,y:number,width:number,height:number}> }>>}
 */
export async function ocrFile(file, docType = 'printed') {
  const formData = new FormData()
  formData.append('file', new Blob([file.buffer], { type: file.mimetype }), file.originalname)
  formData.append('doc_type', docType)

  let response
  try {
    response = await fetch(`${OCR_SERVICE_URL}/ocr`, { method: 'POST', body: formData })
  } catch {
    throw new Error(
      `Could not reach OCR service at ${OCR_SERVICE_URL}. Make sure it is running (see OcrService/README).`
    )
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(body.detail || `OCR service error (${response.status})`)
  }

  const { pages } = await response.json()
  return pages
}
