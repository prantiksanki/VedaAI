import { useMemo, useRef, useState } from 'react'

const STATUS_META = {
  answered: { label: 'Answered', className: 'status-answered' },
  unanswered: { label: 'Unanswered', className: 'status-unanswered' },
}

const VERDICT_META = {
  correct: { label: 'Correct', className: 'verdict-correct' },
  partially_correct: { label: 'Partial', className: 'verdict-partial' },
  incorrect: { label: 'Incorrect', className: 'verdict-incorrect' },
  unanswered: { label: 'Unanswered', className: 'verdict-unanswered' },
}

function QuestionListItem({ question, isActive, onClick }) {
  const status = STATUS_META[question.status] ?? STATUS_META.unanswered
  const verdict = question.grade ? VERDICT_META[question.grade.verdict] : null
  const maxMarks = question.grade?.effectiveMaxMarks ?? question.maxMarks

  return (
    <button type="button" className={`question-item${isActive ? ' active' : ''}`} onClick={onClick}>
      <div className="question-item-top">
        <span className="question-number">Q{question.displayNumber}</span>
        <span className={`status-pill ${status.className}`}>{status.label}</span>
      </div>
      <p className="question-text">{question.text}</p>
      <div className="question-item-bottom">
        {maxMarks != null && <span className="marks-tag">{maxMarks} marks</span>}
        {verdict && (
          <span className={`verdict-pill ${verdict.className}`}>
            {verdict.label}
            {question.grade.score != null && ` · ${question.grade.score}${maxMarks != null ? `/${maxMarks}` : ''}`}
          </span>
        )}
      </div>
    </button>
  )
}

// Merges regions that form a contiguous block (vertically stacked lines with
// overlapping or near-touching x-ranges) into one bounding box, so a multi-line
// answer draws as a single continuous highlight instead of one box per line.
function mergeAdjacentRegions(regions) {
  if (regions.length <= 1) return regions

  const sorted = [...regions].sort((a, b) => a.y - b.y)
  const groups = []

  for (const region of sorted) {
    const target = groups.find((group) =>
      group.some((member) => {
        const verticalGap = region.y - (member.y + member.height)
        const closeVertically = verticalGap <= Math.max(region.height, member.height) * 0.9
        const horizontallyOverlaps =
          region.x < member.x + member.width && member.x < region.x + region.width
        const bothWide = region.width > 0.5 || member.width > 0.5
        return closeVertically && (horizontallyOverlaps || bothWide)
      })
    )
    if (target) {
      target.push(region)
    } else {
      groups.push([region])
    }
  }

  return groups.map((group) => {
    const x0 = Math.min(...group.map((r) => r.x))
    const y0 = Math.min(...group.map((r) => r.y))
    const x1 = Math.max(...group.map((r) => r.x + r.width))
    const y1 = Math.max(...group.map((r) => r.y + r.height))
    return { page: group[0].page, x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
  })
}

function AnswerSheetViewer({ answerPages, activeRegions }) {
  const containerRefs = useRef({})

  const regionsByPage = useMemo(() => {
    const map = new Map()
    for (const region of activeRegions ?? []) {
      if (!map.has(region.page)) map.set(region.page, [])
      map.get(region.page).push(region)
    }
    for (const [page, regions] of map) {
      map.set(page, mergeAdjacentRegions(regions))
    }
    return map
  }, [activeRegions])

  return (
    <div className="answer-sheet-viewer">
      {answerPages.map((page) => (
        <div
          key={page.page}
          className="answer-page"
          ref={(el) => {
            containerRefs.current[page.page] = el
          }}
        >
          <img src={page.dataUrl} alt={`Answer sheet page ${page.page}`} className="answer-page-image" />
          {(regionsByPage.get(page.page) ?? []).map((region, i) => (
            <div
              key={i}
              className="highlight-box"
              style={{
                left: `${region.x * 100}%`,
                top: `${region.y * 100}%`,
                width: `${region.width * 100}%`,
                height: `${region.height * 100}%`,
              }}
            />
          ))}
          <span className="answer-page-label">Page {page.page}</span>
        </div>
      ))}
    </div>
  )
}

export default function MappingView({ result, onReset }) {
  const [selectedQuestionId, setSelectedQuestionId] = useState(result.questions[0]?.id ?? null)

  const selectedQuestion = result.questions.find((q) => q.id === selectedQuestionId) ?? null

  const activeRegions = selectedQuestion?.regions ?? []

  const answeredCount = result.questions.filter((q) => q.status === 'answered').length

  function selectQuestion(id) {
    setSelectedQuestionId(id)
  }

  return (
    <div className="mapping-view">
      <div className="mapping-header">
        <div>
          <h2>Question &amp; Answer Mapping</h2>
          <p className="mapping-summary">
            {answeredCount} of {result.questions.length} questions answered
          </p>
        </div>
        <button type="button" className="reset-btn" onClick={onReset}>
          Upload New Files
        </button>
      </div>

      {result.overallFeedback && (
        <div className="overall-feedback">
          <strong>Overall Feedback:</strong> {result.overallFeedback}
        </div>
      )}

      <div className="mapping-grid">
        <div className="question-panel">
          {result.questions.map((q) => (
            <QuestionListItem
              key={q.id}
              question={q}
              isActive={selectedQuestionId === q.id}
              onClick={() => selectQuestion(q.id)}
            />
          ))}
        </div>

        <div className="answer-panel">
          {selectedQuestion && (
            <div className="answer-detail">
              <div className="answer-detail-header">
                <span className="question-number">Q{selectedQuestion.displayNumber}</span>
                {selectedQuestion.status === 'unanswered' ? (
                  <span className="status-pill status-unanswered">Not answered on sheet</span>
                ) : (
                  <span className="status-pill status-answered">Answered</span>
                )}
              </div>
              {selectedQuestion.grade?.feedback && (
                <p className="answer-feedback">{selectedQuestion.grade.feedback}</p>
              )}
              {selectedQuestion.answerText && (
                <p className="answer-transcript">&ldquo;{selectedQuestion.answerText}&rdquo;</p>
              )}
            </div>
          )}
          <AnswerSheetViewer answerPages={result.answerPages} activeRegions={activeRegions} />
        </div>
      </div>
    </div>
  )
}
