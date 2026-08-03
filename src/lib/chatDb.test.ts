import { describe, it, expect } from 'vitest';
import { createUserWithOrganization } from './db';
import { createChatSession, getChatSession, listChatSessions, saveChatMessage, deleteChatSession } from './chatDb';

describe('Chat DB Sessions & Messages Persistence', () => {
  it('creates, retrieves, updates and deletes chat sessions', async () => {
    const email = `chat-user-${Date.now()}@example.com`;
    const orgId = await createUserWithOrganization(email, 'Chat User', 'test-hash', { emailVerified: true });
    // 1. Create session
    const session = await createChatSession(orgId, email, 'Ciro Analizi', 'dataset');
    expect(session.id).toBeDefined();
    expect(session.title).toBe('Ciro Analizi');
    expect(session.mode).toBe('dataset');

    // 2. Save messages
    const userMsg = await saveChatMessage(orgId, email, session.id, 'user', 'Gelecek ay ciromuz ne olur?');
    expect(userMsg.id).toBeDefined();
    expect(userMsg.role).toBe('user');

    const assistantMsg = await saveChatMessage(orgId, email, session.id, 'assistant', 'Tahminlerimize göre ciroda %15 artış bekleniyor.');
    expect(assistantMsg.role).toBe('assistant');

    // 3. Get Session
    const fetched = await getChatSession(orgId, email, session.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.messages.length).toBe(2);
    expect(fetched?.messages[0].content).toBe('Gelecek ay ciromuz ne olur?');
    expect(fetched?.messages[1].content).toBe('Tahminlerimize göre ciroda %15 artış bekleniyor.');

    // 4. List Sessions
    const allSessions = await listChatSessions(orgId, email);
    expect(allSessions.some(s => s.id === session.id)).toBe(true);

    // 5. Delete Session
    const deleted = await deleteChatSession(orgId, email, session.id);
    expect(deleted).toBe(true);

    const postDelete = await getChatSession(orgId, email, session.id);
    expect(postDelete).toBeNull();
  });
});
