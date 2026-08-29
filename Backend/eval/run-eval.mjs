import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

import { rasterize } from '../lib/rasterize.js'
import { extractQuestions } from '../lib/extractQuestions.js'
import { extractAndMapAnswers } from '../lib/extractAnswers.js'
import { gradeAnswers } from '../lib/gradeAnswers.js'
import { labelToId } from '../lib/questionId.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = path.join(HERE, 'fixtures')
const MIN_WITHIN_1 = 0.85 // aggregate gate

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp'])

function loadInput(fixtureDir, base) {
  // base = "questions" | "answers"
  const pdf = path.join(fixtureDir, `${base}.pdf`)
  if (fs.existsSync(pdf)) {
    return [{ buffer: fs.readFileSync(pdf), mimetype: 'application/pdf', originalname: `${base}.pdf` }]
  }
  const dir = path.join(fixtureDir, base)
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
    return fs
      .readdirSync(dir)
      .filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase()))
      .sort()
      .map((f) => ({ buffer: fs.readFileSync(path.join(dir, f)), mimetype: 'image/jpeg', originalname: f }))
  }
  for (const ext of IMAGE_EXT) {
    const single = path.join(fixtureDir, `${base}${ext}`)
    if (fs.existsSync(single)) {
      return [{ buffer: fs.readFileSync(single), mimetype: 'image/jpeg', originalname: `${base}${ext}` }]
    }
  }
  throw new Error(`fixture ${path.basename(fixtureDir)}: no ${base}.pdf / ${base}/ / ${base}.<img>`)
}

async function rasterizeAll(files) {
  const perFile = await Promise.all(files.map((f) => rasterize(f)))
  // renumber pages sequentially across files
  let page = 0
  return perFile.flat().map((p) => ({ ...p, page: ++page }))
}

function abs(n) {
  return Math.abs(n)
}

async function runFixture(name) {
  const dir = path.join(FIXTURES_DIR, name)
  const expected = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8'))

  const [questionPages, answerPages] = await Promise.all([
    rasterizeAll(loadInput(dir, 'questions')),
    rasterizeAll(loadInput(dir, 'answers')),
  ])

  const questions = await extractQuestions(questionPages)
  const { mappings } = await extractAndMapAnswers(questions, answerPages)
  const { grades } = await gradeAnswers(questions, mappings, answerPages)

  const gradeById = new Map(grades.map((g) => [g.questionId, g]))
  const mappingById = new Map(mappings.map((m) => [m.questionId, m]))
  const ourByLabel = new Map(questions.map((q) => [labelToId(q.displayNumber), q]))
  const expectedByLabel = new Map(expected.questions.map((e) => [labelToId(e.displayNumber), e]))

  // question recall / precision
  const expectedLabels = new Set(expectedByLabel.keys())
  const ourLabels = new Set(ourByLabel.keys())
  const hit = [...expectedLabels].filter((l) => ourLabels.has(l)).length
  const questionRecall = expectedLabels.size ? hit / expectedLabels.size : 1
  const questionPrecision = ourLabels.size ? hit / ourLabels.size : 1

  let mappingHit = 0
  let mappingTotal = 0
  let scoreAbsErr = 0
  let scored = 0
  let within1 = 0
  let verdictMatch = 0
  let ourTotal = 0
  let teacherTotal = 0

  for (const [label, e] of expectedByLabel) {
    const q = ourByLabel.get(label)
    teacherTotal += e.expectedScore ?? 0
    if (!q) continue
    const g = gradeById.get(q.id)
    const m = mappingById.get(q.id)

    if (e.answered) {
      mappingTotal++
      if (m?.status === 'answered') mappingHit++
    }
    if (g) {
      scored++
      const err = abs((g.score ?? 0) - (e.expectedScore ?? 0))
      scoreAbsErr += err
      if (err <= 1) within1++
      if (g.verdict === e.expectedVerdict) verdictMatch++
      ourTotal += g.score ?? 0
    }
  }

  const paperTotal = expected.paperTotal ?? teacherTotal ?? 0
  return {
    name,
    questionRecall,
    questionPrecision,
    mappingRecall: mappingTotal ? mappingHit / mappingTotal : 1,
    scoreMAE: scored ? scoreAbsErr / scored : 0,
    within1Rate: scored ? within1 / scored : 1,
    verdictAgreement: scored ? verdictMatch / scored : 1,
    totalScoreError: abs(ourTotal - teacherTotal),
    totalScoreErrorPct: paperTotal ? abs(ourTotal - teacherTotal) / paperTotal : 0,
    ourTotal,
    teacherTotal,
    counts: { questions: questions.length, expected: expected.questions.length },
  }
}

function pct(n) {
  return `${(n * 100).toFixed(1)}%`
}

function printRow(r) {
  console.log(
    [
      r.name.padEnd(20),
      `qRecall ${pct(r.questionRecall)}`,
      `qPrec ${pct(r.questionPrecision)}`,
      `mapRecall ${pct(r.mappingRecall)}`,
      `MAE ${r.scoreMAE.toFixed(2)}`,
      `within1 ${pct(r.within1Rate)}`,
      `verdict ${pct(r.verdictAgreement)}`,
      `totalErr ${r.totalScoreError} (${pct(r.totalScoreErrorPct)})  [${r.ourTotal} vs ${r.teacherTotal}]`,
    ].join('  |  '),
  )
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY is not set — add it to Backend/.env')
    process.exit(2)
  }
  if (!fs.existsSync(FIXTURES_DIR)) {
    console.error(`No fixtures at ${FIXTURES_DIR} — see eval/README.md`)
    process.exit(2)
  }

  const only = process.argv[2]
  const names = fs
    .readdirSync(FIXTURES_DIR)
    .filter((n) => fs.statSync(path.join(FIXTURES_DIR, n)).isDirectory())
    .filter((n) => !only || n === only)

  if (!names.length) {
    console.error(only ? `No fixture named "${only}"` : 'No fixtures found — see eval/README.md')
    process.exit(2)
  }

  const results = []
  for (const name of names) {
    process.stdout.write(`running ${name} … `)
    try {
      const r = await runFixture(name)
      console.log('done')
      results.push(r)
    } catch (err) {
      console.log(`FAILED: ${err.message}`)
    }
  }

  console.log('\n=== per fixture ===')
  results.forEach(printRow)

  if (results.length) {
    const avg = (k) => results.reduce((s, r) => s + r[k], 0) / results.length
    const aggWithin1 = avg('within1Rate')
    console.log('\n=== aggregate ===')
    printRow({
      name: 'AVG',
      questionRecall: avg('questionRecall'),
      questionPrecision: avg('questionPrecision'),
      mappingRecall: avg('mappingRecall'),
      scoreMAE: avg('scoreMAE'),
      within1Rate: aggWithin1,
      verdictAgreement: avg('verdictAgreement'),
      totalScoreError: avg('totalScoreError'),
      totalScoreErrorPct: avg('totalScoreErrorPct'),
      ourTotal: results.reduce((s, r) => s + r.ourTotal, 0),
      teacherTotal: results.reduce((s, r) => s + r.teacherTotal, 0),
    })

    if (aggWithin1 < MIN_WITHIN_1) {
      console.error(`\nFAIL: aggregate within-1-mark rate ${pct(aggWithin1)} < ${pct(MIN_WITHIN_1)}`)
      process.exit(1)
    }
    console.log(`\nPASS: aggregate within-1-mark rate ${pct(aggWithin1)} >= ${pct(MIN_WITHIN_1)}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
