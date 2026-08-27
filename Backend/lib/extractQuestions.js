import { callStructured } from './openaiClient.js'

const QUESTIONS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          displayNumber: {
            type: 'string',
            description: 'Exact printed label, e.g. "11(a)", "3", "Q5b"',
          },
          baseNumber: {
            type: 'string',
            description: 'The root question number without sub-part, e.g. "11" for "11(a)"',
          },
          subpart: {
            type: ['string', 'null'],
            description: 'Sub-part label if present, e.g. "a", "b"; null if none',
          },
          text: {
            type: 'string',
            description: 'Full text of the question as printed',
          },
          maxMarks: {
            type: ['number', 'null'],
            description: 'Marks allotted to this question if printed, else null',
          },
          page: {
            type: 'number',
            description: 'Page number (1-indexed) this question appears on',
          },
          lineIndices: {
            type: 'array',
            items: { type: 'number' },
            description: 'Indices (from the numbered OCR line list on this page) of every line that belongs to this question\'s printed text',
          },
        },
        required: ['displayNumber', 'baseNumber', 'subpart', 'text', 'maxMarks', 'page', 'lineIndices'],
      },
    },
  },
  required: ['questions'],
}

const SYSTEM_PROMPT = `You are an expert exam paper parser. You will be given OCR output for a question paper: for each page, a numbered list of text lines in top-to-bottom reading order.

Rules:
- Extract every question in the exact order they are printed.
- If a question has labelled sub-parts (e.g. "11 (a)", "11 (b)"), treat EACH sub-part as its own separate entry, not as one combined question. Do not merge sub-parts.
- Preserve the exact original numbering/labels as printed (do not renumber or normalize).
- Skip instructions-only text, section headers, or preamble - those are not questions.
- If marks are printed next to a question (e.g. "[5 marks]", "(10)"), extract them as maxMarks.
- Record which page number each question appears on.
- For each question, list the "lineIndices" - the indices of the OCR lines (from the numbered list given for that page) that make up this question's printed text. This is used to locate the question on the page later, so be accurate and only include lines that are actually part of that question's text.
- OCR text may contain minor recognition errors (e.g. "0" vs "O", broken words) - use your judgement to reconstruct the intended text.
- Be exhaustive: do not skip any question, including short one-line ones.`

/**
 * @param {Array<{page:number, lines: Array<{text:string,x:number,y:number,width:number,height:number}>}>} ocrPages
 */
export async function extractQuestions(ocrPages) {
  const userText = ocrPages
    .map((page) => {
      const numberedLines = page.lines.map((line, i) => `[${i}] ${line.text}`).join('\n')
      return `--- Page ${page.page} (OCR lines) ---\n${numberedLines}`
    })
    .join('\n\n')

  const result = await callStructured({
    systemPrompt: SYSTEM_PROMPT,
    userContent: [{ type: 'text', text: userText }],
    schemaName: 'question_extraction',
    schema: QUESTIONS_SCHEMA,
  })

  return result.questions.map((q, index) => {
    const page = ocrPages.find((p) => p.page === q.page)
    const regions = (q.lineIndices ?? [])
      .map((i) => page?.lines[i])
      .filter(Boolean)
      .map((line) => ({ page: q.page, x: line.x, y: line.y, width: line.width, height: line.height }))

    const { lineIndices, ...rest } = q
    return {
      id: `q-${index + 1}`,
      order: index + 1,
      ...rest,
      regions,
    }
  })
}
