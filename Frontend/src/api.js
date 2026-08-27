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

export async function getJob(jobId) {
  const res = await fetch(`${API_BASE}/api/jobs/${jobId}`)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `Failed to fetch job (${res.status})`)
  }
  return res.json()
}

export const PROCESSING_STEPS = [
  { key: 'uploading', label: 'Uploading files' },
  { key: 'running_ocr', label: 'Reading pages with OCR' },
  { key: 'extracting_questions', label: 'Extracting questions from paper' },
  { key: 'mapping_answers', label: 'Reading handwriting & mapping answers' },
  { key: 'grading', label: 'Grading answers' },
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
