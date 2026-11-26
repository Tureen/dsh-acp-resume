/**
 * Release pipeline for dsh-acp-resume, as code instead of a script retyped per release.
 *
 * One subcommand per gate; each prints what it checked and exits non-zero on the
 * first failure. Nothing here retries a red run, moves a tag, or publishes on its
 * own: the steps that cannot be undone (`tag`) refuse to run unless the CI run on
 * the exact full commit sha is `success`.
 *
 *   node scripts/release.mjs preflight   token scope, clean tree, version, hard constraints
 *   node scripts/release.mjs ci           wait for the `ci` run on HEAD; print failing tests
 *   node scripts/release.mjs skipped      run the suite CI skips (needs the official checkout)
 *   node scripts/release.mjs tag <ver>    tag HEAD only when CI is green on that exact sha
 *   node scripts/release.mjs npm <ver>    wait for release; confirm version and tarball separately
 *   node scripts/release.mjs verify <ver> unpack the tarball and check markers for this release
 *   node scripts/release.mjs index <ver>  wait until repo and live index both show <ver>
 *   node scripts/release.mjs token        report the token's repository permissions
 *
 * RELEASE_MARKERS / RELEASE_ABSENT are JSON maps { "lib/x.js": "text" } the tarball must / must not
 * contain, set per release on the command line. The GitHub token is read from GITHUB_TOKEN (never
 * written anywhere). The official
 * checkout for `skipped` is DSH_OFFICIAL_CHECKOUT, defaulting like the test suite.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const REGISTRY = 'https://registry.npmjs.org'
const INDEX = 'https://tureen.github.io/dsh-acp-resume/index.json'
const REPO = 'Tureen/dsh-acp-resume'
const SKIPPED_SUITE = 'tests/subagent-acp.spec.ts'
const LOAD_CEILING = 20

const [command, arg] = process.argv.slice(2)
const token = process.env.GITHUB_TOKEN ?? ''
const say = (message) => console.log(message)
const fail = (message) => { console.error(`✗ ${message}`); process.exit(1) }
const step = (label) => say(`\n== ${label}`)

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

async function github(path) {
  if (token === '') fail('GITHUB_TOKEN is not set')
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      })
      if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
        const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000
        const wait = Math.max(reset - Date.now(), 30_000)
        say(`  rate limited; sleeping ${Math.round(wait / 1000)}s`)
        await new Promise((resolve) => setTimeout(resolve, wait))
        continue
      }
      return response
    } catch (error) {
      if (attempt >= 5) throw error
      say(`  network error (${error.message}); retry ${attempt}/4`)
      await new Promise((resolve) => setTimeout(resolve, 5000))
    }
  }
}

async function githubJson(path) {
  const response = await github(path)
  if (!response.ok) fail(`GitHub ${path} → HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`)
  return response.json()
}

async function jobLog(runId, jobName) {
  const jobs = (await githubJson(`/actions/runs/${runId}/jobs`)).jobs
  const job = jobs.find((row) => row.name === jobName) ?? jobs[0]
  if (job === undefined) return ''
  const response = await fetch(`https://api.github.com/repos/${REPO}/actions/jobs/${job.id}/logs`, { headers: { Authorization: `Bearer ${token}` } })
  return response.ok ? (await response.text()).replace(/\x1b\[[0-9;]*m/g, '') : ''
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll until `read` returns a completed value; print a line per poll. */
async function waitFor(label, read, { minutes = 25, everyMs = 60_000 } = {}) {
  const deadline = Date.now() + minutes * 60_000
  for (;;) {
    const value = await read()
    say(`  [${new Date().toTimeString().slice(0, 8)}] ${value ?? 'in progress'}`)
    if (value !== undefined && value !== null) return value
    if (Date.now() > deadline) fail(`${label}: gave up after ${minutes} minutes`)
    await sleep(everyMs)
  }
}

const load1 = () => Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[0]) || Number(execFileSync('uptime', [], { encoding: 'utf8' }).match(/load averages?: ([\d.]+)/)?.[1] ?? 0)

function assertLoad() {
  if (process.platform === 'win32') return
  const load = load1()
  if (load > LOAD_CEILING) fail(`load average ${load} is above ${LOAD_CEILING}; wait for the machine to settle`)
  say(`  load ${load}`)
}

