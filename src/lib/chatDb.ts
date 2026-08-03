import { database } from './database';
import { databaseReady } from './db';
import crypto from 'node:crypto';

export interface ChatSessionRecord {
  id: string;
  organizationId: string;
  email: string;
  title: string;
  mode: 'dataset' | 'rag';
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessageRecord {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

async function ready(): Promise<void> {
  await databaseReady;
}

export async function listChatSessions(
  organizationId: string,
  email: string
): Promise<ChatSessionRecord[]> {
  await ready();
  return database.tenantTransaction(organizationId, async (tx) => {
    const rows = await tx.all<{
      id: string;
      organization_id: string;
      email: string;
      title: string;
      mode: string;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, organization_id, email, title, mode, created_at, updated_at
       FROM chat_sessions
       WHERE organization_id = ? AND email = ?
       ORDER BY updated_at DESC
       LIMIT 100`,
      [organizationId, email]
    );

    return rows.map((row) => ({
      id: row.id,
      organizationId: row.organization_id,
      email: row.email,
      title: row.title,
      mode: (row.mode as 'dataset' | 'rag') || 'dataset',
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  });
}

export async function getChatSession(
  organizationId: string,
  email: string,
  sessionId: string
): Promise<{ session: ChatSessionRecord; messages: ChatMessageRecord[] } | null> {
  await ready();
  return database.tenantTransaction(organizationId, async (tx) => {
    const sessionRow = await tx.get<{
      id: string;
      organization_id: string;
      email: string;
      title: string;
      mode: string;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, organization_id, email, title, mode, created_at, updated_at
       FROM chat_sessions
       WHERE id = ? AND organization_id = ? AND email = ?`,
      [sessionId, organizationId, email]
    );

    if (!sessionRow) return null;

    const messageRows = await tx.all<{
      id: string;
      session_id: string;
      role: string;
      content: string;
      created_at: string;
    }>(
      `SELECT id, session_id, role, content, created_at
       FROM chat_messages
       WHERE session_id = ?
       ORDER BY created_at ASC`,
      [sessionId]
    );

    return {
      session: {
        id: sessionRow.id,
        organizationId: sessionRow.organization_id,
        email: sessionRow.email,
        title: sessionRow.title,
        mode: (sessionRow.mode as 'dataset' | 'rag') || 'dataset',
        createdAt: sessionRow.created_at,
        updatedAt: sessionRow.updated_at
      },
      messages: messageRows.map((msg) => ({
        id: msg.id,
        sessionId: msg.session_id,
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
        createdAt: msg.created_at
      }))
    };
  });
}

export async function createChatSession(
  organizationId: string,
  email: string,
  title?: string,
  mode: 'dataset' | 'rag' = 'dataset'
): Promise<ChatSessionRecord> {
  await ready();
  const id = `chat_session_${crypto.randomUUID()}`;
  const sessionTitle = (title && title.trim()) ? title.trim().slice(0, 100) : 'Yeni Sohbet';
  const now = new Date().toISOString();

  return database.tenantTransaction(organizationId, async (tx) => {
    await tx.run(
      `INSERT INTO chat_sessions (id, organization_id, email, title, mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, organizationId, email, sessionTitle, mode, now, now]
    );

    return {
      id,
      organizationId,
      email,
      title: sessionTitle,
      mode,
      createdAt: now,
      updatedAt: now
    };
  });
}

export async function saveChatMessage(
  organizationId: string,
  email: string,
  sessionId: string,
  role: 'user' | 'assistant',
  content: string
): Promise<ChatMessageRecord> {
  await ready();
  const msgId = `chat_msg_${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  return database.tenantTransaction(organizationId, async (tx) => {
    let session = await tx.get<{ title: string }>(
      'SELECT title FROM chat_sessions WHERE id = ? AND organization_id = ? AND email = ?',
      [sessionId, organizationId, email]
    );

    if (!session) {
      await tx.run(
        `INSERT INTO chat_sessions (id, organization_id, email, title, mode, created_at, updated_at)
         VALUES (?, ?, ?, 'Yeni Sohbet', 'dataset', ?, ?)`,
        [sessionId, organizationId, email, now, now]
      );
      session = { title: 'Yeni Sohbet' };
    }

    await tx.run(
      `INSERT INTO chat_messages (id, session_id, organization_id, email, role, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [msgId, sessionId, organizationId, email, role, content, now]
    );

    let newTitle = session.title;
    if (role === 'user' && (session.title === 'Yeni Sohbet' || !session.title)) {
      newTitle = content.trim().slice(0, 45) || 'Sohbet';
    }

    await tx.run(
      `UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?`,
      [newTitle, now, sessionId]
    );

    return {
      id: msgId,
      sessionId,
      role,
      content,
      createdAt: now
    };
  });
}

export async function deleteChatSession(
  organizationId: string,
  email: string,
  sessionId: string
): Promise<boolean> {
  await ready();
  return database.tenantTransaction(organizationId, async (tx) => {
    const res = await tx.run(
      `DELETE FROM chat_sessions WHERE id = ? AND organization_id = ? AND email = ?`,
      [sessionId, organizationId, email]
    );
    const deleted = res.changes > 0;
    if (deleted) {
      await tx.run(`DELETE FROM chat_messages WHERE session_id = ?`, [sessionId]);
    }
    return deleted;
  });
}
