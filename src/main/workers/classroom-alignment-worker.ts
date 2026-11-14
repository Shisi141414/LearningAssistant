import { parentPort } from 'node:worker_threads'
import {
  ClassroomMatcher,
  type AlignmentBlock
} from '@shared/classroom-alignment'

let matcher: ClassroomMatcher | null = null
parentPort!.on(
  'message',
  (input: { blocks?: AlignmentBlock[]; text: string; ordinal: number }) => {
    try {
      if (input.blocks) matcher = new ClassroomMatcher(input.blocks)
      if (!matcher) throw new Error('尚未建立教材索引')
      parentPort!.postMessage({
        result: matcher.match(input.text, input.ordinal)
      })
    } catch (error) {
      parentPort!.postMessage({
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
)
