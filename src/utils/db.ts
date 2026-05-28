import { openDB, type IDBPDatabase, type DBSchema } from 'idb';
import type { CaptureRecord, PendingRecording } from './types';

interface SnapMonkSchema extends DBSchema {
  captures: {
    key: string;
    value: CaptureRecord;
    indexes: { by_timestamp: number };
  };
  recordings: {
    key: string;
    value: PendingRecording;
  };
}

const DB_NAME = 'snapmonk-db';
const DB_VERSION = 2;

let _db: IDBPDatabase<SnapMonkSchema> | null = null;

async function getDB(): Promise<IDBPDatabase<SnapMonkSchema>> {
  if (_db) return _db;
  _db = await openDB<SnapMonkSchema>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        const store = db.createObjectStore('captures', { keyPath: 'id' });
        store.createIndex('by_timestamp', 'metadata.timestamp');
      }
      if (oldVersion < 2) {
        db.createObjectStore('recordings', { keyPath: 'id' });
      }
    },
  });
  return _db;
}

export async function saveCapture(record: CaptureRecord): Promise<void> {
  const db = await getDB();
  await db.put('captures', record);
}

export async function getCapture(id: string): Promise<CaptureRecord | undefined> {
  const db = await getDB();
  return db.get('captures', id);
}

export async function getAllCaptures(): Promise<CaptureRecord[]> {
  const db = await getDB();
  return db.getAllFromIndex('captures', 'by_timestamp');
}

export async function deleteCapture(id: string): Promise<void> {
  const db = await getDB();
  await db.delete('captures', id);
}

export async function clearAllCaptures(): Promise<void> {
  const db = await getDB();
  await db.clear('captures');
}

export function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  return fetch(dataUrl).then((r) => r.blob());
}

export function generateId(): string {
  return crypto.randomUUID();
}

// ─── Pending recording (IndexedDB — no size limit, stores Blob natively) ──────

const PENDING_REC_KEY = 'pending';

export async function savePendingRecording(entry: Omit<PendingRecording, 'id'>): Promise<void> {
  const db = await getDB();
  await db.put('recordings', { ...entry, id: PENDING_REC_KEY });
}

export async function getPendingRecording(): Promise<PendingRecording | undefined> {
  const db = await getDB();
  return db.get('recordings', PENDING_REC_KEY);
}

export async function deletePendingRecording(): Promise<void> {
  const db = await getDB();
  await db.delete('recordings', PENDING_REC_KEY);
}
