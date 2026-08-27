import fs from 'fs'
import { callStructured } from './openaiClient.js'

const PAGES_PER_CHUNK = 4
const CHUNK_OVERLAP = 1 // pages repeated between consecutive chunks, so an answer split across a chunk boundary isn't cut off

const MAPPING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    mappings: {
      type: 'array',
      description: 'One entry per question from the provided question list that has an answer visible in this batch of pages. Omit questions with no trace here.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          questionId: { type: 'string', description: 'The id of the question this maps to, copied exactly from the provided list' },
          answerText: {
            type: 'string',
            description: 'Transcribed/reconstructed answer text found in this batch of pages',
          },
          lineRefs: {
            type: 'array',
            description: 'References to the OCR lines that make up this answer, within this batch of pages.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                page: { type: 'number', description: 'Page number (1-indexed), matching the page numbers shown in this batch' },
                lineIndices: {
                  type: 'array',
                  items: { type: 'number' },
                  description: 'Indices from that page\'s numbered OCR line list that belong to this answer',
                },
              },
              required: ['page', 'lineIndices'],
            },
          },
        },
        required: ['questionId', 'answerText', 'lineRefs'],
      },
    },
  },
  required: ['mappings'],
}

const SYSTEM_PROMPT = `You are an expert at matching a student's answer-sheet content to a known list of exam questions, using OCR output (handwriting recognized to text, may contain errors).

You will receive:
1. The full list of questions for this exam (id, displayNumber, text) - for context, so you can recognize an answer even if only some of these questions appear in this batch of pages.
2. OCR output for a BATCH of consecutive pages from the student's answer sheet (not necessarily the whole answer sheet): for each page, a numbered list of recognized text lines in top-to-bottom reading order.

Your task:
- Only report on content that is ACTUALLY VISIBLE in this batch of pages. Do not guess about questions that might be answered on other pages not shown here.
- For each question you find an answer to in this batch, add an entry to "mappings": which question it is, the reconstructed answer text, and exactly which OCR lines (by page and index, using the page numbers as labeled in this batch) make up that answer.
- An answer may span multiple pages within this batch - include a lineRefs entry per page.
- If a question's answer clearly continues from the previous page but the question label isn't repeated, still attribute it to the right question by content and position.
- Do NOT include a question's own printed statement/text if the student copied it onto the answer sheet before writing their answer - only include the lines that are the student's actual answer (working, explanation, diagram labels, final result), not a restatement of the question.
- Do NOT include questions that have no visible answer in this batch - simply omit them (do not report "unanswered" here, since a question absent from this batch might be answered elsewhere).
- Ignore content that doesn't correspond to any question (stray notes, rough work headers, illegible scribbles) - do not force it onto an unrelated question, just leave it out.
- Only reference line indices that actually belong to that answer - do not include neighboring unrelated lines, since these are used to draw a precise highlight for a teacher.
- If an answer's text continues across several consecutive lines with no break in the content (no new question label, no unrelated text in between), include EVERY one of those consecutive lines in lineIndices - do not skip a line in the middle just because it feels redundant. A gap in the middle of an otherwise continuous answer produces a broken, incomplete-looking highlight for the teacher.
- Watch handwritten or printed question labels carefully - the label is the most reliable signal for which question an answer belongs to. Labels appear in MANY different formats and you must match them to a question by their NUMBER AND SUB-PART, not by exact string form. For example "Q2-a", "Q2 (a)", "Q2a", "2.a", "Q-2 a)" all refer to the same question if the question list has a question numbered 2 with subpart a. Be flexible with punctuation, spacing, and hyphens/parentheses when matching a label to a question's displayNumber.
- CORRECT OCR NOISE: handwriting OCR frequently mangles individual letters/words (e.g. "Choractountres" for "characteristics", "trammision" for "transmission", "chrumosogres" for "chromosomes"). Use the question's own text and the surrounding sentence context to recognize and correct these into the real, properly-spelled words the student almost certainly wrote. Produce the answerText as clean, correctly-spelled, readable text - never output obviously-garbled OCR noise verbatim. Only if a word is truly unrecoverable (no plausible reading from context) should you keep it as-is or mark it with [?]. This correction applies to answerText only - do not alter which lineIndices you select based on this.`

