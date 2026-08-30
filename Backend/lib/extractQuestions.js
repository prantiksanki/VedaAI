import { callStructured, userContent } from './llmClient.js'
import { assignIds } from './questionId.js'

const QUESTION_TYPES = ['mcq', 'assertion_reason', 'true_false', 'fill_blank', 'short_answer', 'long_answer', 'numerical']

// Types whose grading is a single right/wrong match against a known correct answer,
// not a key-point-coverage judgement. One source of truth for the whole pipeline.
export const OBJECTIVE_QUESTION_TYPES = new Set(['mcq', 'assertion_reason', 'true_false', 'fill_blank'])

// How many question-paper page images to send per vision call.
const PAGES_PER_CALL = 3

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
          displayNumber: { type: 'string', description: 'Exact printed label, e.g. "11", "11(a)", "Q5b"' },
          subpart: { type: ['string', 'null'], description: 'Sub-part label if any ("a", "b", "ii"); null otherwise. NEVER set for MCQ options.' },
          questionType: { type: 'string', enum: QUESTION_TYPES },
          options: {
            type: 'array',
            description: 'For "mcq"/"assertion_reason": every printed choice. Empty array otherwise.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                label: { type: 'string', description: 'Option letter, normalized: "a", "b", "c", "d" (or "i"/"ii"…)' },
                text: { type: 'string', description: 'Option text as printed' },
              },
              required: ['label', 'text'],
            },
          },
          text: { type: 'string', description: 'Full question stem as printed. Do NOT include the MCQ options here.' },
          maxMarks: { type: ['number', 'null'], description: 'Printed marks for this question, else null' },
          page: { type: 'number', description: '1-indexed page number this question appears on (within the whole paper)' },
        },
        required: ['displayNumber', 'subpart', 'questionType', 'options', 'text', 'maxMarks', 'page'],
      },
    },
  },
  required: ['questions'],
}

const SYSTEM_PROMPT = `You are an expert exam-paper parser. You are shown page images (scans or photos) of a printed exam question paper. Extract every question.

Rules:
- Extract every question in the exact order printed. Preserve the exact printed label (do not renumber).
- Skip instructions, section headers, and preamble — those are not questions.
- If marks are printed for a question (e.g. "[5 marks]", "(10)", "2M"), record them as maxMarks; else null.
- "page" is the page number the question appears on, counting from 1 across the whole paper (the images you were given are labelled with their page numbers).
- Reconstruct text faithfully; transcribe math notation as best you can in plain text (x^2, sqrt, <=, etc.).

CLASSIFY EVERY QUESTION with "questionType":
- "mcq": stem followed by a short list of candidate answers to pick ONE from (labelled a/b/c/d or i/ii/iii/iv), each option a few words or a value, none an instruction.
- "assertion_reason": an Assertion + a Reason statement, then fixed lettered choices about their truth.
- "true_false": asks whether a statement is true or false.
- "fill_blank": a sentence with a blank to complete.
- "numerical": the answer is a single computed number/value, no options given.
- "short_answer": a 1–3 sentence or single-step written answer.
- "long_answer": explanation, derivation, proof, essay, diagram, or multi-step answer.

MCQ OPTIONS ARE NOT SUB-PARTS — the most important rule:
- An MCQ is ONE question entry: stem in "text", every choice in "options", questionType "mcq", subpart null. NEVER emit "1(a)","1(b)","1(c)","1(d)" for the choices of one MCQ.
- A genuine sub-part is an independently labelled TASK with its own imperative verb (Find, Prove, Draw, Explain, Show, Derive, Calculate, State), often its own marks, e.g. "3(a) Prove that… (b) Hence find…". Only these get separate entries with subpart "a"/"b"/…
- Disambiguation: lettered items that are short mutually-exclusive candidate answers with no imperative verb → MCQ options. Lettered items that are each a task → sub-parts.
- "options" must be an empty array for every non-MCQ / non-assertion_reason question.`

async function extractChunk(imageDataUrls, startPage) {
  const labelled = imageDataUrls
    .map((_, i) => `Image ${i + 1} is page ${startPage + i} of the question paper.`)
    .join('\n')

  const result = await callStructured({
    system: SYSTEM_PROMPT,
    content: userContent(
      `${labelled}\n\nExtract every question visible on these pages.`,
      imageDataUrls,
    ),
    schemaName: 'question_extraction',
    schema: QUESTIONS_SCHEMA,
    stage: 'extractQuestions',
  })
  return result.questions ?? []
}

function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/**
 * @param {Array<{ page:number, width:number, height:number, dataUrl:string }>} paperPages
 * @returns {Promise<Array<object>>} questions with a stable label-derived `id`
 */
export async function extractQuestions(paperPages) {
  const groups = chunk(paperPages, PAGES_PER_CALL)
  const perGroup = await Promise.all(
    groups.map((g) => extractChunk(g.map((p) => p.dataUrl), g[0].page)),
  )

  // Flatten, keep printed order (by page then appearance), drop exact duplicates that can
  // appear when a question straddles a chunk boundary (chunks don't overlap, but a header
  // repeated across pages could still double a question).
  const flat = perGroup.flat()
  const seen = new Set()
  const deduped = []
  for (const q of flat) {
    const key = `${q.page}::${(q.displayNumber || '').toLowerCase()}::${(q.text || '').slice(0, 40)}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(q)
  }
  deduped.sort((a, b) => (a.page - b.page) || 0)

  return assignIds(
    deduped.map((q) => ({
      displayNumber: q.displayNumber,
      subpart: q.subpart ?? null,
      questionType: QUESTION_TYPES.includes(q.questionType) ? q.questionType : 'long_answer',
      options: Array.isArray(q.options) ? q.options : [],
      text: q.text ?? '',
      maxMarks: typeof q.maxMarks === 'number' ? q.maxMarks : null,
      page: q.page ?? 1,
    })),
  ).map((q, index) => ({ ...q, order: index + 1 }))
}
