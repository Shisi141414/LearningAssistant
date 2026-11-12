import type { ParsedBlock } from '@shared/types'
import type { LearningPackageImportResult, LearningPackagePreview } from '@shared/learning-package'
import type { DecodedLearningPackage } from './learning-package-codec'
import { createPackageImportController } from './document-package-import-job'
import { installLearningPackage } from './learning-package-import-store'
const controller = createPackageImportController<DecodedLearningPackage & { blocks: ParsedBlock[] }, LearningPackagePreview, LearningPackageImportResult>({
  read: 'read',
  summary: ({ manifest, sha256 }, ticket) => ({ ticket, title: manifest.document.title, file_name: manifest.original.file_name, format: manifest.original.format, kind: manifest.document.kind, subject_name: manifest.document.subject_name,
    sources: manifest.sources.length, entries: manifest.state.entries.length, assets: manifest.assets.length, concepts: manifest.concepts.length, evidence: manifest.evidence.length, sha256 }),
  install: (decoded, input, verify, aborted) => installLearningPackage(decoded, decoded.blocks, input.subject_id, input.include_concepts, (manifest, files) => verify({ action: 'verify', manifest, files }), aborted)
})
export const previewLearningPackage = controller.preview
export const confirmLearningPackage = controller.confirm
export const cancelLearningPackageImport = controller.cancel
export const stopLearningPackageImports = controller.stop
