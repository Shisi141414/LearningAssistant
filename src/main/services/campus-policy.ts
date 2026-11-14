import { createHash } from 'node:crypto'
import type { CampusSource } from '@shared/campus'

export const campusLoginUrl =
  'https://id.tsinghua.edu.cn/do/off/ui/auth/login/form/bb5df85216504820be7bba2b0ae1535b/0'
export const campusHome =
  'https://learn.tsinghua.edu.cn/f/wlxt/index/course/student/'
export function officialCampusUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      !u.port &&
      (u.hostname === 'tsinghua.edu.cn' ||
        u.hostname.endsWith('.tsinghua.edu.cn'))
    )
  } catch {
    return false
  }
}
// Only the reviewed student READ endpoints. Several upstream list reads use POST.
export function campusReadUrl(value: string, method = 'GET'): boolean {
  try {
    const u = new URL(value)
    if (
      u.origin !== 'https://learn.tsinghua.edu.cn' ||
      u.username ||
      u.password
    )
      return false
    if (method === 'GET')
      return (
        u.pathname === '/f/wlxt/index/course/student/' ||
        u.pathname === '/b/kc/zhjw_v_code_xnxq/getCurrentAndNextSemester' ||
        /^\/b\/wlxt\/kc\/v_wlkc_xs_xkb_kcb_extend\/student\/loadCourseBySemesterId\/[^/]+\/[^/]+$/.test(
          u.pathname
        )
      )
    return (
      method === 'POST' &&
      /^\/b\/wlxt\/kczy\/zy\/student\/(zyListWj|zyListYjwg|zyListYpg|yxzylist)$/.test(
        u.pathname
      )
    )
  } catch {
    return false
  }
}
export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
// The official form is transient. Extract only i_user; never retain the password/body.
export function campusAccount(bytes: Buffer): string | null {
  if (bytes.length > 65536) return null
  let body: string
  try {
    body = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
  let values: string[]
  if (body.startsWith('--')) {
    const boundary = body.slice(0, body.indexOf('\r\n'))
    if (boundary.length < 3 || boundary.length > 200) return null
    values = body
      .split(boundary)
      .filter((p) =>
        /content-disposition:[^\r\n]*name="i_user"(?:;|\r\n)/i.test(p)
      )
      .map((p) => p.slice(p.indexOf('\r\n\r\n') + 4).replace(/\r\n$/, ''))
  } else values = new URLSearchParams(body).getAll('i_user')
  if (values.length !== 1) return null
  const name = values[0].trim()
  if (!name || name.length > 256 || /[\u0000-\u001f\u007f]/.test(name))
    return null
  return digest(['thu-official-username-v1', name])
}
function text(v: unknown, max: number): string {
  if (
    typeof v !== 'string' ||
    !v.trim() ||
    v.length > max ||
    /[\u0000]/.test(v)
  )
    throw Error('学校返回了无效作业信息')
  return v
}
export function normalizeCampusSource(
  account_id: string,
  semester: string,
  course_id: string,
  course_title: string,
  raw: unknown
): CampusSource {
  if (!raw || typeof raw !== 'object') throw Error('学校返回了无效作业信息')
  const h = raw as Record<string, unknown>
  const deadline = text(h.deadline, 100)
  // An explicit offset prevents the same source changing meaning on a different computer.
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      deadline
    )
  )
    throw Error('学校作业的截止时间无法识别')
  const due_at = Date.parse(deadline)
  if (!Number.isSafeInteger(due_at) || due_at < 0 || due_at > 253402300799999)
    throw Error('学校作业的截止时间无法识别')
  const local = deadline.slice(0, 19)
  if (new Date(local + 'Z').toISOString().slice(0, 19) !== local)
    throw Error('学校作业的截止时间无法识别')
  const id = text(h.id, 128),
    base_id = text(h.baseId, 128)
  if (typeof h.submitted !== 'boolean')
    throw Error('学校作业的提交状态无法识别')
  // Reconstruct the canonical official link; discard remote query strings/tokens.
  const url = `https://learn.tsinghua.edu.cn/f/wlxt/kczy/zy/student/viewCj?wlkcid=${encodeURIComponent(course_id)}&xszyid=${encodeURIComponent(id)}`
  return {
    account_id,
    semester,
    course_id,
    course_title,
    id,
    base_id,
    title: text(h.title, 500).trim(),
    deadline,
    due_at,
    submitted: h.submitted,
    url
  }
}
