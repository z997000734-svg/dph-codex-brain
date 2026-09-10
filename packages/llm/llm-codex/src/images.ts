/** Resolve durable Harness images into bounded files for one Codex CLI request. */
import { LlmError, contentHasImage, offloadedImageText, offloadRequestImagesWithPolicy } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { AttachmentId, AttachmentStore, ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'

export const CODEX_REQUEST_IMAGE_PIXEL_BUDGET = 2048 * 2048
export const CODEX_REQUEST_IMAGE_MAX_BYTES = 1024 * 1024
export const CODEX_MAX_IMAGES_PER_REQUEST = 20
export const CODEX_MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024

/** A request projection plus the unique images attached to the CLI in index order. */
export interface PreparedCodexRequest {
  options: GenerateOptions
  images: readonly RequestImageAttachment[]
}

function collectImageRefs(
  options: GenerateOptions,
  refs: Map<AttachmentId, ImageAttachmentRef>,
): void {
  const visit = (blocks: GenerateOptions['messages'][number]['content']): void => {
    for (const block of blocks) {
      if (block.type === 'image') refs.set(block.attachment.attachmentId, block.attachment)
      else if (block.type === 'tool-result') visit(block.content)
    }
  }
  for (const message of options.messages) {
    if (message.role !== 'user' && contentHasImage(message.content)) {
      throw new LlmError(`Codex CLI cannot represent image content in a ${message.role} message.`, 'UNSUPPORTED_CONTENT')
    }
    visit(message.content)
  }
}

/** Prepare normalized request images without exposing attachment storage paths.
 * @param options - complete Harness request history.
 * @param attachments - mounted durable attachment provider.
 * @returns projected messages and image bytes in CLI attachment order.
 */
export async function prepareCodexRequest(
  options: GenerateOptions,
  attachments: AttachmentStore | undefined,
): Promise<PreparedCodexRequest> {
  const hasImages = options.messages.some(message => contentHasImage(message.content))
  if (!hasImages) return { options, images: [] }
  if (attachments === undefined) {
    throw new LlmError('Codex image conversion requires the durable attachment service.', 'UNSUPPORTED_CONTENT')
  }
  const messages = offloadRequestImagesWithPolicy(options.messages, {
    representation: 'raw',
    maxImages: CODEX_MAX_IMAGES_PER_REQUEST,
    maxBytes: CODEX_MAX_REQUEST_IMAGE_BYTES,
    countQuantum: 1,
    byteQuantum: 1,
    byteLength: ref => Math.min(ref.bytes, CODEX_REQUEST_IMAGE_MAX_BYTES),
    placeholder: ref => offloadedImageText(ref),
  })
  const projected = messages === options.messages ? options : { ...options, messages: [...messages] }
  const refs = new Map<AttachmentId, ImageAttachmentRef>()
  collectImageRefs(projected, refs)
  const images = await Promise.all([...refs.values()].map(ref => attachments.readImageRequest(ref, {
    maxPixels: CODEX_REQUEST_IMAGE_PIXEL_BUDGET,
    maxBytes: CODEX_REQUEST_IMAGE_MAX_BYTES,
  }, options.signal)))
  return { options: projected, images }
}
