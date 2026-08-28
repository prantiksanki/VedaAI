import OpenAI from 'openai'

let client = null

export function getClient() {
  if (!client) {
    if (!process.env.OPENROUTER_API_KEY) {
      throw new Error(
        'OPENROUTER_API_KEY is not set. Copy .env.example to .env and add your OpenRouter key.',
      )
    }
    client = new OpenAI({
      baseURL: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
      apiKey: process.env.OPENROUTER_API_KEY,
      defaultHeaders: {
        'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'https://vedaai.local',
        'X-Title': 'VedaAI',
      },
      // The three pipeline stages fan out many calls; give each generous headroom.
      timeout: 120_000,
      maxRetries: 0, // we do our own retry with backoff below
    })
  }
  return client
}

export const MODEL = process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-5'

const MAX_ATTEMPTS = 3

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Build a user-message content array from text and images.
 * @param {string} text
 * @param {string[]} [imageDataUrls] - "data:image/jpeg;base64,..." strings
 */
export function userContent(text, imageDataUrls = []) {
  const parts = imageDataUrls.map((url) => ({ type: 'image_url', image_url: { url } }))
  parts.push({ type: 'text', text })
  return parts
}

/**
 * One structured (JSON-schema-constrained) vision call.
 *
 * @param {{
 *   system: string,
 *   content: Array|string,   // OpenAI-style user content (text + image_url parts)
 *   schemaName: string,
 *   schema: object,          // JSON schema; must be strict-mode compatible
 *   stage?: string,          // for error messages
 *   maxTokens?: number,
 * }} args
 * @returns {Promise<object>} parsed JSON matching `schema`
 */
export async function callStructured({ system, content, schemaName, schema, stage = 'llm', maxTokens = 16000 }) {
  const openai = getClient()
  let lastErr

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await openai.chat.completions.create({
        model: MODEL,
        temperature: 0,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: schemaName, schema, strict: true },
        },
      })

      const choice = response.choices?.[0]
      if (!choice) throw new Error(`${stage}: empty response from model`)
      if (choice.finish_reason === 'length') {
        throw new Error(`${stage}: response was truncated (raise maxTokens or split the input)`)
      }
      const raw = choice.message?.content
      if (!raw) throw new Error(`${stage}: model returned no content (finish_reason=${choice.finish_reason})`)

      try {
        return JSON.parse(raw)
      } catch {
        throw new Error(`${stage}: model output was not valid JSON`)
      }
    } catch (err) {
      lastErr = err
      const status = err?.status ?? err?.response?.status
      const retryable = status === 429 || (status >= 500 && status < 600) || err?.name === 'APIConnectionError'
      if (!retryable || attempt === MAX_ATTEMPTS) break
      await sleep(500 * 2 ** (attempt - 1)) // 0.5s, 1s
    }
  }

  throw new Error(`${stage} failed: ${lastErr?.message || lastErr}`)
}
