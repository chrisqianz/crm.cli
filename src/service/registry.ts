/**
 * RPC method registry: the data surface shared by local mode (direct call)
 * and remote mode (executed inside `crm serve`).
 *
 * minRole is the lowest role allowed to invoke the method:
 *  - reader: read-only
 *  - writer: read + write
 *  - admin/owner: everything (admin.* methods stay in handlers.ts)
 */
import type { CRMConfig } from '../config'
import type { DB } from '../db'
import { activityList, activityLog } from './activity'
import { auditExport, auditList, auditVerify } from './audit'
import {
  companyAdd,
  companyEdit,
  companyList,
  companyMerge,
  companyResolve,
  companyRm,
  companyShow,
} from './company'
import {
  contactAdd,
  contactEdit,
  contactList,
  contactMerge,
  contactResolve,
  contactRm,
  contactShow,
} from './contact'
import {
  dealAdd,
  dealEdit,
  dealList,
  dealMove,
  dealResolve,
  dealRm,
  dealShow,
  pipelineSummary,
} from './deal'
import { findDupes } from './dupes'
import {
  exportAll,
  exportCompanies,
  exportContacts,
  exportDeals,
  importCompanies,
  importContacts,
  importDeals,
} from './importexport'
import {
  reportActivity,
  reportConversion,
  reportForecast,
  reportLost,
  reportPipeline,
  reportStale,
  reportVelocity,
  reportWon,
} from './report'
import { findSemantic, indexRebuild, indexStatus, searchFts } from './search'
import { tagEntity, tagList, untagEntity } from './tag'

export type MethodRole = 'reader' | 'writer' | 'admin'
export type ServiceFn = (
  db: DB,
  config: CRMConfig,
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>>

export interface MethodDef {
  fn: ServiceFn
  minRole: MethodRole
  /** True when the method mutates data (audited server-side). */
  write: boolean
}

const ROLE_RANK: Record<MethodRole, number> = {
  reader: 1,
  writer: 2,
  admin: 3,
}

function effectiveRole(role: string): MethodRole {
  if (role === 'owner' || role === 'admin') {
    return 'admin'
  }
  if (role === 'writer') {
    return 'writer'
  }
  return 'reader'
}

export function roleAllows(minRole: MethodRole, role: string): boolean {
  return ROLE_RANK[minRole] <= ROLE_RANK[effectiveRole(role)]
}

export const METHODS: Record<string, MethodDef> = {
  // ── contact ──
  'contact.add': { minRole: 'writer', write: true, fn: contactAdd },
  'contact.list': { minRole: 'reader', write: false, fn: contactList },
  'contact.show': { minRole: 'reader', write: false, fn: contactShow },
  'contact.edit': { minRole: 'writer', write: true, fn: contactEdit },
  'contact.rm': { minRole: 'writer', write: true, fn: contactRm },
  'contact.merge': { minRole: 'writer', write: true, fn: contactMerge },
  'contact.resolve': { minRole: 'reader', write: false, fn: contactResolve },
  // ── company ──
  'company.add': { minRole: 'writer', write: true, fn: companyAdd },
  'company.list': { minRole: 'reader', write: false, fn: companyList },
  'company.show': { minRole: 'reader', write: false, fn: companyShow },
  'company.edit': { minRole: 'writer', write: true, fn: companyEdit },
  'company.rm': { minRole: 'writer', write: true, fn: companyRm },
  'company.merge': { minRole: 'writer', write: true, fn: companyMerge },
  'company.resolve': { minRole: 'reader', write: false, fn: companyResolve },
  // ── deal ──
  'deal.add': { minRole: 'writer', write: true, fn: dealAdd },
  'deal.list': { minRole: 'reader', write: false, fn: dealList },
  'deal.show': { minRole: 'reader', write: false, fn: dealShow },
  'deal.edit': { minRole: 'writer', write: true, fn: dealEdit },
  'deal.move': { minRole: 'writer', write: true, fn: dealMove },
  'deal.rm': { minRole: 'writer', write: true, fn: dealRm },
  'deal.resolve': { minRole: 'reader', write: false, fn: dealResolve },
  pipeline: { minRole: 'reader', write: false, fn: pipelineSummary },
  // ── activity ──
  'activity.log': { minRole: 'writer', write: true, fn: activityLog },
  'activity.list': { minRole: 'reader', write: false, fn: activityList },
  // ── audit (P4: hash chain; v1 role-level — every role can read) ──
  'audit.list': { minRole: 'reader', write: false, fn: auditList },
  'audit.verify': { minRole: 'reader', write: false, fn: auditVerify },
  'audit.export': { minRole: 'reader', write: false, fn: auditExport },
  // ── search / index ──
  'search.search': { minRole: 'reader', write: false, fn: searchFts },
  'search.find': { minRole: 'reader', write: false, fn: findSemantic },
  'index.status': { minRole: 'reader', write: false, fn: indexStatus },
  'index.rebuild': { minRole: 'writer', write: true, fn: indexRebuild },
  // ── report ──
  'report.pipeline': { minRole: 'reader', write: false, fn: reportPipeline },
  'report.activity': { minRole: 'reader', write: false, fn: reportActivity },
  'report.stale': { minRole: 'reader', write: false, fn: reportStale },
  'report.conversion': {
    minRole: 'reader',
    write: false,
    fn: reportConversion,
  },
  'report.velocity': { minRole: 'reader', write: false, fn: reportVelocity },
  'report.forecast': { minRole: 'reader', write: false, fn: reportForecast },
  'report.won': { minRole: 'reader', write: false, fn: reportWon },
  'report.lost': { minRole: 'reader', write: false, fn: reportLost },
  // ── tag ──
  tag: { minRole: 'writer', write: true, fn: tagEntity },
  untag: { minRole: 'writer', write: true, fn: untagEntity },
  'tag.list': { minRole: 'reader', write: false, fn: tagList },
  // ── dupes ──
  dupes: { minRole: 'reader', write: false, fn: findDupes },
  // ── import / export ──
  'import.contacts': { minRole: 'writer', write: true, fn: importContacts },
  'import.companies': { minRole: 'writer', write: true, fn: importCompanies },
  'import.deals': { minRole: 'writer', write: true, fn: importDeals },
  'export.contacts': { minRole: 'reader', write: false, fn: exportContacts },
  'export.companies': {
    minRole: 'reader',
    write: false,
    fn: exportCompanies,
  },
  'export.deals': { minRole: 'reader', write: false, fn: exportDeals },
  'export.all': { minRole: 'reader', write: false, fn: exportAll },
}
