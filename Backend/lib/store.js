const jobs = new Map()

export function createJob(id) {
  const job = { id, status: 'processing', step: 'uploading', error: null, result: null, createdAt: Date.now() }
  jobs.set(id, job)
  return job
}

export function getJob(id) {
  return jobs.get(id) ?? null
}

export function updateJob(id, patch) {
  const job = jobs.get(id)
  if (!job) return null
  Object.assign(job, patch)
  return job
}

// Periodically evict jobs older than 1 hour since this is in-memory only.
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff) jobs.delete(id)
  }
}, 10 * 60 * 1000).unref()
