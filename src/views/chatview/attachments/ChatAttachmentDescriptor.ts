import type { ChatAttachmentContentRef, ChatAttachmentMetadata } from '../../../types';
import { isRecord } from '../../../utils/jsonRecord';

export const CHAT_ATTACHMENT_REF_SCHEMA = 'systemsculpt-chat-attachment-v1' as const;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const DESCRIPTOR_KEYS = ['id', 'name', 'mimeType', 'byteLength', 'kind'];
type AttachmentDescriptor = Pick<ChatAttachmentMetadata, 'id' | 'name' | 'mimeType' | 'byteLength' | 'kind'>;
export type PersistedReadyAttachment = Readonly<AttachmentDescriptor & { contentRef: ChatAttachmentContentRef }>;

/** Common descriptor fields; each persistence boundary declares its additional keys. */
export function isChatAttachmentDescriptor(value: unknown, additionalKeys: readonly string[]): value is AttachmentDescriptor & Record<string, unknown> {
  return isRecord(value)
    && Object.keys(value).every(key => DESCRIPTOR_KEYS.includes(key) || additionalKeys.includes(key))
    && typeof value.id === 'string' && !!value.id.trim()
    && typeof value.name === 'string' && !!value.name.trim()
    && typeof value.mimeType === 'string' && !!value.mimeType.trim()
    && Number.isSafeInteger(value.byteLength) && (value.byteLength as number) >= 0
    && (value.kind === 'document' || value.kind === 'image' || value.kind === 'text');
}

export function isChatAttachmentContentRef(value: unknown): value is ChatAttachmentContentRef {
  return isRecord(value)
    && Object.keys(value).every(key => ['schema', 'payload', 'sha256', 'byteLength'].includes(key))
    && value.schema === CHAT_ATTACHMENT_REF_SCHEMA
    && (value.payload === 'image-bytes' || value.payload === 'utf8-content-part')
    && typeof value.sha256 === 'string' && SHA256_HEX.test(value.sha256)
    && Number.isSafeInteger(value.byteLength) && (value.byteLength as number) >= 0;
}

function isDescriptorRef(kind: AttachmentDescriptor['kind'], ref: unknown): ref is ChatAttachmentContentRef {
  return isChatAttachmentContentRef(ref)
    && (kind === 'image' ? ref.payload === 'image-bytes' : ref.payload === 'utf8-content-part');
}

export function isPersistedReadyAttachment(value: unknown): value is PersistedReadyAttachment {
  return isChatAttachmentDescriptor(value, ['contentRef']) && isDescriptorRef(value.kind, value.contentRef);
}

export function isChatAttachmentMetadata(value: unknown): value is ChatAttachmentMetadata {
  return isChatAttachmentDescriptor(value, ['contentPartIndex', 'contentRef'])
    && Number.isSafeInteger(value.contentPartIndex) && (value.contentPartIndex as number) >= 0
    && (value.contentRef === undefined || isDescriptorRef(value.kind, value.contentRef));
}

export function chatAttachmentRefKey(ref: ChatAttachmentContentRef): string {
  return `${ref.payload}:${ref.sha256}`;
}
