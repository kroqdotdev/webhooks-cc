const STORAGE_KEY = "request_notes";
const MAX_NOTE_LENGTH = 280;
const MAX_NOTES = 500;

interface NotesMap {
  [requestId: string]: string;
}

function loadAll(): NotesMap {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return {};
    return JSON.parse(stored) as NotesMap;
  } catch {
    return {};
  }
}

function saveAll(notes: NotesMap): void {
  try {
    // Evict oldest entries if exceeding cap
    const keys = Object.keys(notes);
    if (keys.length > MAX_NOTES) {
      const toRemove = keys.slice(0, keys.length - MAX_NOTES);
      for (const k of toRemove) delete notes[k];
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
  } catch {
    // localStorage unavailable
  }
}

export function getNote(requestId: string): string | null {
  const notes = loadAll();
  return notes[requestId] ?? null;
}

export function setNote(requestId: string, note: string): void {
  const notes = loadAll();
  const trimmed = note.trim().slice(0, MAX_NOTE_LENGTH);
  if (trimmed) {
    notes[requestId] = trimmed;
  } else {
    delete notes[requestId];
  }
  saveAll(notes);
}

export function deleteNote(requestId: string): void {
  const notes = loadAll();
  delete notes[requestId];
  saveAll(notes);
}

export function hasNote(requestId: string): boolean {
  return getNote(requestId) !== null;
}

export function getAllNotes(): NotesMap {
  return loadAll();
}

export { MAX_NOTE_LENGTH };