const SINGLE_QUESTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    found: { type: 'boolean', description: 'true if an answer to this specific question is visible in the provided pages' },
    answerText: { type: ['string', 'null'], description: 'Transcribed answer text if found, else null' },
    lineRefs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          page: { type: 'number' },
          lineIndices: { type: 'array', items: { type: 'number' } },
        },
        required: ['page', 'lineIndices'],
      },
    },
  },
  required: ['found', 'answerText', 'lineRefs'],
}

const SINGLE_QUESTION_SYSTEM_PROMPT = `You are checking a student's answer sheet for the answer to ONE SPECIFIC exam question, using OCR output (may contain recognition errors).

You will receive the question (displayNumber and text) and OCR lines from pages where its label plausibly appears.

Task:
- Determine whether this question's answer is genuinely present in these pages.
- Labels can appear in many formats (e.g. "Q2-a", "Q2 (a)", "Q2a", "2.a") - match by number and sub-part, not exact string.
- If found, set found=true, give the reconstructed answer text, and list exactly which OCR lines (page + index) make up the answer - only the actual answer content, not a restated question.
- If the answer continues across several consecutive lines with no break in content, include EVERY one of those consecutive lines - do not skip a line in the middle, since a gap produces a broken-looking highlight for the teacher.
- CORRECT OCR NOISE: use the question's own text and sentence context to correct mangled OCR words into the real, properly-spelled words the student almost certainly wrote. Produce answerText as clean, readable text - never output garbled OCR noise verbatim. Only keep a word as-is (or mark [?]) if truly unrecoverable.
- If truly not present, set found=false, answerText null, lineRefs empty.`

/**
 * Extracts the leading number (and optional single-letter subpart) from a displayNumber
 * like "Q2-a", "Q11 (b)", "5", "Q7." -> { number: "2", subpart: "a" | null }
 */
function parseLabel(displayNumber) {
  const match = displayNumber.match(/(\d+)\s*[\s.\-()]*\s*([a-zA-Z]?)/)
  if (!match) return null
  return { number: match[1], subpart: match[2] ? match[2].toLowerCase() : null }
}

function findCandidatePages(question, ocrPages) {
  const label = parseLabel(question.displayNumber)
  if (!label) return []
  const numberPattern = new RegExp(`(?<!\\d)${label.number}(?!\\d)`)
  const candidates = []
  for (const page of ocrPages) {
    const hasCandidate = page.lines.some((line) => numberPattern.test(line.text))
    if (hasCandidate) candidates.push(page)
  }
  return candidates
}

async function retryQuestion(question, candidatePages) {
  const ocrText = candidatePages
    .map((page) => {
      const numberedLines = page.lines.map((line, i) => `[${i}] ${line.text}`).join('\n')
      return `--- Answer Sheet Page ${page.page} (OCR lines) ---\n${numberedLines}`
    })
    .join('\n\n')

  const userText = `Question (JSON):\n${JSON.stringify({ displayNumber: question.displayNumber, text: question.text }, null, 2)}\n\nCandidate pages (where this question's number appears somewhere):\n\n${ocrText}`

  return callStructured({
    systemPrompt: SINGLE_QUESTION_SYSTEM_PROMPT,
    userContent: [{ type: 'text', text: userText }],
    schemaName: 'single_question_check',
    schema: SINGLE_QUESTION_SCHEMA,
  })
}

function chunkPages(ocrPages) {
  const chunks = []
  const step = PAGES_PER_CHUNK - CHUNK_OVERLAP
  for (let start = 0; start < ocrPages.length; start += step) {
    const chunk = ocrPages.slice(start, start + PAGES_PER_CHUNK)
    chunks.push(chunk)
    if (start + PAGES_PER_CHUNK >= ocrPages.length) break
  }
  return chunks
}

async function mapChunk(questionList, chunk) {
  const ocrText = chunk
    .map((page) => {
      const numberedLines = page.lines.map((line, i) => `[${i}] ${line.text}`).join('\n')
      return `--- Answer Sheet Page ${page.page} (OCR lines) ---\n${numberedLines}`
    })
    .join('\n\n')

  const userText = `Full question list for this exam (JSON):\n${JSON.stringify(questionList, null, 2)}\n\nThis batch covers pages ${chunk[0].page}-${chunk[chunk.length - 1].page} of the answer sheet:\n\n${ocrText}`

  return callStructured({
    systemPrompt: SYSTEM_PROMPT,
    userContent: [{ type: 'text', text: userText }],
    schemaName: 'answer_mapping_chunk',
    schema: MAPPING_SCHEMA,
  })
}

