const WINSTON_API_URL = 'https://api.gowinston.ai/v2/ai-content-detection'

/**
 * Runs Winston AI's content-detection check on a block of text.
 * https://docs.gowinston.ai/api-reference/v2/ai-content-detection/post
 *
 * @param {string} text - 300 to 150,000 characters.
 * @returns {Promise<{
 *   score: number,                              // 0-100, higher = more likely human-written
 *   sentences: Array<{ text: string, score: number }>,
 *   readability_score: number,
 *   credits_used: number,
 *   credits_remaining: number,
 *   language: string,
 *   version: string,
 * }>}
 */
export async function detectAiContent(text) {
  const key = process.env.WISTON_AI
  if (!key) {
    throw new Error('WISTON_AI is not set. Add your Winston AI key to .env (see .env.example).')
  }

  let response
  try {
    response = await fetch(WINSTON_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ text, sentences: true }),
    })
  } catch {
    throw new Error('Could not reach Winston AI. Check your network connection and try again.')
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(body.description || body.error || `Winston AI error (${response.status})`)
  }

  return response.json()
}
