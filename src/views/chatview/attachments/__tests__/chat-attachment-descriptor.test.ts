import { isChatAttachmentDescriptor, isChatAttachmentContentRef, isChatAttachmentMetadata, isPersistedReadyAttachment } from '../ChatAttachmentDescriptor';

const descriptor = { id: 'attachment-1', name: 'note.md', mimeType: 'text/markdown', byteLength: 5, kind: 'document' };
const contentRef = { schema: 'systemsculpt-chat-attachment-v1', payload: 'utf8-content-part', sha256: 'a'.repeat(64), byteLength: 5 };

describe('chat attachment descriptor contract', () => {
  it('layers runtime, transcript and durable descriptor shapes over common fields', () => {
    expect(isChatAttachmentDescriptor({ ...descriptor, status: 'ready' }, ['status'])).toBe(true);
    expect(isChatAttachmentMetadata({ ...descriptor, contentPartIndex: 0 })).toBe(true);
    expect(isChatAttachmentMetadata({ ...descriptor, contentPartIndex: 0, contentRef })).toBe(true);
    expect(isPersistedReadyAttachment({ ...descriptor, contentRef })).toBe(true);
    expect(isPersistedReadyAttachment(descriptor)).toBe(false);
    expect(isPersistedReadyAttachment({ ...descriptor, contentRef, contentPartIndex: 0 })).toBe(false);
  });

  it.each([
    { id: '' }, { name: ' ' }, { mimeType: '' }, { byteLength: -1 },
    { byteLength: 1.5 }, { byteLength: Number.MAX_SAFE_INTEGER + 1 }, { kind: 'unknown' }, { unexpected: true },
  ])('rejects invalid common fields across transcript and durable boundaries: %j', patch => {
    expect(isChatAttachmentMetadata({ ...descriptor, contentPartIndex: 0, contentRef, ...patch })).toBe(false);
    expect(isPersistedReadyAttachment({ ...descriptor, contentRef, ...patch })).toBe(false);
  });

  it('rejects forged references and mismatched kind/payload at both persisted boundaries', () => {
    expect(isChatAttachmentContentRef({ ...contentRef, sha256: '../escape' })).toBe(false);
    expect(isChatAttachmentContentRef({ ...contentRef, extra: true })).toBe(false);
    expect(isChatAttachmentMetadata({ ...descriptor, kind: 'image', contentPartIndex: 0, contentRef })).toBe(false);
    expect(isPersistedReadyAttachment({ ...descriptor, kind: 'image', contentRef })).toBe(false);
    expect(isChatAttachmentMetadata({ ...descriptor, contentPartIndex: -1 })).toBe(false);
  });
});
