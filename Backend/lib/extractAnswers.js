import { callStructured, userContent } from './llmClient.js'
import { OBJECTIVE_QUESTION_TYPES } from './extractQuestions.js'
import { annotateLines } from './annotateLines.js'

// How many answer-sheet page images per vision call. Small so each answer's location
// stays precise and the model isn't overwhelmed.
const PAGES_PER_CALL = 2

const ANSWERS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    answers: {
      type: 'array',
      description: 'One entry per question that has ANY student work visible in these pages. Omit questions with nothing here.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          questionId: { type: 'string', description: 'id copied exactly from the provided question list' },
          answered: { type: 'boolean', description: 'true if the student made any attempt at this question in these pages' },
          transcription: {
            type: 'string',
            description: 'Verbatim transcription of the student\'s answer (working, sentences, final result, diagram labels). "" if nothing written but an option was marked.',
          },
          selectedOption: {
            type: ['string', 'null'],
            description: 'For MCQ/assertion_reason: the chosen option LETTER. For true_false: "true" or "false". For fill_blank: the text the student wrote in the blank. null if not applicable / nothing chosen.',
          },
          lineRefs: {
            type: 'array',
            description: 'Which numbered line markers (the red boxed numbers printed on the image) belong to this answer\'s OWN written content - never the question-label line. One entry per page the answer appears on.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                page: { type: 'number', description: 'page number as labelled for the image this line is in' },
                lineIndices: { type: 'array', items: { type: 'number' }, description: 'the line-marker numbers on that page that are this answer' },
              },
              required: ['page', 'lineIndices'],
            },
          },
          continuesBeyondThesePages: {
            type: 'boolean',
            description: 'true if this answer clearly runs onto a page not shown in this call',
          },
        },
        required: ['questionId', 'answered', 'transcription', 'selectedOption', 'lineRefs', 'continuesBeyondThesePages'],
      },
    },
  },
  required: ['answers'],
}

const SYSTEM_PROMPT = `You are matching a student's handwritten answer sheet to a known list of exam questions. You are shown page images of the answer sheet and the full question list.

Every line of text on each page image has a small numbered red marker printed just to its left (0, 1, 2, ...), with a thin red outline around the exact line it labels. Use these numbers to report WHERE an answer is - never guess coordinates.

For every question that has ANY student work visible in these page images, output one "answers" entry:
- "questionId": copy the id exactly from the question list. Match by the student's written question label (which appears in many forms — "Q2", "2)", "Ans 2", "2.a", "Q-2(a)") AND by the content matching the question. If a label is ambiguous, use the content.
- "answered": true if the student attempted it here (wrote anything, or marked/circled an option).
- "transcription": transcribe the student's actual answer VERBATIM — their working, sentences, final answers, diagram labels. Fix only obvious slip-of-the-pen letter shapes; keep the student's actual words, numbers, and mistakes. Transcribe math in plain text (x^2, sqrt(25), <=). Do NOT include the question's printed statement if the student copied it out — only their answer. If the student only marked an option and wrote no prose, use "".
- "selectedOption":
    · MCQ / assertion_reason → the LETTER the student chose (from a written letter, a circled/ticked/underlined option, or the option's value written out — match a written-out value back to its letter using the question's "options").
    · true_false → "true" or "false".
    · fill_blank → the exact text the student wrote in the blank.
    · otherwise → null.
- "lineRefs": for each page this answer appears on, list the numbered line-marker(s) that are this answer's OWN content — e.g. if the marker-3 line and marker-4 line are the two lines the student wrote for this answer, report lineIndices [3, 4]. Include EVERY consecutive line that is genuinely part of this one answer (working spanning several lines). Do NOT include the line carrying the question's own label/number (e.g. the "Q11." line) unless the student's answer starts on that same line right after the label — in that case include it too. Do NOT include neighbouring questions' lines.
- "continuesBeyondThesePages": true if the answer obviously runs onto a page you weren't shown.

Only report what is actually visible here. Do not invent answers for questions with no work on these pages — just omit them.`

async function readChunk(questionList, pages) {
  const annotated = await Promise.all(
    pages.map((p) => annotateLines(p.dataUrl, { width: p.width, height: p.height }, p.lines)),
  )
  const labelled = pages
    .map((p, i) => `Image ${i + 1} is answer-sheet page ${p.page}, with ${p.lines.length} numbered line markers (0-${p.lines.length - 1}).`)
    .join('\n')

  const result = await callStructured({
    system: SYSTEM_PROMPT,
    content: userContent(
      `Question list (JSON):\n${JSON.stringify(questionList, null, 2)}\n\n${labelled}\n\nFind every student answer visible on these pages.`,
      annotated,
    ),
    schemaName: 'answer_reading',
    schema: ANSWERS_SCHEMA,
    stage: 'extractAnswers',
  })
  return result.answers ?? []
}

function chunkPages(pages, size) {
  const out = []
  for (let i = 0; i < pages.length; i += size) out.push(pages.slice(i, i + size))
  return out
}

/**
 * Resolves lineRefs (page + line index) against the detected line geometry into
 * normalized 0..1 regions, merging adjacent same-answer lines into contiguous boxes.
 */
function resolveRegions(lineRefs, pagesByNumber) {
  const regions = []
  for (const ref of lineRefs ?? []) {
    const page = pagesByNumber.get(ref.page)
    if (!page) continue
    for (const idx of ref.lineIndices ?? []) {
      const line = page.lines[idx]
      if (!line) continue
      regions.push({ page: ref.page, x: line.x, y: line.y, width: line.width, height: line.height })
    }
  }
  return regions
}