function pkg() { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) }

const commands = {
  async token() {
    step('token scope')
    const userResponse = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${token}` } })
    const user = userResponse.ok ? await userResponse.json() : null
    if (user) say(`  login    ${user.login ?? '(n/a)'}`)
    const repo = await githubJson('')
    say(`  repo     ${JSON.stringify(repo.permissions ?? {})}`)
    for (const scope of ['push', 'pull']) {
      if (repo.permissions?.[scope] !== true) fail(`token lacks "${scope}" on ${REPO}`)
    }
    const probe = await fetch(`https://api.github.com/repos/${REPO}/actions/runs?per_page=1`, { headers: { Authorization: `Bearer ${token}` } })
    if (!probe.ok) fail(`token cannot read Actions (HTTP ${probe.status}); rerun and CI polling need it`)
    say('  actions  readable')
  },

  async preflight() {
    step('preflight')
    const dirty = git('status', '--porcelain').split('\n').filter((line) => line !== '' && !line.startsWith('?? .agents/'))
    if (dirty.length > 0) fail(`uncommitted changes:\n    ${dirty.join('\n    ')}`)
    say('  working tree clean')
    const version = pkg().version
    if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`package.json version is not a plain semver: ${version}`)
    const published = await (await fetch(`${REGISTRY}/dsh-acp-resume`)).json().catch(() => ({}))
    if (published.versions?.[version] !== undefined) fail(`version ${version} is already on npm`)
    say(`  version ${version} not yet published (latest ${published['dist-tags']?.latest ?? '?'})`)
    if (git('rev-list', '--count', `v${published['dist-tags']?.latest ?? 'v0.0.0'}..HEAD`) === '0') fail('no commits since the last release')
    execFileSync('git', ['fetch', 'origin', '--quiet'])
    if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) {
      const behind = Number(git('rev-list', '--count', 'HEAD..origin/main'))
      const ahead = Number(git('rev-list', '--count', 'origin/main..HEAD'))
      say(`  local is ahead ${ahead}, behind ${behind}`)
      if (behind > 0) fail('remote main has commits you do not have; `git pull --rebase origin main` first')
      say('  local ahead only: push is a fast-forward')
    } else say('  HEAD is origin/main')
    const since = git('diff', '--name-only', 'v0.4.0..HEAD')
    if (since.split('\n').includes('src/run.ts')) fail('src/run.ts changed since v0.4.0 (D11: byte-identical baseline)')
    say('  src/run.ts untouched since v0.4.0')
    const deps = Object.keys(pkg().dependencies ?? {})
    if (deps.length !== 5 && process.env.RELEASE_ALLOW_DEP_CHANGE !== '1') fail(`production dependencies went from 5 to ${deps.length}; set RELEASE_ALLOW_DEP_CHANGE=1 only if that is intended`)
    say(`  production dependencies: ${deps.join(', ')}`)
    for (const file of ['cordis.patch.yml', '.github/workflows/release.yml']) {
      if (!existsSync(new URL(`../${file}`, import.meta.url))) fail(`missing ${file}`)
    }
    say('  release workflow present')
  },

  async ci() {
    step('ci')
    const sha = git('rev-parse', 'HEAD')
    if (git('rev-parse', 'origin/main') !== sha) fail('HEAD is not pushed; push first')
    const run = await waitFor('ci run to appear', async () => {
      const runs = (await githubJson(`/actions/runs?head_sha=${sha}&per_page=20`)).workflow_runs
      return runs.find((row) => row.name === 'ci')?.id
    }, { minutes: 5, everyMs: 10_000 })
    const conclusion = await waitFor('ci', async () => {
      const row = await githubJson(`/actions/runs/${run}`)
      return row.status === 'completed' ? row.conclusion : undefined
    })
    const log = await jobLog(run, 'test')
    for (const line of log.split('\n')) if (/\s(Test Files|Tests|Duration)\s/.test(line)) say(`  ${line.replace(/^\S+\s+/, '')}`)
    if (conclusion !== 'success') {
      say('  failing tests:')
      for (const line of new Set(log.split('\n').filter((row) => /^\S+\s+(FAIL|×)|AssertionError|Test timed out/.test(row)).map((row) => row.replace(/^\S+\s+/, '')))) say(`    ${line}`)
      fail(`ci is ${conclusion}; fix or decide — this tool never re-runs a red run`)
    }
    say(`  ci run ${run} success on ${sha}`)
  },

  async skipped() {
    step('skipped suite (CI has no official checkout)')
    const checkout = process.env.DSH_OFFICIAL_CHECKOUT ?? join(homedir(), 'Developer/open-source-projects/deepseek-harness')
    if (!existsSync(join(checkout, 'packages/subprocess/subprocess-local/src/spawn.ts'))) fail(`official checkout not found at ${checkout}`)
    say(`  checkout ${checkout}`)
    assertLoad()
    const vitest = new URL('../node_modules/.bin/vitest', import.meta.url).pathname
    let out = ''
    try { out = execFileSync(vitest, ['run', SKIPPED_SUITE], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
    catch (error) { out = `${error.stdout ?? ''}${error.stderr ?? ''}` }
    for (const line of out.split('\n')) if (/\s(Test Files|Tests|Duration)\s/.test(line)) say(`  ${line.replace(/^\s+/, '')}`)
    if (!/\bTests\s+\d+ passed/.test(out) || /skipped/.test(out) || /×|FAIL/.test(out)) {
      fail(`${SKIPPED_SUITE} did not pass cleanly (must be N passed and nothing skipped)`)
    }
    say(`  ${SKIPPED_SUITE} passed with nothing skipped`)
  },

  async tag(version) {
    step('tag')
    if (version === undefined || !/^\d+\.\d+\.\d+$/.test(version)) fail('usage: node scripts/release.mjs tag <version>')
    if (pkg().version !== version) fail(`package.json is ${pkg().version}, asked to tag ${version}`)
    const sha = git('rev-parse', 'HEAD')
    if (git('rev-parse', 'origin/main') !== sha) fail('HEAD is not pushed')
    if (git('tag', '-l', `v${version}`) !== '') fail(`tag v${version} already exists locally`)
    if (git('ls-remote', '--tags', 'origin', `v${version}`) !== '') fail(`tag v${version} already exists on the remote`)
    const runs = (await githubJson(`/actions/runs?head_sha=${sha}&per_page=20`)).workflow_runs
    const ci = runs.find((row) => row.name === 'ci')
    // Compare the full sha the API returns with the full local sha; a short sha never matches.
    if (ci === undefined || ci.conclusion !== 'success' || ci.head_sha !== sha) {
      fail(`no green ci run on exactly ${sha}; refusing to tag`)
    }
    say(`  ci run ${ci.id} is success on the full sha`)
    execFileSync('git', ['tag', '-a', `v${version}`, '-m', `Release v${version}`, sha])
    execFileSync('git', ['push', 'origin', `v${version}`], { stdio: 'inherit' })
    say(`  pushed v${version} → ${sha.slice(0, 7)}`)
  },

  async npm(version) {
    step('npm')
    if (version === undefined) fail('usage: node scripts/release.mjs npm <version>')
    const tarball = `${REGISTRY}/dsh-acp-resume/-/dsh-acp-resume-${version}.tgz`
    const run = await waitFor('release run', async () => {
      const runs = (await githubJson(`/actions/workflows/release.yml/runs?per_page=5`)).workflow_runs
      return runs.find((row) => row.head_branch === `v${version}`)?.id
    }, { minutes: 5, everyMs: 10_000 })
    const conclusion = await waitFor('release', async () => {
      const row = await githubJson(`/actions/runs/${run}`)
      return row.status === 'completed' ? row.conclusion : undefined
    })
    say(`  release run ${run}: ${conclusion}`)
    const log = await jobLog(run, 'publish')
    for (const line of log.split('\n')) if (/\s(Tests|Test Files)\s/.test(line)) say(`  ${line.replace(/^\S+\s+/, '')}`)
    if (conclusion !== 'success') fail('release did not succeed; inspect the run before retrying')
    const published = async () => {
      const meta = await (await fetch(`${REGISTRY}/dsh-acp-resume`)).json().catch(() => ({}))
      return meta.versions?.[version] !== undefined ? meta['dist-tags']?.latest : undefined
    }
    const latest = await waitFor('npm version to appear', published, { minutes: 10, everyMs: 20_000 })
    say(`  npm version ${version} present; latest = ${latest}`)
    const status = async () => {
      const head = await fetch(tarball, { method: 'HEAD' })
      return head.status === 200 ? 200 : undefined
    }
    await waitFor('tarball to download', status, { minutes: 30 })
    say('  tarball HTTP 200')
  },

  async verify(version) {
    step('verify tarball contents')
    if (version === undefined) fail('usage: node scripts/release.mjs verify <version>')
    const dir = mkdtempSync(join(tmpdir(), 'acp-resume-verify-'))
    try {
      const tarball = join(dir, 'p.tgz')
      const body = await fetch(`${REGISTRY}/dsh-acp-resume/-/dsh-acp-resume-${version}.tgz`)
      if (!body.ok) fail(`tarball HTTP ${body.status}`)
      execFileSync('tar', ['-xzf', '-', '-C', dir], { input: Buffer.from(await body.arrayBuffer()) })
      const root = join(dir, 'package')
      const packed = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
      if (packed.version !== version) fail(`tarball is version ${packed.version}`)
      say(`  version ${packed.version}`)
      const files = readdirSync(join(root, 'lib'))
      for (const name of ['index.js', 'client.js', 'dispatcher-preset.js', 'tools.js', 'pool.js', 'panel.js']) {
        if (!files.includes(name)) fail(`lib/${name} missing from the tarball`)
      }
      say(`  lib: ${files.length} modules`)
      const skillFiles = readdirSync(join(root, 'skills', 'acp-resume-docs'), { recursive: true }).filter((name) => /\.\w+$/.test(name))
      say(`  skills/acp-resume-docs: ${skillFiles.length} files`)
      if (skillFiles.length < 9) fail('skill files missing from the tarball')
      const markers = JSON.parse(process.env.RELEASE_MARKERS ?? '{}')
      for (const [file, needle] of Object.entries(markers)) {
        const text = readFileSync(join(root, file), 'utf8')
        if (!text.includes(needle)) fail(`${file} does not contain ${JSON.stringify(needle)}`)
        say(`  ${file} contains ${JSON.stringify(needle)}`)
      }
      if (Object.keys(markers).length === 0) say('  (RELEASE_MARKERS unset: no per-release markers checked)')
      const absent = JSON.parse(process.env.RELEASE_ABSENT ?? '{}')
      for (const [file, needle] of Object.entries(absent)) {
        const text = readFileSync(join(root, file), 'utf8')
        if (text.includes(needle)) fail(`${file} still contains ${JSON.stringify(needle)}; this release was supposed to remove it`)
        say(`  ${file} no longer contains ${JSON.stringify(needle)}`)
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  },

  async index(version) {
    step('index')
    if (version === undefined) fail('usage: node scripts/release.mjs index <version>')
    const live = async () => {
      const data = await (await fetch(`${INDEX}?nc=${Math.random()}`, { headers: { 'Cache-Control': 'no-cache' } })).json().catch(() => null)
      return data?.plugins?.[0]?.versions?.[0]?.version
    }
    await waitFor(`live index to show ${version}`, async () => (await live()) === version ? version : undefined, { minutes: 10, everyMs: 25_000 })
    execFileSync('git', ['fetch', 'origin', '--quiet'])
    const committed = JSON.parse(execFileSync('git', ['show', 'origin/main:docs/index.json'], { encoding: 'utf8' }))
    const top = committed.plugins?.[0]?.versions?.[0]?.version
    if (top !== version) fail(`repo docs/index.json shows ${top}, not ${version}`)
    say(`  repo index ${version}`)
    const mirror = await (await fetch('https://registry.npmmirror.com/dsh-acp-resume')).json().catch(() => ({}))
    say(`  npmmirror latest ${mirror['dist-tags']?.latest ?? 'unknown'} (informational; may lag)`)
    execFileSync('git', ['pull', '--rebase', 'origin', 'main'], { stdio: 'inherit' })
  },
}

if (!Object.hasOwn(commands, command)) {
  say('usage: node scripts/release.mjs <token|preflight|ci|skipped|tag|npm|verify|index> [version]')
  process.exit(command === undefined ? 0 : 2)
}
await commands[command](arg)
