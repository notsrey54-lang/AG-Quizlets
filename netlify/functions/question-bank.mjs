const BANK_KEY = 'question-bank-v1';
const MAX_QUESTIONS = 10000;
const MAX_PROMPT_LENGTH = 700;
const MAX_ANSWER_LENGTH = 900;
const MAX_TOPIC_LENGTH = 40;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store, max-age=0',
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
}

function text(value, fallback, maxLength) {
  const result = String(value ?? '').trim();
  return (result || fallback).slice(0, maxLength);
}

function validId(value) {
  const id = String(value ?? '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(id) ? id : null;
}

function validTimestamp(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function normaliseFields(value) {
  const prompt = text(value && value.prompt, '', MAX_PROMPT_LENGTH);
  const answer = text(value && value.answer, '', MAX_ANSWER_LENGTH);
  if (!prompt || !answer) throw new HttpError(400, 'Question and answer are required.');
  return {
    prompt,
    answer,
    topic: text(value && value.topic, 'AG Knowledge', MAX_TOPIC_LENGTH),
    status: value && value.status === 'draft' ? 'draft' : 'published'
  };
}

function normaliseQuestion(value, now) {
  try {
    const fields = normaliseFields(value);
    return {
      id: validId(value && value.id) || crypto.randomUUID(),
      ...fields,
      createdAt: validTimestamp(value && value.createdAt, now),
      updatedAt: validTimestamp(value && value.updatedAt, now)
    };
  } catch {
    return null;
  }
}

function normaliseQuestions(values) {
  if (!Array.isArray(values)) throw new HttpError(400, 'Questions must be an array.');
  if (values.length > MAX_QUESTIONS) throw new HttpError(413, 'Too many questions.');
  const now = Date.now();
  const ids = new Set();
  const questions = [];
  for (const value of values) {
    const question = normaliseQuestion(value, now);
    if (!question || ids.has(question.id)) continue;
    ids.add(question.id);
    questions.push(question);
  }
  return questions;
}

function normaliseBank(value) {
  const questions = Array.isArray(value && value.questions) ? normaliseQuestions(value.questions) : [];
  return {
    version: 1,
    updatedAt: validTimestamp(value && value.updatedAt, 0),
    questions
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createQuestionHandler(store) {
  async function readBank() {
    const entry = await store.getWithMetadata(BANK_KEY, { type: 'json', consistency: 'strong' });
    if (entry === null) return { entry: null, bank: null };
    return { entry, bank: normaliseBank(entry.data) };
  }

  async function commit(change) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await readBank();
      const next = change(clone(current.bank || { version: 1, updatedAt: 0, questions: [] }));
      next.version = 1;
      next.updatedAt = Date.now();
      const result = await store.setJSON(BANK_KEY, next, current.entry ? { onlyIfMatch: current.entry.etag } : { onlyIfNew: true });
      if (result.modified) return { bank: next, etag: result.etag };
    }
    throw new HttpError(409, 'Another change was saved at the same time. Please retry.');
  }

  async function bootstrap(values) {
    const questions = normaliseQuestions(values);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await readBank();
      if (current.bank !== null) return { bank: current.bank, etag: current.entry.etag };
      const bank = { version: 1, updatedAt: Date.now(), questions };
      const result = await store.setJSON(BANK_KEY, bank, { onlyIfNew: true });
      if (result.modified) return { bank, etag: result.etag };
    }
    throw new HttpError(409, 'Could not initialise the shared question bank. Please retry.');
  }

  return async function questionHandler(request) {
    try {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
      if (request.method === 'GET') {
        const { entry, bank } = await readBank();
        return json({ exists: bank !== null, bank, etag: entry ? entry.etag : null });
      }
      if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

      let payload;
      try { payload = await request.json(); } catch { throw new HttpError(400, 'Request body must be JSON.'); }
      const action = String(payload && payload.action || '');
      let saved;

      if (action === 'bootstrap') {
        saved = await bootstrap(payload.questions);
      } else if (action === 'add') {
        const fields = normaliseFields(payload.question);
        saved = await commit(function(current) {
          if (current.questions.length >= MAX_QUESTIONS) throw new HttpError(413, 'Question limit reached.');
          const now = Date.now();
          current.questions.unshift({ id: crypto.randomUUID(), ...fields, createdAt: now, updatedAt: now });
          return current;
        });
      } else if (action === 'update') {
        const id = validId(payload.question && payload.question.id);
        if (!id) throw new HttpError(400, 'Question ID is invalid.');
        const fields = normaliseFields(payload.question);
        saved = await commit(function(current) {
          const index = current.questions.findIndex(function(question) { return question.id === id; });
          if (index < 0) throw new HttpError(404, 'Question not found.');
          current.questions[index] = { ...current.questions[index], ...fields, updatedAt: Date.now() };
          return current;
        });
      } else if (action === 'delete') {
        const id = validId(payload.id);
        if (!id) throw new HttpError(400, 'Question ID is invalid.');
        saved = await commit(function(current) {
          const nextQuestions = current.questions.filter(function(question) { return question.id !== id; });
          if (nextQuestions.length === current.questions.length) throw new HttpError(404, 'Question not found.');
          current.questions = nextQuestions;
          return current;
        });
      } else if (action === 'replace') {
        const questions = normaliseQuestions(payload.questions);
        saved = await commit(function() { return { version: 1, updatedAt: 0, questions }; });
      } else {
        throw new HttpError(400, 'Unknown action.');
      }

      return json({ exists: true, bank: saved.bank, etag: saved.etag });
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error('Question bank error', error);
      return json({ error: 'Unable to update the shared question bank.' }, 500);
    }
  };
}
