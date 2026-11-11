/** 数据目录切换前必须等待正在使用数据库的异步操作完成。 */
const active = new Map<string, number>()
export function beginWork(name: string): () => void {
  active.set(name, (active.get(name) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const count = (active.get(name) ?? 1) - 1
    if (count) active.set(name, count)
    else active.delete(name)
  }
}
export function assertIdle(): void {
  if (active.size) throw new Error(`请先结束正在进行的${[...active.keys()].join('、')}，再迁移数据`)
}
export async function withWork<T>(name: string, run: () => Promise<T>): Promise<T> {
  const release = beginWork(name)
  try { return await run() } finally { release() }
}
