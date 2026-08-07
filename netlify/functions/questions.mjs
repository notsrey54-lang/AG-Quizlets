import { getStore } from '@netlify/blobs';
import { createQuestionHandler } from './question-bank.mjs';

export default async function questions(request) {
  const store = getStore({ name: 'ag-quizlet-question-bank', consistency: 'strong' });
  return createQuestionHandler(store)(request);
}

export const config = { path: '/api/questions' };
