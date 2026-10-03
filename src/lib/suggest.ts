/**
 * Fuzzy command discovery. Two surfaces:
 *
 * 1. `crm suggest <words>` — the user describes what they want (English or
 *    Chinese) and gets the matching commands ranked.
 * 2. Cross-tree "you probably meant" hints on unknown-command errors.
 *
 * The index is built from the live commander tree, so new commands are
 * searchable the moment they are registered.
 */
import type { Command } from 'commander'

interface IndexEntry {
  description: string
  path: string
  tokens: string[]
}

/**
 * Chinese → English concept aliases. Substring match against the raw
 * query: `删除客户` yields tokens [rm, delete, contact]. Keep entries
 * short and unambiguous; each maps to command vocabulary.
 */
export const CJK_ALIASES: Record<string, string[]> = {
  客户: ['contact'],
  联系人: ['contact'],
  公司: ['company'],
  企业: ['company'],
  商机: ['deal'],
  订单: ['deal'],
  成交: ['deal'],
  活动: ['activity'],
  记录: ['log'],
  报表: ['report'],
  报告: ['report'],
  漏斗: ['pipeline'],
  管道: ['pipeline'],
  导入: ['import'],
  导出: ['export'],
  删除: ['rm', 'delete'],
  添加: ['add'],
  新建: ['add'],
  查看: ['show'],
  显示: ['show'],
  修改: ['edit'],
  编辑: ['edit'],
  登录: ['login'],
  退出: ['logout'],
  备份: ['backup'],
  恢复: ['restore'],
  审计: ['audit'],
  标签: ['tag'],
  搜索: ['search', 'find'],
  查找: ['search', 'find'],
  重复: ['dupes'],
  去重: ['dupes'],
  合并: ['merge'],
  预测: ['forecast'],
  转化: ['conversion'],
  赢单: ['won'],
  输单: ['lost'],
  丢单: ['lost'],
  用户: ['user'],
  推进: ['move'],
  阶段: ['stage'],
  服务器: ['serve'],
  补全: ['completion'],
  周期: ['velocity'],
  停滞: ['stale'],
  陈旧: ['stale'],
  任务: ['task'],
  帮助: ['help'],
}

/** Build the searchable index from the live command tree. */
export function buildCommandIndex(program: Command): IndexEntry[] {
  const entries: IndexEntry[] = []
  const walk = (cmd: Command, path: string[]): void => {
    for (const sub of cmd.commands) {
      if (sub.name() === 'help' || sub.name() === 'suggest') {
        continue
      }
      const p = [...path, sub.name()]
      const tokens = new Set<string>([
        ...p,
        ...sub
          .description()
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((w) => w.length >= 3),
        ...sub.options
          .flatMap((o) => (typeof o.long === 'string' ? [o.long] : []))
          .map((l) => l.replace(/^--/, ''))
          .filter((l) => l.length >= 3),
      ])
      entries.push({
        path: p.join(' '),
        tokens: [...tokens],
        description: sub.description(),
      })
      if (sub.commands.length > 0) {
        walk(sub, p)
      }
    }
  }
  walk(program, [])
  return entries
}

/** Subcommand paths (space separated) whose options include `flag`. */
export function commandsWithFlag(program: Command, flag: string): string[] {
  const out: string[] = []
  const walk = (cmd: Command, path: string[]): void => {
    for (const sub of cmd.commands) {
      const p = [...path, sub.name()]
      if (sub.options.some((o) => o.long === flag)) {
        out.push(p.join(' '))
        continue
      }
      if (sub.commands.length > 0) {
        walk(sub, p)
      }
    }
  }
  walk(program, [])
  return out
}

function levenshteinCapped(a: string, b: string, cap = 2): number {
  if (Math.abs(a.length - b.length) > cap) {
    return cap + 1
  }
  const prev = new Array(b.length + 1).fill(0).map((_v, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      diag = tmp
    }
    if (Math.min(...prev) > cap) {
      return cap + 1
    }
  }
  return prev[b.length]
}

/**
 * Score one query token against one candidate token.
 * exact=3, prefix=2 (both sides ≥3 chars — 'reportt' ~ 'report' but not
 * 'port'), edit-distance 1 = 1.6 (≥3), 2 = 1 (≥5). Exported for the REPL's
 * fuzzy open, which layers a containment rule on top of this.
 */
export function scoreToken(q: string, t: string): number {
  if (t === q) {
    return 3
  }
  let s = 0
  if (t.length >= 3 && q.length >= 3 && (t.startsWith(q) || q.startsWith(t))) {
    s = 2
  }
  if (s === 0 && q.length >= 3 && t.length >= 3) {
    const d = levenshteinCapped(q, t)
    const acceptable =
      (d === 1 && Math.min(q.length, t.length) >= 3) ||
      (d === 2 && Math.min(q.length, t.length) >= 5)
    if (acceptable) {
      s = d === 1 ? 1.6 : 1
    }
  }
  return s
}

/**
 * Rank items by the summed best score over their tokens — one point per
 * query token, best matching candidate token wins it. `score` is swappable
 * so callers can extend the notion of "similar" without forking the loop;
 * ties keep input order (sort is stable).
 */
export function rankCandidates<T>(
  queryTokens: string[],
  items: T[],
  getTokens: (item: T) => string[],
  opts: { score?: (q: string, t: string) => number; top?: number } = {},
): { item: T; score: number }[] {
  const score = opts.score ?? scoreToken
  const scored = items.map((item) => {
    let total = 0
    for (const q of queryTokens) {
      let best = 0
      for (const t of getTokens(item)) {
        const s = score(q, t)
        if (s > best) {
          best = s
        }
      }
      total += best
    }
    return { item, score: total }
  })
  return scored
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.top ?? 8)
}

/**
 * Rank commands against a free-text query. Returns paths most-relevant
 * first (empty when nothing scored).
 */
export function suggestCommands(
  program: Command,
  query: string,
  top = 5,
): { path: string; description: string }[] {
  const raw = query.toLowerCase().trim()
  if (!raw) {
    return []
  }
  const tokens = [...raw.split(/\s+/).filter((t) => t.length > 0)]
  // Chinese substrings map to command vocabulary
  for (const [zh, en] of Object.entries(CJK_ALIASES)) {
    if (raw.includes(zh)) {
      tokens.push(...en)
    }
  }
  // Pre-sort by path length so the stable rank ties resolve shorter-path-
  // first, exactly as the original bespoke comparator did.
  const index = buildCommandIndex(program).sort(
    (a, b) => a.path.length - b.path.length,
  )
  return rankCandidates(tokens, index, (entry) => entry.tokens, { top }).map(
    (r) => ({
      path: r.item.path,
      description: r.item.description,
    }),
  )
}
