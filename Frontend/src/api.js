const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:4000'

export async function uploadFiles(questionPaper, answerSheet) {
  const formData = new FormData()
  formData.append('questionPaper', questionPaper)
  formData.append('answerSheet', answerSheet)

  const res = await fetch(`${API_BASE}/api/upload`, { method: 'POST', body: formData })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `Upload failed (${res.status})`)
  }
  return res.json() // { jobId }
}

/**
 * Sends the question-paper text to the backend, which runs Winston AI content
 * detection and returns a PDF report as a Blob.
 */
export async function requestPlagiarismReport(text) {
  const res = await fetch(`${API_BASE}/api/plagiarism-report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `Report failed (${res.status})`)
  }
  return res.blob()
}

export async function getJob(jobId) {
  const res = await fetch(`${API_BASE}/api/jobs/${jobId}`)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `Failed to fetch job (${res.status})`)
  }
  return res.json()
}

/**
 * Sends the graded result to the backend and gets back the "checked copy"
 * PDF (grading summary + annotated answer-sheet pages) as a Blob.
 */
export async function requestCheckedCopy(result) {
  const res = await fetch(`${API_BASE}/api/checked-copy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ result }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `Checked copy failed (${res.status})`)
  }
  return res.blob()
}

export const PROCESSING_STEPS = [
  { key: 'uploading', label: 'Uploading files' },
  { key: 'rasterizing', label: 'Preparing page images' },
  { key: 'extracting_questions', label: 'Reading the question paper' },
  { key: 'mapping_answers', label: 'Reading the answer sheet' },
  { key: 'grading', label: 'Marking answers' },
  { key: 'complete', label: 'Done' },
]

const STEP_LABELS = Object.fromEntries(PROCESSING_STEPS.map((s) => [s.key, s.label]))

export function stepLabel(step) {
  return STEP_LABELS[step] || 'Processing…'
}

/**
 * Polls a job until it's done or errored, calling onUpdate on every poll.
 */
export async function pollJob(jobId, onUpdate, intervalMs = 1500) {
  while (true) {
    const job = await getJob(jobId)
    onUpdate(job)
    if (job.status === 'done' || job.status === 'error') return job
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}
