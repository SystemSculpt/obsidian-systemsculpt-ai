import { isPathInKnownChatsDirectory, recordedChatsDirectories, resolveKnownChatsDirectories } from '../storage/ChatTranscriptLocations';

describe('saved transcript locations', () => {
  const settings = { chatsDirectory: 'Current/Chats/', knownChatsDirectories: ['Original/Chats//'] };
  it('recognizes current, default and recorded folders on path boundaries', () => {
    expect(resolveKnownChatsDirectories(settings)).toEqual(['Current/Chats', 'SystemSculpt/Chats', 'Original/Chats']);
    for (const path of ['Current/Chats/x.md', 'SystemSculpt/Chats/x.md', 'Original/Chats/sub/x.md']) {
      expect(isPathInKnownChatsDirectory(path, settings)).toBe(true);
    }
    for (const path of ['Original/Chats-old/x.md', 'Current/Chatsx.md', 'Other/x.md']) {
      expect(isPathInKnownChatsDirectory(path, settings)).toBe(false);
    }
  });
  it('does not mistake the current unrecorded folder for an already recorded folder', () => {
    expect(recordedChatsDirectories(settings)).toEqual(['SystemSculpt/Chats', 'Original/Chats']);
    expect(isPathInKnownChatsDirectory('Original/Chats/x.md', { ...settings, chatsDirectory: 'Next/Chats' })).toBe(true);
  });
});
