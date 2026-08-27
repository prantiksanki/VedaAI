import OpenAI from 'openai'

let client = null

export function getOpenAIClient() {
  if (!client) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is not set. Copy .env.example to .env and add your key.')
    }
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  }
  return client
}

// Text-only now that OCR (not the LLM) reads the pages - gpt-4o-mini is fast and cheap for this reasoning step.
export const TEXT_MODEL = 'gpt-4o-mini'

/**
 * Calls the model with a JSON-schema-constrained response so we get
 * predictable structured output instead of parsing free text.
 */
export async function callStructured({ systemPrompt, userContent, schemaName, schema }) {
  const openai = getOpenAIClient()

  const response = await openai.chat.completions.create({
    model: TEXT_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: schemaName,
        schema,
        strict: true,
      },
    },
  })

  const raw = response.choices[0]?.message?.content
  if (!raw) throw new Error('Empty response from model')
  return JSON.parse(raw)
}
