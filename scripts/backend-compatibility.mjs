import { readFileSync, writeFileSync } from 'node:fs'
import { KNOWN_BACKEND_KINDS, backendSupportRange } from '../src/backend-compatibility.ts'

const labels = {
  'kiro-v2': 'Kiro ACP V2', 'kiro-v3': 'Kiro ACP V3',
  codex: 'Codex app-server', agy: 'Google Antigravity CLI (`agy acp`)',
}
const file = new URL('../docs/backend-compatibility.md', import.meta.url)
const begin = '<!-- compatibility:begin -->'
const end = '<!-- compatibility:end -->'
const source = readFileSync(file, 'utf8')
const startAt = source.indexOf(begin)
const endAt = source.indexOf(end)
if (startAt < 0 || endAt <= startAt) throw new Error('Missing compatibility table markers')
const table = [begin,
  '| 后端 | 稳定正式版范围（含边界） |', '| --- | --- |',
  ...KNOWN_BACKEND_KINDS.map(kind => `| ${labels[kind]} | ${backendSupportRange(kind).split(' || ').map(range => `\`${range}\``).join(' 或 ')} |`),
  end,
].join('\n')
const rendered = source.slice(0, startAt) + table + source.slice(endAt + end.length)
if (process.argv.includes('--write')) writeFileSync(file, rendered)
else if (source !== rendered) {
  console.error('兼容表未同步。运行 pnpm docs:compatibility 更新。')
  process.exitCode = 1
}