/**
 * @param {Array<object>} questions - from extractQuestions (have stable `id`)
 * @param {Array<{ page:number, width:number, height:number, dataUrl:string }>} answerPages
 * @param {Array<{ page:number, width:number, height:number, lines:Array }>|null} lineGeometry
 *   - from lib/lineGeometry.js `detectLines()`, or null if that service was unreachable
 *     (extraction/grading still work then, just without highlight boxes).
 * @returns {Promise<{ mappings: Array<{ questionId, status, answerText, selectedOption, regions }> }>}
 */
export async function extractAndMapAnswers(questions, answerPages, lineGeometry = null) {
  const questionList = questions.map((q) => ({
    id: q.id,
    displayNumber: q.displayNumber,
    questionType: q.questionType ?? 'long_answer',
    text: q.text,
    options: q.options ?? [],
  }))
  const questionById = new Map(questions.map((q) => [q.id, q]))

  const linesByPage = new Map()
  if (lineGeometry) {
    for (const gp of lineGeometry) linesByPage.set(gp.page, gp.lines)
  }
  const pagesWithLines = answerPages.map((p) => ({ ...p, lines: linesByPage.get(p.page) ?? [] }))
  const pagesByNumber = new Map(pagesWithLines.map((p) => [p.page, p]))

  const groups = chunkPages(pagesWithLines, PAGES_PER_CALL)
  const perGroup = await Promise.all(groups.map((g) => readChunk(questionList, g)))

  // Reconcile by questionId across page-calls.
  const byId = new Map()
  for (const answers of perGroup) {
    for (const a of answers) {
      if (!questionById.has(a.questionId)) continue // ignore hallucinated ids
      const regions = resolveRegions(a.lineRefs, pagesByNumber)
      const existing = byId.get(a.questionId)
      if (!existing) {
        byId.set(a.questionId, {
          answered: !!a.answered,
          transcription: a.transcription ?? '',
          selectedOption: a.selectedOption ?? null,
          regions,
          firstPage: regions[0]?.page ?? Infinity,
        })
      } else {
        const thisFirstPage = regions[0]?.page ?? Infinity
        existing.regions = dedupeRegions([...existing.regions, ...regions])
        existing.answered = existing.answered || !!a.answered
        if (!existing.selectedOption && a.selectedOption) existing.selectedOption = a.selectedOption
        // Prefer the transcription from the call that saw the answer's start (has the label
        // / question number), not merely the longest text.
        if (thisFirstPage < existing.firstPage && (a.transcription ?? '').trim()) {
          existing.transcription = a.transcription
          existing.firstPage = thisFirstPage
        } else if (existing.firstPage === Infinity && (a.transcription ?? '').trim()) {
          existing.transcription = a.transcription
        }
      }
    }
  }

  const mappings = questions.map((q) => {
    const found = byId.get(q.id)
    if (!found) {
      return { questionId: q.id, status: 'unanswered', answerText: null, selectedOption: null, regions: [] }
    }
    const isObjective = OBJECTIVE_QUESTION_TYPES.has(q.questionType)
    const selectedOption = normalizeSelected(found.selectedOption, q.questionType)
    const hasText = (found.transcription ?? '').trim().length > 0
    const answered = found.answered || hasText || selectedOption != null

    if (!answered) {
      return { questionId: q.id, status: 'unanswered', answerText: null, selectedOption: null, regions: found.regions }
    }
    return {
      questionId: q.id,
      status: 'answered',
      answerText: hasText ? found.transcription : null,
      selectedOption,
      regions: found.regions,
      // objective questions with no resolvable choice are still "answered" (student wrote
      // something) — grading decides what that's worth; we no longer force "unanswered".
      _isObjective: isObjective,
    }
  })

  return { mappings }
}

/**
 * Canonicalize the model's selectedOption for its question type.
 *  - mcq/assertion_reason: a bare lowercase letter, or a roman numeral kept as-is
 *  - true_false: "true" | "false"
 *  - fill_blank: the trimmed text
 *  - anything unresolvable -> null
 */
function normalizeSelected(raw, questionType) {
  if (raw == null) return null
  const s = String(raw).trim()
  if (!s) return null

  if (questionType === 'true_false') {
    const low = s.toLowerCase()
    if (/^(t|true|correct|yes)\b/.test(low)) return 'true'
    if (/^(f|false|incorrect|no)\b/.test(low)) return 'false'
    return null
  }
  if (questionType === 'fill_blank') {
    return s
  }
  // mcq / assertion_reason: pull out the option marker
  const low = s.toLowerCase()
  const roman = low.match(/^\(?\s*(i{1,3}|iv|v|vi{1,3}|ix|x)\s*\)?[.)]?$/)
  if (roman) return roman[1]
  // "option b", "ans: c", "(d)", "d." -> take the LAST standalone a-h letter
  const letters = low.match(/\b([a-h])\b/g)
  if (letters && letters.length) return letters[letters.length - 1]
  const anyLetter = low.match(/([a-h])/)
  return anyLetter ? anyLetter[1] : null
}

function dedupeRegions(regions) {
  const seen = new Set()
  const out = []
  for (const r of regions) {
    const key = `${r.page}:${r.x.toFixed(3)}:${r.y.toFixed(3)}:${r.width.toFixed(3)}:${r.height.toFixed(3)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(r)
  }
  return out
}