/**
 * @param {Array<{id:string, displayNumber:string, text:string}>} questions
 * @param {Array<{page:number, width:number, height:number, lines: Array<{text:string,x:number,y:number,width:number,height:number}>}>} ocrPages
 */
export async function extractAndMapAnswers(questions, ocrPages) {
  const questionList = questions.map((q) => ({ id: q.id, displayNumber: q.displayNumber, text: q.text }))
  const pageByNumber = new Map(ocrPages.map((p) => [p.page, p]))

  function resolveRegions(lineRefs) {
    const regions = []
    for (const ref of lineRefs ?? []) {
      const page = pageByNumber.get(ref.page)
      if (!page) continue
      for (const i of ref.lineIndices ?? []) {
        const line = page.lines[i]
        if (line) regions.push({ page: ref.page, x: line.x, y: line.y, width: line.width, height: line.height })
      }
    }
    return regions
  }

  const chunks = chunkPages(ocrPages)
  const chunkResults = await Promise.all(chunks.map((chunk) => mapChunk(questionList, chunk)))

  if (process.env.DEBUG_DUMP === '1') {
    try {
      fs.mkdirSync('./debug', { recursive: true })
      const stamp = Date.now()
      fs.writeFileSync(`./debug/${stamp}-chunk-results.json`, JSON.stringify(chunkResults, null, 2))
      console.log(`[debug] dumped ${chunks.length} chunk results to ./debug/${stamp}-chunk-results.json`)
    } catch (err) {
      console.error('[debug] failed to write debug dump:', err.message)
    }
  }

  // Merge per-question findings across chunks (a question can legitimately appear in
  // two chunks near an overlap boundary - combine their regions and prefer the longer answer text).
  const byQuestionId = new Map()
  for (const chunkResult of chunkResults) {
    for (const m of chunkResult.mappings ?? []) {
      const regions = resolveRegions(m.lineRefs)
      const existing = byQuestionId.get(m.questionId)
      if (!existing) {
        byQuestionId.set(m.questionId, { answerText: m.answerText, regions })
      } else {
        existing.regions = dedupeRegions([...existing.regions, ...regions])
        if ((m.answerText?.length ?? 0) > (existing.answerText?.length ?? 0)) {
          existing.answerText = m.answerText
        }
      }
    }
  }

  // Verification pass: for any question the chunked pass found no trace of, check whether
  // its number appears anywhere in the OCR text (a plausible sign it was actually missed
  // rather than genuinely unanswered), and if so retry it with a focused, single-question call.
  const stillMissing = questions.filter((q) => !byQuestionId.has(q.id))
  const retryTargets = stillMissing
    .map((q) => ({ question: q, candidatePages: findCandidatePages(q, ocrPages) }))
    .filter((t) => t.candidatePages.length > 0)

  if (retryTargets.length > 0) {
    const retryResults = await Promise.all(
      retryTargets.map((t) => retryQuestion(t.question, t.candidatePages))
    )
    retryTargets.forEach((t, i) => {
      const r = retryResults[i]
      if (r.found) {
        byQuestionId.set(t.question.id, { answerText: r.answerText, regions: resolveRegions(r.lineRefs) })
      }
    })

    if (process.env.DEBUG_DUMP === '1') {
      try {
        fs.mkdirSync('./debug', { recursive: true })
        const stamp = Date.now()
        fs.writeFileSync(
          `./debug/${stamp}-retry-results.json`,
          JSON.stringify(retryTargets.map((t, i) => ({ questionId: t.question.id, displayNumber: t.question.displayNumber, result: retryResults[i] })), null, 2)
        )
      } catch (err) {
        console.error('[debug] failed to write retry debug dump:', err.message)
      }
    }
  }

  const mappings = questions.map((q) => {
    const found = byQuestionId.get(q.id)
    if (!found) {
      return { questionId: q.id, status: 'unanswered', answerText: null, regions: [] }
    }
    return { questionId: q.id, status: 'answered', answerText: found.answerText, regions: found.regions }
  })

  return { mappings }
}

function dedupeRegions(regions) {
  const seen = new Set()
  const result = []
  for (const r of regions) {
    const key = `${r.page}:${r.x}:${r.y}:${r.width}:${r.height}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(r)
  }
  return result
}
