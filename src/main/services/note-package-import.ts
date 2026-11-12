import type { NotePackage, NotePackageImportResult, NotePackagePreview } from '@shared/note-package'
import type { DecodedDocumentArchive } from './learning-package-codec'
import { createPackageImportController } from './document-package-import-job'
import { installNotePackage } from './note-package-import-store'
const controller = createPackageImportController<DecodedDocumentArchive<NotePackage>, NotePackagePreview, NotePackageImportResult>({
  read: 'note-read',
  summary: ({ manifest, sha256 }, ticket) => ({ ticket, title: manifest.document.title, subject_name: manifest.document.subject_name,
    sources: manifest.sources.length, entries: manifest.state.entries.length, annotations: manifest.annotations.length, concepts: manifest.concepts.length, evidence: manifest.evidence.length,
    unmatched_annotations: manifest.annotations.filter(item => !item.matches_revision).length, unmatched_evidence: manifest.evidence.filter(item => !item.matches_revision).length,
    external_materials: Object.values(manifest.origins).filter(origin => origin.material_ref).length, sha256 }),
  install: (decoded, input, _verify, aborted) => installNotePackage(decoded, input.subject_id, input.include_concepts, aborted)
})
export const previewNotePackage = controller.preview
export const confirmNotePackage = controller.confirm
export const cancelNotePackageImport = controller.cancel
export const stopNotePackageImports = controller.stop
