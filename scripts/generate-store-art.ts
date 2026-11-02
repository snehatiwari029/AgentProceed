// BUILD-TIME ONLY: generates the Agent activity map's storefront artwork with Muse Image (muse-image-1.0) through the
// Meta Model API, once. The chosen file is committed as a static asset; the dashboard never calls an image model.
//
// Status: NOT RUN YET. The Muse Image endpoint and response shape are not verified from Meta's docs in this repo, so
// the URL is not hard-coded: pass it in MUSE_IMAGE_URL after checking the docs. Pricing is not assumed either; confirm
// it against the project's Meta Model API pricing before running.
//
//   Set MODEL_API_KEY and MUSE_IMAGE_URL in the shell environment (never in a file), then:
//   npx tsx scripts/generate-store-art.ts
//
// Writes up to 3 candidates to public/store-art/ plus manifest.json (prompt, model, file, time). Pick the one that reads
// clearest at dashboard size, then set STORE_ART in src/dashboard/pages/AgentActivity.tsx to its path and record the
// choice in manifest.json. If the call fails, nothing is written: do not substitute any other image.
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const MODEL = 'muse-image-1.0'
export const CANDIDATES = 3
export const PROMPT = [
  'Clean isometric illustration of a small retail store interior, seen from above at an angle.',
  'Muted, low-contrast palette of deep navy, slate and soft teal that sits on a dark dashboard background.',
  'Four clearly separated zones arranged as a 2 by 2 grid: top left the entrance and browse aisles,',
  'top right product display stands, bottom left a cart area, bottom right a checkout counter with a short queue lane.',
  'Flat, minimal, simple shapes. No people, no figures, no text, no letters, no numbers, no signage, no logos.',
].join(' ')

async function main() {
  const key = process.env.MODEL_API_KEY?.trim()
  const url = process.env.MUSE_IMAGE_URL?.trim()
  if (!key) throw new Error('MODEL_API_KEY is not set. Stop: Muse Image is unavailable, no artwork generated.')
  if (!url) throw new Error('MUSE_IMAGE_URL is not set. Check the Meta Model API docs for the Muse Image endpoint first.')
  const out = join(process.cwd(), 'public', 'store-art')
  await mkdir(out, { recursive: true })
  const files: { file: string; created_at: string }[] = []
  for (let i = 1; i <= CANDIDATES; i++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, prompt: PROMPT }),
    })
    if (!res.ok) throw new Error(`Muse Image returned ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const json = (await res.json()) as { data?: { b64_json?: string; url?: string }[] }
    const item = json.data?.[0]
    let bytes: Buffer
    if (item?.b64_json) bytes = Buffer.from(item.b64_json, 'base64')
    else if (item?.url) bytes = Buffer.from(await (await fetch(item.url)).arrayBuffer())
    else throw new Error('Muse Image response had no image (unverified response shape; check the docs).')
    const file = `candidate-${i}.png`
    await writeFile(join(out, file), bytes)
    files.push({ file: `store-art/${file}`, created_at: new Date().toISOString() })
  }
  await writeFile(
    join(out, 'manifest.json'),
    JSON.stringify({ model: MODEL, endpoint: url, prompt: PROMPT, candidates: files, chosen: null }, null, 2) + '\n',
  )
  console.log(`Wrote ${files.length} candidates to public/store-art/. Choose one and set "chosen" in manifest.json.`)
}

if (process.argv[1]?.endsWith('generate-store-art.ts')) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
